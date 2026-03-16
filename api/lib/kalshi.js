/**
 * Kalshi API client library
 *
 * Kalshi uses RSA-PSS signature auth (not simple API keys).
 * Every request is signed with: timestamp + method + path
 *
 * API base: https://api.elections.kalshi.com/trade-api/v2
 * Docs: https://docs.kalshi.com
 */

import crypto from 'crypto';

const BASE_URL = 'https://api.elections.kalshi.com/trade-api/v2';

/**
 * Sign a Kalshi API request using RSA-PSS
 * @param {string} privateKeyPem - RSA private key in PEM format
 * @param {string} timestamp - millisecond timestamp string
 * @param {string} method - HTTP method (GET, POST, etc.)
 * @param {string} path - API path (e.g. /trade-api/v2/markets)
 * @returns {string} base64-encoded signature
 */
function signRequest(privateKeyPem, timestamp, method, path) {
    const message = timestamp + method.toUpperCase() + path;
    const signature = crypto.sign(
        'sha256',
        Buffer.from(message),
        {
            key: privateKeyPem,
            padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
            saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
        }
    );
    return signature.toString('base64');
}

/**
 * Make an authenticated Kalshi API request
 */
async function kalshiFetch(method, path, { apiKeyId, privateKeyPem, body = null } = {}) {
    const timestamp = Date.now().toString();
    const fullPath = '/trade-api/v2' + path;
    const signature = signRequest(privateKeyPem, timestamp, method, fullPath);

    const headers = {
        'KALSHI-ACCESS-KEY': apiKeyId,
        'KALSHI-ACCESS-TIMESTAMP': timestamp,
        'KALSHI-ACCESS-SIGNATURE': signature,
        'Content-Type': 'application/json',
    };

    const opts = { method, headers };
    if (body && method !== 'GET') {
        opts.body = JSON.stringify(body);
    }

    const url = BASE_URL + path;
    const resp = await fetch(url, opts);

    if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`Kalshi API ${resp.status}: ${text.slice(0, 200)}`);
    }

    return resp.json();
}

/**
 * Unauthenticated market data fetch
 */
async function kalshiPublicFetch(path) {
    const resp = await fetch(BASE_URL + path, {
        headers: { 'Content-Type': 'application/json' },
    });
    if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`Kalshi API ${resp.status}: ${text.slice(0, 200)}`);
    }
    return resp.json();
}

// ─── Market Data (public, no auth needed) ───

/**
 * Get active markets with optional filters
 * @param {object} params - { limit, cursor, event_ticker, series_ticker, status }
 * @returns {object} { markets: [...], cursor: string }
 */
