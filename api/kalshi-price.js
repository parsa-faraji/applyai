// Simple Kalshi price endpoint — returns midpoint for a market ticker
import { getOrderBook, summarizeOrderBook } from './lib/kalshi.js';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');

    const ticker = req.query?.ticker;
    const side = (req.query?.side || 'Yes').toLowerCase();

    if (!ticker) return res.status(400).json({ error: 'ticker required' });

    try {
        const obData = await getOrderBook(ticker);
        const ob = summarizeOrderBook(obData);
        if (!ob) return res.status(200).json({ mid: null });

        // Midpoint is YES price — flip for NO positions
        const yesMid = ob.midpoint ? ob.midpoint / 100 : null;
        const isYes = side === 'yes';
        const mid = yesMid != null ? (isYes ? yesMid : 1 - yesMid) : null;

        return res.status(200).json({
            mid,
            bestBid: isYes ? (ob.bestYesBid ? ob.bestYesBid / 100 : null) : (ob.bestNoBid ? ob.bestNoBid / 100 : null),
            bestAsk: isYes ? (ob.bestYesAsk ? ob.bestYesAsk / 100 : null) : null,
            spread: ob.spread ? ob.spread / 100 : null,
        });
    } catch {
        return res.status(200).json({ mid: null });
    }
}
