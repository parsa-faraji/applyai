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

    const { maxAgeMinutes = 15 } = req.body;
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

            if (age > maxAge) {
                try {
                    await authFetch('DELETE', `/portfolio/orders/${order.order_id}`, creds);
                    cancelled++;
                    results.push({ orderId: order.order_id, ticker: order.ticker, age: ageMin, status: 'cancelled' });
                } catch (err) {
                    results.push({ orderId: order.order_id, ticker: order.ticker, age: ageMin, status: 'failed', error: err.message });
                }
            } else {
                results.push({ orderId: order.order_id, ticker: order.ticker, age: ageMin, status: 'kept' });
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