export async function getMarkets(params = {}) {
    // Fast path: specific filter or cursor-based pagination (used by markets listing page)
    if (params.series_ticker || params.event_ticker || params.cursor || !params._smartSort) {
        const qs = new URLSearchParams();
        qs.set('mve_filter', 'exclude');
        if (params.limit) qs.set('limit', params.limit);
        if (params.cursor) qs.set('cursor', params.cursor);
        if (params.event_ticker) qs.set('event_ticker', params.event_ticker);
        if (params.series_ticker) qs.set('series_ticker', params.series_ticker);
        if (params.status) qs.set('status', params.status);
        const query = qs.toString();
        return kalshiPublicFetch(`/markets${query ? '?' + query : ''}`);
    }

    // Paginate through /markets to find the most active short-term markets.
    // Default sort returns newest first (mostly dead sports), so we fetch
    // many pages and sort client-side by volume + OI.
    const limit = params.limit || 50;
    const allMarkets = [];
    let cursor = '';
    const maxPages = 5; // 5 pages × 200 = 1000 markets scanned

    for (let i = 0; i < maxPages; i++) {
        const qs = new URLSearchParams();
        qs.set('mve_filter', 'exclude');
        qs.set('limit', '200');
        qs.set('status', 'open');
        if (cursor) qs.set('cursor', cursor);
        const data = await kalshiPublicFetch(`/markets?${qs.toString()}`);
        const batch = data.markets || [];
        allMarkets.push(...batch);
        cursor = data.cursor || '';
        if (batch.length < 200 || !cursor) break;
    }

    // Prefer short-term markets (today/tomorrow), only fall back to longer-term
    const now = Date.now();
    const withExpiry = allMarkets.map(m => {
        const exp = Date.parse(m.expected_expiration_time || m.close_time || '2099-01-01');
        const hours = Math.max(0, (exp - now) / 3600000);
        const activity = parseFloat(m.volume_24h_fp || '0') + parseFloat(m.open_interest_fp || '0');
        return { m, hours, activity };
    });

    // Tier 1: expires within 36h (today/tonight)
    // Tier 2: expires within 72h (tomorrow)
    // Tier 3: everything else (only if not enough short-term)
    const tier1 = withExpiry.filter(x => x.hours <= 36).sort((a, b) => b.activity - a.activity);
    const tier2 = withExpiry.filter(x => x.hours > 36 && x.hours <= 72).sort((a, b) => b.activity - a.activity);
    const tier3 = withExpiry.filter(x => x.hours > 72).sort((a, b) => b.activity - a.activity);

    // Fill from short-term first, then expand if needed
    const picked = [...tier1, ...tier2, ...tier3]
        .filter(x => x.activity > 0) // must have some trading activity
        .slice(0, limit)
        .map(x => x.m);

    // If we couldn't find enough active short-term markets, pad with inactive short-term
    if (picked.length < limit) {
        const inactive = [...tier1, ...tier2].filter(x => x.activity === 0).slice(0, limit - picked.length).map(x => x.m);
        picked.push(...inactive);
    }

    return { markets: picked.slice(0, limit) };
}

/**
 * Get single market by ticker
 */
export async function getMarket(ticker) {
    return kalshiPublicFetch(`/markets/${ticker}`);
}

/**
 * Get order book for a market
 * @returns {object} { orderbook: { yes: [[price, quantity], ...], no: [...] } }
 */
export async function getOrderBook(ticker) {
    return kalshiPublicFetch(`/markets/${ticker}/orderbook`);
}

/**
 * Get events (groups of related markets)
 */
export async function getEvents(params = {}) {
    const qs = new URLSearchParams();
    if (params.limit) qs.set('limit', params.limit);
    if (params.cursor) qs.set('cursor', params.cursor);
    if (params.status) qs.set('status', params.status);
    const query = qs.toString();
    return kalshiPublicFetch(`/events${query ? '?' + query : ''}`);
}

// ─── Trading (auth required) ───

/**
 * Place an order on Kalshi
 * @param {object} order - { ticker, side, action, count, yes_price }
 * @param {object} creds - { apiKeyId, privateKeyPem }
 * @returns {object} order result with order_id, status, etc.
 */
