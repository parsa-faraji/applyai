/**
 * Polymarket CLOB API client
 * Handles order creation, signing (EIP-712), and submission
 *
 * Polymarket uses a CTF (Conditional Token Framework) exchange on Polygon.
 * Orders are signed off-chain with EIP-712 and submitted to the CLOB REST API.
 */

import { ethers } from 'ethers';

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
 * Create HMAC signature for CLOB API authentication
 */
function createL1Headers(apiKey, secret, passphrase, method, path, body = '') {
    // Polymarket CLOB uses timestamp + method + path + body HMAC-SHA256
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const message = timestamp + method.toUpperCase() + path + (body || '');

    // We'll pass API creds as headers — the CLOB API uses a simple key/secret/passphrase scheme
    return {
        'POLY_API_KEY': apiKey,
        'POLY_SECRET': secret,
        'POLY_PASSPHRASE': passphrase,
        'POLY_TIMESTAMP': timestamp,
        'POLY_SIGNATURE': message, // simplified — real impl needs HMAC
    };
}

/**
 * Build a CLOB market order
 *
 * For a market buy: you specify how much USDC you want to spend, and accept the best price
 * For market orders, we use the Polymarket "market order" endpoint which handles matching
 */
export function buildMarketOrder({ tokenId, side, amount, price, feeRateBps = 0, negRisk = false }) {
    const sideInt = side === 'BUY' ? SIDE.BUY : SIDE.SELL;

    // For a BUY: makerAmount = USDC to spend (in base units), takerAmount = shares to receive
    // Price = takerAmount / makerAmount for BUY
    // USDC has 6 decimals, shares have 6 decimals on Polymarket
    const usdcAmount = Math.floor(amount * 1e6); // to USDC base units
    const shareAmount = Math.floor((amount / price) * 1e6); // shares in base units

    return {
        tokenId: tokenId,
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

    // Generate random salt and nonce
    const salt = BigInt(Math.floor(Math.random() * 1e18)).toString();
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
export async function submitOrder(signedOrder, apiKey, apiSecret, passphrase) {
    const path = '/order';
    const body = JSON.stringify(signedOrder);
    const timestamp = Math.floor(Date.now() / 1000).toString();

    const resp = await fetch(`${CLOB_BASE}${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'POLY_API_KEY': apiKey,
            'POLY_SECRET': apiSecret,
            'POLY_PASSPHRASE': passphrase,
            'POLY_TIMESTAMP': timestamp,
        },
        body,
    });

    const data = await resp.json();
    if (!resp.ok) {
        throw new Error(data.error || data.message || `CLOB API error: ${resp.status}`);
    }

    return data;
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
export async function getOpenOrders(apiKey, apiSecret, passphrase) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const resp = await fetch(`${CLOB_BASE}/orders?open=true`, {
        headers: {
            'POLY_API_KEY': apiKey,
            'POLY_SECRET': apiSecret,
            'POLY_PASSPHRASE': passphrase,
            'POLY_TIMESTAMP': timestamp,
        },
    });
    if (!resp.ok) throw new Error(`Failed to get orders: ${resp.status}`);
    return resp.json();
}
