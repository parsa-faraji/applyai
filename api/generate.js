// Redirects old endpoint — this file is no longer used
export default function handler(req, res) {
    res.status(410).json({ error: 'This endpoint has been replaced. Use /api/markets, /api/analyze, or /api/trade.' });
}
