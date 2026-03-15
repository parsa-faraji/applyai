/**
 * Polymarket CLOB API client
 * Handles order creation, EIP-712 signing, L2 HMAC auth, and submission
 *
 * Polymarket uses a CTF (Conditional Token Framework) exchange on Polygon.
 * Orders are signed off-chain with EIP-712 and submitted to the CLOB REST API.
 * API requests are authenticated with HMAC-SHA256 (L2 auth).
 */

import { ethers } from 'ethers';
import crypto from 'crypto';

const CLOB_BASE = 'https://clob.polymarket.com';

// Polymarket CTF Exchange contract on Polygon
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
// Neg Risk CTF Exchange (for multi-outcome markets)
const NEG_RISK_CTF_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';

const CHAIN_ID = 137; // Polygon mainnet

// EIP-712 types for Polymarket order signing
const ORDER_TYPES = {
    Order: [
        { name: 'salt', type: 'uint256' },
        { name: 'maker', type: 'address' },
        { name: 'signer', type: 'address' },
        { name: 'taker', type: 'address' },
        { name: 'tokenId', type: 'uint256' },
        { name: 'makerAmount', type: 'uint256' },
        { name: 'takerAmount', type: 'uint256' },
        { name: 'expiration', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'feeRateBps', type: 'uint256' },
        { name: 'side', type: 'uint8' },
        { name: 'signatureType', type: 'uint8' },
    ],
};

// Side enum: 0 = BUY, 1 = SELL
const SIDE = { BUY: 0, SELL: 1 };

/**
 * Create L2 HMAC-SHA256 headers for CLOB API authentication
 *
 * Polymarket L2 auth: HMAC-SHA256(secret, timestamp + method + path + body + nonce)
 * Secret is base64-encoded.
 */
function createL2Headers(apiKey, secret, passphrase, method, path, body = '', signerAddress = '') {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomBytes(16).toString('hex');

    const message = timestamp + method.toUpperCase() + path + (body || '') + nonce;
    const secretBytes = Buffer.from(secret, 'base64');
    const signature = crypto
        .createHmac('sha256', secretBytes)
        .update(message)
        .digest('base64');

    return {
        'POLY_ADDRESS': signerAddress,
        'POLY_API_KEY': apiKey,
        'POLY_SIGNATURE': signature,
        'POLY_PASSPHRASE': passphrase,
        'POLY_TIMESTAMP': timestamp,
        'POLY_NONCE': nonce,
    };
}

/**
 * Build a CLOB market order
 *
 * For a market buy: you specify how much USDC you want to spend.
 * USDC has 6 decimals, shares (conditional tokens) have 6 decimals.
 */
export function buildMarketOrder({ tokenId, side, amount, price, feeRateBps = 0, negRisk = false }) {
    const sideInt = side === 'BUY' ? SIDE.BUY : SIDE.SELL;

    // For BUY: makerAmount = USDC to spend, takerAmount = shares to receive
    const usdcAmount = Math.floor(amount * 1e6);
    const shareAmount = Math.floor((amount / price) * 1e6);

    return {
        tokenId,
        side: sideInt,
        makerAmount: sideInt === SIDE.BUY ? usdcAmount.toString() : shareAmount.toString(),
        takerAmount: sideInt === SIDE.BUY ? shareAmount.toString() : usdcAmount.toString(),
        feeRateBps: feeRateBps.toString(),
        negRisk,
    };
}

/**
 * Sign an order using EIP-712
 */
export async function signOrder(order, privateKey, negRisk = false) {
    const wallet = new ethers.Wallet(privateKey);
    const address = await wallet.getAddress();

    const exchangeAddress = negRisk ? NEG_RISK_CTF_EXCHANGE : CTF_EXCHANGE;

    const domain = {
        name: 'Polymarket CTF Exchange',
        version: '1',
        chainId: CHAIN_ID,
        verifyingContract: exchangeAddress,
    };

    // Generate random salt
    const salt = BigInt(crypto.randomBytes(8).readBigUInt64BE()).toString();
    const nonce = '0';
    const expiration = '0'; // 0 = no expiration

    const orderData = {
        salt,
        maker: address,
        signer: address,
        taker: '0x0000000000000000000000000000000000000000',
        tokenId: order.tokenId,
        makerAmount: order.makerAmount,
        takerAmount: order.takerAmount,
        expiration,
        nonce,
        feeRateBps: order.feeRateBps || '0',
        side: order.side,
        signatureType: 0, // EOA
    };

    const signature = await wallet.signTypedData(domain, ORDER_TYPES, orderData);

    return {
        order: orderData,
        signature,
        owner: address,
        orderType: 'FOK', // Fill-or-Kill for market orders
    };
}

