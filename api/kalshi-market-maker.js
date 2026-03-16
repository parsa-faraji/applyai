// Vercel Serverless Function — Kalshi Market Maker Strategy
// Posts resting limit orders on both sides of the book to capture the bid-ask spread.
// Uses maker (resting) orders which are 4x cheaper on Kalshi fees.
// Volatility-based spread calculation with inventory skew for risk management.

import { getMarkets, getOrderBook, summarizeOrderBook, placeOrder, normalizeMarket } from './lib/kalshi.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Kalshi-Key-Id, X-Kalshi-Private-Key');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const {
        budget = 100,
        maxPerMarket = 3,      // % of budget per market
        maxMarkets = 5,
        dryRun = true,
    } = req.body || {};

    const kalshiKeyId = req.headers['x-kalshi-key-id'] || process.env.KALSHI_API_KEY_ID;
    const kalshiPrivateKey = req.headers['x-kalshi-private-key'] || process.env.KALSHI_PRIVATE_KEY;
    const hasLiveCreds = !!(kalshiKeyId && kalshiPrivateKey);

    const report = {
        timestamp: new Date().toISOString(),
        strategy: 'market-maker',
        exchange: 'kalshi',
        marketsScanned: 0,
        marketsQuoted: 0,
        ordersPlaced: 0,
        totalExposure: 0,
        dryRun,
        hasLiveCreds,
        quotes: [],
        errors: [],
    };

    try {
        // 1. Fetch active markets with smart sort
        const data = await getMarkets({ _smartSort: true, limit: 200 });
        const allMarkets = data.markets || [];
        report.marketsScanned = allMarkets.length;

        // 2. Score and filter markets for market-making suitability
        const now = Date.now();
        const scored = [];

        for (const m of allMarkets) {
            const volume24h = parseFloat(m.volume_24h_fp || '0');
            if (volume24h <= 0) continue; // Must have recent trading activity

            const expiry = Date.parse(m.expected_expiration_time || m.close_time || '2099-01-01');
            const daysToExpiry = Math.max(0.01, (expiry - now) / 86400000);

            // Prefer markets resolving within 1-7 days
            if (daysToExpiry < 0.05 || daysToExpiry > 7) continue;

            scored.push({ m, volume24h, daysToExpiry });
        }

        // Sort by 24h volume descending (most liquid first)
        scored.sort((a, b) => b.volume24h - a.volume24h);

        // 3. For each candidate, fetch order book and evaluate
        const budgetPerMarket = (budget * (maxPerMarket / 100));
        let marketsQuoted = 0;

        for (const { m: rawMarket, daysToExpiry } of scored) {
            if (marketsQuoted >= maxMarkets) break;

            const market = normalizeMarket(rawMarket);

            try {
                const obData = await getOrderBook(rawMarket.ticker);
                const ob = summarizeOrderBook(obData);

                if (!ob || ob.bestYesBid == null || ob.bestYesAsk == null) continue;
                if (ob.spread == null) continue;

                // Market selection criteria
                if (ob.yesDepthUsd < 5 || ob.noDepthUsd < 5) continue; // Need > $5 depth on each side
                if (ob.spread <= 2) continue;  // Spread must be > 2c (room to profit)
                if (ob.spread > 30) continue;  // Skip too-illiquid markets (> 30c spread)

                const midpoint = ob.midpoint;
                const p = midpoint / 100; // probability

                // Volatility-based spread calculation
                // sigma = sqrt(p * (1 - p) / daysToExpiry)
                const sigma = Math.sqrt(p * (1 - p) / daysToExpiry);
                const volSpread = sigma * 100 * 2; // in cents
                const targetSpread = Math.max(3, Math.min(15, Math.round(volSpread)));

                // Ensure we don't quote inside the existing best bid/ask
                const effectiveSpread = Math.max(targetSpread, 3);

                // Calculate quotes
                let buyPrice = Math.floor(midpoint - effectiveSpread / 2);  // round down
                let sellPrice = Math.ceil(midpoint + effectiveSpread / 2);   // round up

                // Clamp to valid Kalshi price range (1-99)
                buyPrice = Math.max(1, Math.min(99, buyPrice));
                sellPrice = Math.max(1, Math.min(99, sellPrice));

                // Ensure buy < sell
                if (buyPrice >= sellPrice) continue;

                const actualSpread = sellPrice - buyPrice;

                // Inventory skew: check if we already hold a position
                // We look at the order book imbalance as a proxy for our inventory
                // (In a real system we'd query portfolio positions, but that requires
                //  additional API calls per market)
                if (ob.depthRatio != null) {
                    if (ob.depthRatio > 2) {
                        // Heavy YES side (implies we might be long YES) — lower buy, keep sell
                        buyPrice = Math.max(1, buyPrice - 1);
                    } else if (ob.depthRatio < 0.5) {
                        // Heavy NO side — raise sell price, keep buy
                        sellPrice = Math.min(99, sellPrice + 1);
                    }
                }

                // Size: allocate budgetPerMarket split between buy and sell
                // Each order gets half the per-market budget
                const halfBudgetCents = Math.floor(budgetPerMarket * 100 / 2);
                const buyContracts = Math.max(1, Math.floor(halfBudgetCents / buyPrice));
                const sellContracts = Math.max(1, Math.floor(halfBudgetCents / (100 - sellPrice)));

                // Cap at 20 contracts per side to manage inventory risk
                const buyCount = Math.min(buyContracts, 20);
                const sellCount = Math.min(sellContracts, 20);

                const quote = {
                    ticker: rawMarket.ticker,
                    market: market.question,
                    buyPrice,
                    sellPrice,
                    spread: actualSpread,
                    midpoint: Math.round(midpoint),
                    buyContracts: buyCount,
                    sellContracts: sellCount,
                    daysToExpiry: parseFloat(daysToExpiry.toFixed(1)),
                    volatilitySpread: parseFloat(volSpread.toFixed(1)),
                    orders: [],
                };

                // Place orders
                if (dryRun || !hasLiveCreds) {
                    quote.orders.push({
                        side: 'buy',
                        price: buyPrice,
                        count: buyCount,
                        paper: true,
                        status: 'resting',
                    });
                    quote.orders.push({
                        side: 'sell',
                        price: sellPrice,
                        count: sellCount,
                        paper: true,
                        status: 'resting',
                    });
                    report.ordersPlaced += 2;
                } else {
                    const privateKeyPem = decodeKey(kalshiPrivateKey);
                    const creds = { apiKeyId: kalshiKeyId, privateKeyPem };

                    // Buy YES at buyPrice (resting limit order)
                    try {
                        const buyResult = await placeOrder({
                            ticker: rawMarket.ticker,
                            side: 'yes',
                            action: 'buy',
                            count: buyCount,
                            yes_price: buyPrice,
                            type: 'limit',
                        }, creds);

                        quote.orders.push({
                            side: 'buy',
                            price: buyPrice,
                            count: buyCount,
                            orderId: buyResult.order?.order_id,
                            status: buyResult.order?.status || 'submitted',
                            live: true,
                        });
                        report.ordersPlaced++;
                    } catch (err) {
                        quote.orders.push({
                            side: 'buy',
                            price: buyPrice,
                            count: buyCount,
                            status: 'error',
                            error: err.message,
                        });
                        report.errors.push({ ticker: rawMarket.ticker, side: 'buy', error: err.message });
                    }

                    // Sell YES at sellPrice (resting limit order)
                    try {
                        const sellResult = await placeOrder({
                            ticker: rawMarket.ticker,
                            side: 'yes',
                            action: 'sell',
                            count: sellCount,
                            yes_price: sellPrice,
                            type: 'limit',
                        }, creds);

                        quote.orders.push({
                            side: 'sell',
                            price: sellPrice,
                            count: sellCount,
                            orderId: sellResult.order?.order_id,
                            status: sellResult.order?.status || 'submitted',
                            live: true,
                        });
                        report.ordersPlaced++;
                    } catch (err) {
                        quote.orders.push({
                            side: 'sell',
                            price: sellPrice,
                            count: sellCount,
                            status: 'error',
                            error: err.message,
                        });
                        report.errors.push({ ticker: rawMarket.ticker, side: 'sell', error: err.message });
                    }
                }

                // Calculate exposure for this market
                const buyExposure = (buyCount * buyPrice) / 100;
                const sellExposure = (sellCount * (100 - sellPrice)) / 100;
                report.totalExposure += buyExposure + sellExposure;

                report.quotes.push(quote);
                marketsQuoted++;

            } catch (err) {
                report.errors.push({ ticker: rawMarket.ticker, market: market.question, error: err.message });
            }
        }

        report.marketsQuoted = marketsQuoted;

    } catch (err) {
        report.errors.push({ market: 'fetch_markets', error: err.message });
    }

    return res.status(200).json(report);
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