export async function placeOrder(order, creds) {
    const body = {
        ticker: order.ticker,
        side: order.side,       // "yes" or "no"
        action: order.action,   // "buy" or "sell"
        count: order.count,     // number of contracts
        type: order.type || 'limit',
        client_order_id: order.clientOrderId || `bot_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    };

    // Price in cents (1-99)
    if (order.yes_price != null) body.yes_price = order.yes_price;
    if (order.no_price != null) body.no_price = order.no_price;
    if (order.expiration_ts) body.expiration_ts = order.expiration_ts;
    if (order.buy_max_cost != null) body.buy_max_cost = order.buy_max_cost;

    return kalshiFetch('POST', '/portfolio/orders', { ...creds, body });
}

/**
 * Cancel an order
 */
export async function cancelOrder(orderId, creds) {
    return kalshiFetch('DELETE', `/portfolio/orders/${orderId}`, creds);
}

// ─── Portfolio (auth required) ───

/**
 * Get account balance
 * @returns {object} { balance: number (cents), portfolio_value: number (cents) }
 */
export async function getBalance(creds) {
    return kalshiFetch('GET', '/portfolio/balance', creds);
}

/**
 * Get current positions
 * @returns {object} { market_positions: [...] }
 */
export async function getPositions(creds) {
    return kalshiFetch('GET', '/portfolio/positions', creds);
}

/**
 * Get order history
 */
export async function getOrders(creds, params = {}) {
    const qs = new URLSearchParams();
    if (params.ticker) qs.set('ticker', params.ticker);
    if (params.status) qs.set('status', params.status);
    const query = qs.toString();
    return kalshiFetch('GET', `/portfolio/orders${query ? '?' + query : ''}`, creds);
}

// ─── Helpers ───

/**
 * Summarize Kalshi order book into trading-useful format
 */
export function summarizeOrderBook(data) {
    const ob = data?.orderbook;
    if (!ob) return null;

    const yesBids = ob.yes || [];
    const noBids = ob.no || [];

    // Kalshi prices are in cents (1-99)
    const bestYesBid = yesBids.length > 0 ? yesBids[yesBids.length - 1][0] : null;
    const bestNoBid = noBids.length > 0 ? noBids[noBids.length - 1][0] : null;

    // Best ask for YES = 100 - best NO bid (binary market)
    const bestYesAsk = bestNoBid != null ? 100 - bestNoBid : null;
    const spread = (bestYesAsk != null && bestYesBid != null) ? bestYesAsk - bestYesBid : null;

    // Calculate depth
    const yesDepth = yesBids.reduce((sum, [price, qty]) => sum + (price * qty / 100), 0);
    const noDepth = noBids.reduce((sum, [price, qty]) => sum + (price * qty / 100), 0);

    return {
        bestYesBid,     // cents
        bestYesAsk,     // cents
        bestNoBid,      // cents
        spread,         // cents
        spreadPct: bestYesBid > 0 ? (spread / bestYesBid * 100) : null,
        yesDepthUsd: yesDepth,
        noDepthUsd: noDepth,
        depthRatio: noDepth > 0 ? yesDepth / noDepth : null,
        midpoint: (bestYesBid != null && bestYesAsk != null) ? (bestYesBid + bestYesAsk) / 2 : null,
    };
}

/**
 * Convert Kalshi market to a normalized format matching Polymarket structure
 * so the same analysis/monitor code can work with both
 */
export function normalizeMarket(kalshiMarket) {
    const m = kalshiMarket;
    // Kalshi API returns prices as dollar strings with _dollars suffix (e.g. "0.8300")
    // and volumes/OI with _fp suffix (e.g. "1000.00")
    const yesBid = parseFloat(m.yes_bid_dollars) || null;
    const yesAsk = parseFloat(m.yes_ask_dollars) || null;
    const noBid = parseFloat(m.no_bid_dollars) || null;
    const noAsk = parseFloat(m.no_ask_dollars) || null;
    const lastPrice = parseFloat(m.last_price_dollars) || null;
    const volume = parseFloat(m.volume_fp) || 0;
    const volume24h = parseFloat(m.volume_24h_fp) || 0;
    const openInterest = parseFloat(m.open_interest_fp) || 0;

    const yesPrice = yesBid ?? lastPrice ?? 0.5;
    const noPrice = 1 - yesPrice;

    return {
        id: m.ticker,
        question: m.title || m.ticker,
        description: m.subtitle || m.rules_primary || '',
        category: m.category || m.series_ticker || '',
        endDate: m.close_time || m.expiration_time || null,
        volume,
        volume24hr: volume24h,
        liquidity: openInterest,
        outcomes: ['Yes', 'No'],
        outcomePrices: [yesPrice.toString(), noPrice.toString()],
        tokens: [m.ticker],
        exchange: 'kalshi',
        // Kalshi-specific fields (converted to cents for backward compat)
        ticker: m.ticker,
        event_ticker: m.event_ticker,
        yes_bid: yesBid != null ? Math.round(yesBid * 100) : null,
        yes_ask: yesAsk != null ? Math.round(yesAsk * 100) : null,
        no_bid: noBid != null ? Math.round(noBid * 100) : null,
        no_ask: noAsk != null ? Math.round(noAsk * 100) : null,
        last_price: lastPrice != null ? Math.round(lastPrice * 100) : null,
        open_interest: openInterest,
        status: m.status,
    };
}
