// Cancel stale resting orders on Kalshi
// Orders older than maxAge minutes get cancelled to free up cash

import crypto from 'crypto';

const BASE_URL = 'https://api.elections.kalshi.com/trade-api/v2';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Kalshi-Key-Id, X-Kalshi-Private-Key');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { maxAgeMinutes = 15, forceAll = false } = req.body;
    const kalshiKeyId = req.headers['x-kalshi-key-id'] || process.env.KALSHI_API_KEY_ID;
    const kalshiPrivateKey = req.headers['x-kalshi-private-key'] || process.env.KALSHI_PRIVATE_KEY;

    if (!kalshiKeyId || !kalshiPrivateKey) {
        return res.status(400).json({ error: 'Kalshi credentials required' });
    }

    const privateKeyPem = decodeKey(kalshiPrivateKey);
    const creds = { apiKeyId: kalshiKeyId, privateKeyPem };

    try {
        // Fetch resting orders
        const ordersData = await authFetch('GET', '/portfolio/orders?status=resting', creds);
        const orders = ordersData.orders || [];

        const now = Date.now();
        const maxAge = maxAgeMinutes * 60 * 1000;
        let cancelled = 0;
        const results = [];

        for (const order of orders) {
            const createdAt = new Date(order.created_time || 0).getTime();
            const age = now - createdAt;
            const ageMin = Math.round(age / 60000);
            const ticker = order.ticker || '';
            const orderPrice = parseFloat(order.yes_price_dollars || order.no_price_dollars || '0') * 100;
            const side = (order.side || 'yes').toLowerCase();
            const action = (order.action || 'buy').toLowerCase();

            // Force-cancel mode: cancel ALL resting orders unconditionally (used before exits to free cash)
            if (forceAll) {
                try {
                    await authFetch('DELETE', `/portfolio/orders/${order.order_id}`, creds);
                    cancelled++;
                    results.push({ ticker, age: ageMin, status: 'cancelled', reason: 'forced (pre-exit)' });
                } catch (err) {
                    results.push({ ticker, age: ageMin, status: 'failed', error: err.message });
                }
                continue;
            }

            // If order is young, always keep
            if (age <= maxAge) {
                results.push({ ticker, age: ageMin, status: 'kept', reason: 'young' });
                continue;
            }

            // Check current market price to see if order is close to filling
            let shouldCancel = true;
            let reason = 'stale price';
            try {
                const marketData = await authFetch('GET', `/markets/${ticker}`, { apiKeyId: creds.apiKeyId, privateKeyPem: creds.privateKeyPem }).catch(() => null);
                if (marketData) {
                    const lastPrice = parseFloat(marketData.market?.last_price_dollars || marketData.last_price_dollars || '0') * 100;
                    const priceDiff = Math.abs(orderPrice - lastPrice);

                    // Keep if order price is within 5¢ of market (close to filling)
                    if (priceDiff <= 5) {
                        shouldCancel = false;
                        reason = `close to market (${priceDiff.toFixed(0)}¢ away)`;
                    }
                    // Keep if it's a buy below market (good limit order waiting for dip)
                    else if (action === 'buy' && orderPrice < lastPrice) {
                        shouldCancel = false;
                        reason = `buy order below market (${priceDiff.toFixed(0)}¢ below)`;
                    }
                    // Keep if it's a sell above market (good limit order waiting for spike)
                    else if (action === 'sell' && orderPrice > lastPrice) {
                        shouldCancel = false;
                        reason = `sell order above market (${priceDiff.toFixed(0)}¢ above)`;
                    } else {
                        reason = `${priceDiff.toFixed(0)}¢ from market, wrong side`;
                    }
                }
            } catch {}

            // Cancel if price is stale and order is past max age
            if (shouldCancel && age > maxAge) {
                try {
                    await authFetch('DELETE', `/portfolio/orders/${order.order_id}`, creds);
                    cancelled++;
                    results.push({ ticker, age: ageMin, status: 'cancelled', reason });
                } catch (err) {
                    results.push({ ticker, age: ageMin, status: 'failed', error: err.message });
                }
            } else {
                results.push({ ticker, age: ageMin, status: 'kept', reason });
            }
        }

        return res.status(200).json({
            totalResting: orders.length,
            cancelled,
            kept: orders.length - cancelled,
            results,
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

function authFetch(method, path, creds) {
    const timestamp = Date.now().toString();
    const fullPath = '/trade-api/v2' + path.split('?')[0];
    const message = timestamp + method.toUpperCase() + fullPath;
    const signature = crypto.sign('sha256', Buffer.from(message), {
        key: creds.privateKeyPem,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    }).toString('base64');

    return fetch(BASE_URL + path, {
        method,
        headers: {
            'KALSHI-ACCESS-KEY': creds.apiKeyId,
            'KALSHI-ACCESS-TIMESTAMP': timestamp,
            'KALSHI-ACCESS-SIGNATURE': signature,
            'Content-Type': 'application/json',
        },
    }).then(async r => {
        if (!r.ok) throw new Error(`Kalshi ${r.status}: ${(await r.text()).slice(0, 200)}`);
        return method === 'DELETE' ? {} : r.json();
    });
}

function decodeKey(key) {
    if (!key) return key;
    if (key.includes('-----BEGIN')) return key;
    try {
        const decoded = Buffer.from(key, 'base64').toString('utf-8');
        if (decoded.includes('-----BEGIN')) return decoded;
    } catch {}
    return key;
}
