// Vercel Serverless Function — Real trade execution via Polymarket CLOB
// Signs EIP-712 orders and submits them to the CLOB API

import { ethers } from 'ethers';
import { buildMarketOrder, signOrder, submitOrder, getMidpoint } from './lib/clob.js';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Poly-Api-Key, X-Poly-Secret, X-Poly-Passphrase, X-Poly-Private-Key');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { tokenId, side, amount, price, negRisk } = req.body;

    if (!tokenId || !side || !amount) {
        return res.status(400).json({ error: 'Missing required fields: tokenId, side, amount' });
    }

    if (amount <= 0 || amount > 10000) {
        return res.status(400).json({ error: 'Amount must be between $0.01 and $10,000' });
    }

    const apiKey = req.headers['x-poly-api-key'] || process.env.POLYMARKET_API_KEY;
    const apiSecret = req.headers['x-poly-secret'] || process.env.POLYMARKET_API_SECRET;
    const passphrase = req.headers['x-poly-passphrase'] || process.env.POLYMARKET_PASSPHRASE;
    const privateKey = req.headers['x-poly-private-key'] || process.env.POLYMARKET_PRIVATE_KEY;

    // If we have full credentials + private key, do a real trade
    if (apiKey && apiSecret && passphrase && privateKey) {
        return executeLiveTrade(req, res, {
            tokenId, side, amount, price, negRisk,
            apiKey, apiSecret, passphrase, privateKey,
        });
    }

    // Otherwise, paper trade (track locally)
    return executePaperTrade(req, res, { tokenId, side, amount, price });
}

async function executeLiveTrade(req, res, params) {
    const { tokenId, side, amount, negRisk, apiKey, apiSecret, passphrase, privateKey } = params;

    try {
        // Get real-time midpoint price from the CLOB
        let tradePrice;
        try {
            tradePrice = await getMidpoint(tokenId);
        } catch {
            // Fallback to provided price
            tradePrice = params.price || 0.5;
        }

        // Add 1% slippage tolerance for market orders
        const slippagePrice = side === 'BUY'
            ? Math.min(tradePrice * 1.01, 0.99)  // pay up to 1% more
            : Math.max(tradePrice * 0.99, 0.01);  // accept 1% less

        // Build the order
        const order = buildMarketOrder({
            tokenId,
            side,
            amount: parseFloat(amount),
            price: slippagePrice,
            feeRateBps: 0,
            negRisk: negRisk || false,
        });

        // Sign with EIP-712
        const signed = await signOrder(order, privateKey, negRisk || false);

        // Submit to CLOB
        const signerAddress = new ethers.Wallet(privateKey).address;
        const result = await submitOrder(signed, apiKey, apiSecret, passphrase, signerAddress);

        const shares = parseFloat(amount) / tradePrice;

        return res.status(200).json({
            trade: {
                id: result.orderID || result.id || `live_${Date.now()}`,
                tokenId,
                side,
                amount: parseFloat(amount),
                price: tradePrice,
                shares,
                status: result.status || 'submitted',
                timestamp: new Date().toISOString(),
                live: true,
            },
            clobResponse: result,
        });

    } catch (error) {
        console.error('Live trade error:', error);

        // If CLOB fails, offer paper trade as fallback
        return res.status(502).json({
            error: `Live trade failed: ${error.message}`,
            suggestion: 'Check your API credentials and wallet private key. You can still paper trade without CLOB credentials.',
        });
    }
}

async function executePaperTrade(req, res, params) {
    const { tokenId, side, amount, price } = params;
    const tradePrice = price || 0.5;
    const shares = parseFloat(amount) / tradePrice;

    return res.status(200).json({
        trade: {
            id: `paper_${Date.now()}`,
            tokenId,
            side,
            amount: parseFloat(amount),
            price: tradePrice,
            shares,
            status: 'filled',
            timestamp: new Date().toISOString(),
            live: false,
            paper: true,
        },
        message: 'Paper trade executed. Add wallet private key in Settings for live CLOB execution.',
    });
}
