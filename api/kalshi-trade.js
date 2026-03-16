// Vercel Serverless Function — Trade execution via Kalshi API
// Handles both BUY and SELL orders using RSA-PSS signed requests.

import { placeOrder, getOrderBook, summarizeOrderBook } from './lib/kalshi.js';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Kalshi-Key-Id, X-Kalshi-Private-Key');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { ticker, side, action, count, price, maxCost } = req.body;

    if (!ticker || !side || !action) {
        return res.status(400).json({ error: 'Missing required: ticker, side (yes/no), action (buy/sell)' });
    }

    if (!count || count <= 0) {
        return res.status(400).json({ error: 'Count (number of contracts) must be > 0' });
    }

    if (count > 1000) {
        return res.status(400).json({ error: 'Max 1000 contracts per order' });
    }

    const apiKeyId = req.headers['x-kalshi-key-id'] || process.env.KALSHI_API_KEY_ID;
    const privateKeyPem = req.headers['x-kalshi-private-key'] || process.env.KALSHI_PRIVATE_KEY;

    if (apiKeyId && privateKeyPem) {
        return executeLiveTrade(res, {
            ticker, side, action, count, price, maxCost,
            apiKeyId, privateKeyPem: decodeKey(privateKeyPem),
        });
    }

    return executePaperTrade(res, { ticker, side, action, count, price });
}

async function executeLiveTrade(res, params) {
    const { ticker, side, action, count, price, maxCost, apiKeyId, privateKeyPem } = params;

    try {
        const isSell = action.toLowerCase() === 'sell';
        const obData = await getOrderBook(ticker);
        const ob = summarizeOrderBook(obData);

        // For sells: use best bid MINUS 1¢ to guarantee fill (undercut buyers)
        // For buys: use best ask PLUS 1¢ to guarantee fill
        let tradePrice = price;
        if (!tradePrice) {
            if (isSell) {
                const bestBid = ob?.bestYesBid || ob?.midpoint;
                tradePrice = bestBid ? Math.max(1, bestBid - 1) : 50;
            } else {
                tradePrice = ob?.bestYesAsk ? ob.bestYesAsk + 1 : (ob?.midpoint || 50);
            }
        } else if (isSell) {
            // Always sell at or below best bid to fill immediately
            const bestBid = ob?.bestYesBid;
            if (bestBid) tradePrice = Math.min(tradePrice, Math.max(1, bestBid - 1));
        }

        const order = {
            ticker,
            side: side.toLowerCase(),       // "yes" or "no"
            action: action.toLowerCase(),   // "buy" or "sell"
            count: Math.floor(count),
            type: 'limit',
        };

        // Set price based on side
        if (side.toLowerCase() === 'yes') {
            order.yes_price = Math.round(tradePrice);
        } else {
            order.no_price = Math.round(tradePrice);
        }

        if (maxCost != null) {
            order.buy_max_cost = Math.round(maxCost);
        }

        const result = await placeOrder(order, { apiKeyId, privateKeyPem });
        const orderResult = result.order || result;

        return res.status(200).json({
            trade: {
                id: orderResult.order_id || `kalshi_${Date.now()}`,
                ticker, side, action,
                count: Math.floor(count),
                price: tradePrice,
                cost: tradePrice * count, // cents
                status: orderResult.status || 'submitted',
                timestamp: new Date().toISOString(),
                live: true,
                exchange: 'kalshi',
            },
            kalshiResponse: result,
        });

    } catch (error) {
        console.error('Kalshi live trade error:', error);
        return res.status(502).json({
            error: `Kalshi trade failed: ${error.message}`,
            suggestion: 'Check your API Key ID and private key. You can paper trade without credentials.',
        });
    }
}

async function executePaperTrade(res, params) {
    const { ticker, side, action, count, price } = params;
    const tradePrice = price || 50; // cents

    return res.status(200).json({
        trade: {
            id: `paper_kalshi_${Date.now()}`,
            ticker, side, action,
            count: Math.floor(count),
            price: tradePrice,
            cost: tradePrice * count, // cents
            status: 'filled',
            timestamp: new Date().toISOString(),
            live: false, paper: true,
            exchange: 'kalshi',
        },
        message: `Paper ${action}: ${count} ${side.toUpperCase()} contracts at ${tradePrice}¢. Add Kalshi API credentials for live trading.`,
    });
}

/**
 * Decode private key — handles both raw PEM and base64-encoded PEM
 * (base64 encoding is needed to pass PEM via HTTP headers)
 */
function decodeKey(key) {
    if (key.includes('-----BEGIN')) return key;
    try {
        const decoded = Buffer.from(key, 'base64').toString('utf-8');
        if (decoded.includes('-----BEGIN')) return decoded;
    } catch {}
    return key;
}