/**
 * Submit a signed order to the CLOB API
 */
export async function submitOrder(signedOrder, apiKey, apiSecret, passphrase, signerAddress) {
    const path = '/order';
    const body = JSON.stringify(signedOrder);

    const headers = {
        'Content-Type': 'application/json',
        ...createL2Headers(apiKey, apiSecret, passphrase, 'POST', path, body, signerAddress),
    };

    const resp = await fetch(`${CLOB_BASE}${path}`, {
        method: 'POST',
        headers,
        body,
    });

    const data = await resp.json();
    if (!resp.ok) {
        throw new Error(data.error || data.message || `CLOB API error: ${resp.status}`);
    }

    return data;
}

/**
 * Derive API credentials from wallet (L1 auth — call once and cache)
 */
export async function deriveApiCredentials(privateKey) {
    const wallet = new ethers.Wallet(privateKey);
    const address = await wallet.getAddress();
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomBytes(16).toString('hex');

    // EIP-712 domain for ClobAuth
    const domain = {
        name: 'ClobAuthDomain',
        version: '1',
        chainId: CHAIN_ID,
    };

    const types = {
        ClobAuth: [
            { name: 'address', type: 'address' },
            { name: 'timestamp', type: 'string' },
            { name: 'nonce', type: 'uint256' },
            { name: 'message', type: 'string' },
        ],
    };

    const value = {
        address,
        timestamp,
        nonce: '0',
        message: 'This message attests that I control the given wallet',
    };

    const signature = await wallet.signTypedData(domain, types, value);

    // POST to /auth/derive-api-key
    const resp = await fetch(`${CLOB_BASE}/auth/derive-api-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            address,
            timestamp,
            nonce: '0',
            message: value.message,
            signature,
        }),
    });

    if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`Failed to derive API key: ${resp.status} — ${err}`);
    }

    // Returns { apiKey, secret, passphrase }
    return resp.json();
}

/**
 * Get the order book for a token
 */
export async function getOrderBook(tokenId) {
    const resp = await fetch(`${CLOB_BASE}/book?token_id=${tokenId}`);
    if (!resp.ok) throw new Error(`Failed to get order book: ${resp.status}`);
    return resp.json();
}

/**
 * Get the best price for a token
 */
export async function getBestPrice(tokenId) {
    const book = await getOrderBook(tokenId);
    const bestAsk = book.asks?.[0]?.price ? parseFloat(book.asks[0].price) : null;
    const bestBid = book.bids?.[0]?.price ? parseFloat(book.bids[0].price) : null;
    const mid = bestAsk && bestBid ? (bestAsk + bestBid) / 2 : bestAsk || bestBid;
    return { bestAsk, bestBid, mid, spread: bestAsk && bestBid ? bestAsk - bestBid : null };
}

/**
 * Get midpoint price — use this for market orders
 */
export async function getMidpoint(tokenId) {
    const resp = await fetch(`${CLOB_BASE}/midpoint?token_id=${tokenId}`);
    if (!resp.ok) throw new Error(`Failed to get midpoint: ${resp.status}`);
    const data = await resp.json();
    return parseFloat(data.mid);
}

/**
 * Get current open orders for a user
 */
export async function getOpenOrders(apiKey, apiSecret, passphrase, signerAddress) {
    const path = '/orders?open=true';
    const headers = createL2Headers(apiKey, apiSecret, passphrase, 'GET', path, '', signerAddress);
    const resp = await fetch(`${CLOB_BASE}${path}`, { headers });
    if (!resp.ok) throw new Error(`Failed to get orders: ${resp.status}`);
    return resp.json();
}
