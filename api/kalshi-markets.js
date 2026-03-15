// Vercel Serverless Function — Kalshi market data proxy
// Fetches live market data from Kalshi's public API

import { getMarkets, getMarket, getEvents, normalizeMarket } from './lib/kalshi.js';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const {
            limit = '20',
            cursor,
            ticker,
            event_ticker,
            series_ticker,
            status = 'open',
        } = req.query;

        // Single market by ticker
        if (ticker) {
            const data = await getMarket(ticker);
            const normalized = normalizeMarket(data.market);
            return res.status(200).json(normalized);
        }

        // List markets
        const data = await getMarkets({
            limit: parseInt(limit),
            cursor,
            event_ticker,
            series_ticker,
            status,
        });

        const markets = (data.markets || []).map(normalizeMarket);
        return res.status(200).json({
            markets,
            cursor: data.cursor || null,
        });

    } catch (error) {
        console.error('Kalshi markets error:', error);
        return res.status(500).json({ error: error.message || 'Failed to fetch Kalshi markets' });
    }
}
