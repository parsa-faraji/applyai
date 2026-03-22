// Syncs open positions and recent trades from Kalshi account
// Returns positions in the format the frontend/monitor expects

import crypto from 'crypto';
import { getMarket } from './lib/kalshi.js';

const BASE_URL = 'https://api.elections.kalshi.com/trade-api/v2';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Kalshi-Key-Id, X-Kalshi-Private-Key');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const kalshiKeyId = req.headers['x-kalshi-key-id'] || process.env.KALSHI_API_KEY_ID;
    const kalshiPrivateKey = req.headers['x-kalshi-private-key'] || process.env.KALSHI_PRIVATE_KEY;

    if (!kalshiKeyId || !kalshiPrivateKey) {
        return res.status(400).json({ error: 'Kalshi API credentials required' });
    }

    const privateKeyPem = decodeKey(kalshiPrivateKey);
    const creds = { apiKeyId: kalshiKeyId, privateKeyPem };

    try {
        // Hit multiple endpoints to find positions
        const [posResult, fillsResult, ordersResult, balanceResult] = await Promise.all([
            authFetch('GET', '/portfolio/positions', creds).catch(e => ({ _error: e.message })),
            authFetch('GET', '/portfolio/fills?limit=100', creds).catch(e => ({ _error: e.message })),
            authFetch('GET', '/portfolio/orders?limit=100', creds).catch(e => ({ _error: e.message })),
            authFetch('GET', '/portfolio/balance', creds).catch(e => ({ _error: e.message })),
        ]);

        // Try to find positions from the positions endpoint
        let rawPositions = findArray(posResult, ['market_positions', 'positions', 'portfolio_positions', 'event_positions']);

        // If positions endpoint returned nothing, reconstruct from fills
        const fills = findArray(fillsResult, ['fills', 'orders', 'trades']);

        // Also get orders
        const orders = findArray(ordersResult, ['orders']);

        // Build a cost basis map from fills (actual trade prices)
        // Fill fields: side ("yes"/"no"), yes_price_dollars, no_price_dollars, count_fp, action
        const costBasis = {};
        for (const f of fills) {
            const ticker = f.ticker || f.market_ticker;
            if (!ticker) continue;
            if (!costBasis[ticker]) costBasis[ticker] = { totalCost: 0, totalQty: 0, side: f.side };
            const count = parseNum(f.count_fp) || parseNum(f.count) || 0;
            const side = (f.side || '').toLowerCase();
            // Use the price matching the side
            const price = side === 'yes'
                ? (parseNum(f.yes_price_dollars) || 0)
                : (parseNum(f.no_price_dollars) || 0);
            const action = (f.action || 'buy').toLowerCase();
            if (action === 'buy') {
                costBasis[ticker].totalCost += price * count;
                costBasis[ticker].totalQty += count;
                costBasis[ticker].side = side;
            }
        }
        // If no positions but we have fills, reconstruct positions from fills
        if (rawPositions.length === 0 && fills.length > 0) {
            rawPositions = reconstructFromFills(fills);
        }

        // Fetch market details
        const marketDetails = {};
        const tickers = [...new Set(rawPositions.map(p => p.ticker || p.market_ticker).filter(Boolean))];
        await Promise.all(tickers.map(async (ticker) => {
            try {
                const m = await getMarket(ticker);
                marketDetails[ticker] = m.market || m;
            } catch {}
        }));

        // Convert to frontend format using actual Kalshi field names:
        // position_fp = current contracts held (0 = closed)
        // market_exposure_dollars = current $ at risk
        // total_traded_dollars = total volume
        // realized_pnl_dollars = P&L on closed portion
        const positions = rawPositions
            .filter(p => {
                const pos = parseNum(p.position_fp) || 0;
                return pos !== 0; // Only open positions
            })
            .filter(p => {
                // Filter out MVE parlay positions
                const ticker = p.ticker || '';
                const market = marketDetails[ticker];
                const title = market?.title || ticker;
                if (/^(yes|no)\s/i.test(title)) return false;
                if ((title.match(/,/g) || []).length >= 2 && /\d+\+/.test(title)) return false;
                return true;
            })
            .map(p => {
                const ticker = p.ticker || p.market_ticker;
                const market = marketDetails[ticker] || {};

                const positionFp = parseNum(p.position_fp) || 0;
                const shares = Math.abs(positionFp);

                // Use fills data for the REAL side — fills have an explicit 'side' field
                // Falls back to position_fp sign only if no fills exist
                const basis = costBasis[ticker];
                const side = basis?.side || (positionFp > 0 ? 'yes' : 'no');

                // Use cost basis from fills for accurate avg price
                const avgPrice = (basis && basis.totalQty > 0)
                    ? basis.totalCost / basis.totalQty
                    : (shares > 0 ? (parseNum(p.market_exposure_dollars) || 0) / shares : 0.5);
                const cost = avgPrice * shares;

                // last_price_dollars is the YES price. For NO positions, flip it.
                const lastPrice = parseFloat(market.last_price_dollars || '0') || null;
                const currentPrice = lastPrice != null
                    ? (side === 'yes' ? lastPrice : 1 - lastPrice)
                    : null;

                return {
                    marketId: ticker, ticker, tokenId: ticker,
                    market: market.title || ticker,
                    outcome: side === 'yes' ? 'Yes' : 'No',
                    shares, cost,
                    avgPrice: avgPrice || currentPrice || 0.5,
                    currentPrice: currentPrice || avgPrice || 0.5,
                    endDate: market.expected_expiration_time || market.close_time || null,
                    exchange: 'kalshi',
                    timestamp: p.last_updated_ts || new Date().toISOString(),
                    realizedPnl: parseNum(p.realized_pnl_dollars) || 0,
                };
            });

        // Sum realized P&L from ALL positions (including closed ones)
        let realizedPnl = 0;
        for (const p of rawPositions) {
            realizedPnl += parseNum(p.realized_pnl_dollars) || 0;
        }

        return res.status(200).json({
            positions,
            realizedPnl,
            balance: balanceResult.balance != null ? balanceResult.balance / 100 : null,
            portfolioValue: balanceResult.portfolio_value != null ? balanceResult.portfolio_value / 100 : null,
            openOrders: orders.filter(o => o.status === 'resting').length,
            restingTickers: [...new Set(orders.filter(o => o.status === 'resting').map(o => o.ticker).filter(Boolean))],
            synced: new Date().toISOString(),
        });

    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

// Reconstruct net positions from a list of fills/orders
function reconstructFromFills(fills) {
    const byTicker = {};
    for (const f of fills) {
        const ticker = f.ticker || f.market_ticker;
        if (!ticker) continue;
        if (!byTicker[ticker]) byTicker[ticker] = { ticker, yes_contracts: 0, no_contracts: 0, totalCost: 0 };
        const side = (f.side || '').toLowerCase();
        const action = (f.action || '').toLowerCase();
        const count = f.count || f.quantity || f.shares || 1;
        const price = parseNum(f.yes_price) || parseNum(f.no_price) || parseNum(f.price) || 0;

        if (action === 'buy' || !action) {
            if (side === 'yes') { byTicker[ticker].yes_contracts += count; byTicker[ticker].totalCost += price * count; }
            else if (side === 'no') { byTicker[ticker].no_contracts += count; byTicker[ticker].totalCost += price * count; }
        } else if (action === 'sell') {
            if (side === 'yes') byTicker[ticker].yes_contracts -= count;
            else if (side === 'no') byTicker[ticker].no_contracts -= count;
        }
    }
    return Object.values(byTicker).filter(p => p.yes_contracts > 0 || p.no_contracts > 0);
}

function findArray(obj, keys) {
    if (!obj || obj._error) return [];
    for (const key of keys) {
        if (Array.isArray(obj[key])) return obj[key];
    }
    if (Array.isArray(obj)) return obj;
    return [];
}

function parseNum(v) {
    if (v == null) return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
}

// Direct authenticated fetch (bypasses lib to ensure we get raw response)
function authFetch(method, path, creds) {
    const timestamp = Date.now().toString();
    const fullPath = '/trade-api/v2' + path.split('?')[0]; // sign without query
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
        return r.json();
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
