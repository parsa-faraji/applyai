// Vercel Serverless Function — Trade execution via Polymarket CLOB
// Handles both BUY and SELL orders. Signs EIP-712 and submits to CLOB API.

import { ethers } from 'ethers';
import { buildMarketOrder, signOrder, submitOrder, getMidpoint } from './lib/clob.js';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Poly-Api-Key, X-Poly-Secret, X-Poly-Passphrase, X-Poly-Private-Key');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { tokenId, side, amount, price, negRisk, shares } = req.body;

    if (!tokenId || !side) {
        return res.status(400).json({ error: 'Missing required fields: tokenId, side' });
    }

    // For SELL, we need shares; for BUY, we need amount
    if (side === 'BUY' && (!amount || amount <= 0)) {
        return res.status(400).json({ error: 'Amount required for BUY orders' });
    }
    if (side === 'SELL' && (!shares || shares <= 0) && (!amount || amount <= 0)) {
        return res.status(400).json({ error: 'Shares or amount required for SELL orders' });
    }

    if (amount && (amount <= 0 || amount > 10000)) {
        return res.status(400).json({ error: 'Amount must be between $0.01 and $10,000' });
    }

    const apiKey = req.headers['x-poly-api-key'] || process.env.POLYMARKET_API_KEY;
    const apiSecret = req.headers['x-poly-secret'] || process.env.POLYMARKET_API_SECRET;
    const passphrase = req.headers['x-poly-passphrase'] || process.env.POLYMARKET_PASSPHRASE;
    const privateKey = req.headers['x-poly-private-key'] || process.env.POLYMARKET_PRIVATE_KEY;

    if (apiKey && apiSecret && passphrase && privateKey) {
        return executeLiveTrade(req, res, {
            tokenId, side, amount, price, negRisk, shares,
            apiKey, apiSecret, passphrase, privateKey,
        });
    }

    return executePaperTrade(req, res, { tokenId, side, amount, price, shares });
}

async function executeLiveTrade(req, res, params) {
    const { tokenId, side, negRisk, apiKey, apiSecret, passphrase, privateKey } = params;

    try {
        // Get real-time midpoint price from the CLOB
        let tradePrice;
        try {
            tradePrice = await getMidpoint(tokenId);
        } catch {
            tradePrice = params.price || 0.5;
        }

        // For SELL: amount = shares * price (selling shares for USDC)
        // For BUY: amount = USDC to spend
        let tradeAmount;
        if (side === 'SELL') {
            const sellShares = params.shares || (params.amount / tradePrice);
            tradeAmount = sellShares * tradePrice;
        } else {
            tradeAmount = parseFloat(params.amount);
        }

        // Slippage tolerance
        const slippagePrice = side === 'BUY'
            ? Math.min(tradePrice * 1.01, 0.99)
            : Math.max(tradePrice * 0.99, 0.01);

        const order = buildMarketOrder({
            tokenId,
            side,
            amount: tradeAmount,
            price: slippagePrice,
            feeRateBps: 0,
            negRisk: negRisk || false,
        });

        const signed = await signOrder(order, privateKey, negRisk || false);
        const signerAddress = new ethers.Wallet(privateKey).address;
        const result = await submitOrder(signed, apiKey, apiSecret, passphrase, signerAddress);

        const tradeShares = side === 'BUY' ? tradeAmount / tradePrice : (params.shares || tradeAmount / tradePrice);

        return res.status(200).json({
            trade: {
                id: result.orderID || result.id || `live_${Date.now()}`,
                tokenId, side,
                amount: tradeAmount,
                price: tradePrice,
                shares: tradeShares,
                status: result.status || 'submitted',
                timestamp: new Date().toISOString(),
                live: true,
            },
            clobResponse: result,
        });

    } catch (error) {
        console.error('Live trade error:', error);
        return res.status(502).json({
            error: `Live trade failed: ${error.message}`,
            suggestion: 'Check your API credentials. You can still paper trade without CLOB credentials.',
        });
    }
}

async function executePaperTrade(req, res, params) {
    const { tokenId, side, price, shares: sellShares } = params;
    const tradePrice = price || 0.5;

    let amount, shares;
    if (side === 'SELL') {
        shares = sellShares || (params.amount / tradePrice);
        amount = shares * tradePrice;
    } else {
        amount = parseFloat(params.amount);
        shares = amount / tradePrice;
    }

    return res.status(200).json({
        trade: {
            id: `paper_${Date.now()}`,
            tokenId, side,
            amount, price: tradePrice, shares,
            status: 'filled',
            timestamp: new Date().toISOString(),
            live: false, paper: true,
        },
        message: side === 'SELL'
            ? `Paper sell executed: ${shares.toFixed(2)} shares at ${(tradePrice * 100).toFixed(0)}¢`
            : 'Paper trade executed. Add wallet private key for live CLOB execution.',
    });
}
