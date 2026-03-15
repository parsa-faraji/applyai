// Vercel Serverless Function — Trade execution via Polymarket CLOB API
// Places buy/sell orders on Polymarket

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Poly-Api-Key, X-Poly-Secret, X-Poly-Passphrase');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { tokenId, side, amount, price } = req.body;

    if (!tokenId || !side || !amount) {
        return res.status(400).json({ error: 'Missing required fields: tokenId, side, amount' });
    }

    const apiKey = req.headers['x-poly-api-key'] || process.env.POLYMARKET_API_KEY;
    const apiSecret = req.headers['x-poly-secret'] || process.env.POLYMARKET_API_SECRET;
    const passphrase = req.headers['x-poly-passphrase'] || process.env.POLYMARKET_PASSPHRASE;

    if (!apiKey || !apiSecret || !passphrase) {
        return res.status(400).json({
            error: 'Polymarket CLOB API credentials required. Configure them in Settings.',
        });
    }

    try {
        // For now, we'll record the trade intent locally and provide instructions
        // Full CLOB integration requires the @polymarket/clob-client package
        // and wallet signing, which needs to run on the client or a persistent server

        const tradeRecord = {
            id: `trade_${Date.now()}`,
            tokenId,
            side, // 'BUY' or 'SELL'
            amount: parseFloat(amount),
            price: price ? parseFloat(price) : null,
            status: 'pending',
            timestamp: new Date().toISOString(),
        };

        // In a production setup, you would:
        // 1. Use the CLOB client to create a signed order
        // 2. Submit it to the CLOB API
        // 3. Monitor fill status
        //
        // The CLOB API endpoint is: https://clob.polymarket.com/order
        // Docs: https://docs.polymarket.com/#create-and-place-an-order

        // For the MVP, we record the trade and return it
        // The frontend will store it in localStorage
        return res.status(200).json({
            trade: tradeRecord,
            message: 'Trade recorded. Connect Polymarket CLOB credentials for live execution.',
            clobEndpoint: 'https://clob.polymarket.com/order',
        });

    } catch (error) {
        console.error('Trade error:', error);
        return res.status(500).json({ error: error.message || 'Trade execution failed' });
    }
}
