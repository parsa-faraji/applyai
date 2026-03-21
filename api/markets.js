// Vercel Serverless Function — Polymarket Gamma API proxy
// Fetches live market data from Polymarket's public API

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const {
            limit = '20',
            offset = '0',
            order = 'volume24hr',
            ascending = 'false',
            closed = 'false',
            tag,
            slug,
            id,
        } = req.query || {};

        // Validate numeric query params to prevent injection
        const parsedLimit = Math.min(Math.max(1, parseInt(limit, 10) || 20), 100);
        const parsedOffset = Math.max(0, parseInt(offset, 10) || 0);
        const allowedOrders = ['volume24hr', 'volume', 'liquidity', 'startDate', 'endDate'];
        const parsedOrder = allowedOrders.includes(order) ? order : 'volume24hr';

        // If requesting a single market by slug or id
        if (slug) {
            const url = `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`;
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`Gamma API error: ${resp.status}`);
            const data = await resp.json();
            return res.status(200).json(data);
        }

        if (id) {
            const url = `https://gamma-api.polymarket.com/markets/${encodeURIComponent(id)}`;
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`Gamma API error: ${resp.status}`);
            const data = await resp.json();
            return res.status(200).json(data);
        }

        // Build query for listing markets (using validated values)
        const params = new URLSearchParams({
            limit: parsedLimit.toString(),
            offset: parsedOffset.toString(),
            order: parsedOrder,
            ascending: ascending === 'true' ? 'true' : 'false',
            closed: closed === 'true' ? 'true' : 'false',
            active: 'true',
        });

        if (tag) params.set('tag', tag);

        const url = `https://gamma-api.polymarket.com/markets?${params.toString()}`;
        const resp = await fetch(url);

        if (!resp.ok) {
            const errorText = await resp.text();
            console.error('Gamma API error:', resp.status, errorText);
            throw new Error(`Gamma API returned ${resp.status}`);
        }

        const markets = await resp.json();
        return res.status(200).json(markets);

    } catch (error) {
        console.error('Markets API error:', error);
        return res.status(500).json({ error: error.message || 'Failed to fetch markets' });
    }
}
