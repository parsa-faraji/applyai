// Vercel Serverless Function — Derive Polymarket API credentials from wallet
// Uses L1 EIP-712 auth to generate API key/secret/passphrase

import { deriveApiCredentials } from './lib/clob.js';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Poly-Private-Key');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const privateKey = req.headers['x-poly-private-key'] || process.env.POLYMARKET_PRIVATE_KEY;

    if (!privateKey) {
        return res.status(400).json({ error: 'Wallet private key required to derive API credentials' });
    }

    try {
        const credentials = await deriveApiCredentials(privateKey);
        return res.status(200).json({
            message: 'API credentials derived successfully. Save these in Settings.',
            credentials,
        });
    } catch (error) {
        console.error('Derive keys error:', error);
        return res.status(500).json({ error: error.message });
    }
}
