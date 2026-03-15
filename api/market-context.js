// Vercel Serverless Function — Fetch rich, real-time market context
// Combines: CLOB order book, price history (timeseries), and recent news
// Used by Claude analysis to make actually-informed decisions

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const { tokenId, conditionId, slug } = req.query;
    if (!tokenId && !conditionId && !slug) {
        return res.status(400).json({ error: 'tokenId, conditionId, or slug required' });
    }

    const result = {};

    // Fetch all data sources in parallel
    const tasks = [];

    // 1. CLOB order book (shows depth, where liquidity sits)
    if (tokenId) {
        tasks.push(
            fetchOrderBook(tokenId)
                .then(book => { result.orderBook = book; })
                .catch(e => { result.orderBookError = e.message; })
        );

        // 2. CLOB price history — recent trades and price timeseries
        tasks.push(
            fetchPriceHistory(tokenId)
                .then(history => { result.priceHistory = history; })
                .catch(e => { result.priceHistoryError = e.message; })
        );
    }

    // 3. Market activity data from Gamma (includes resolution source, tags, etc.)
    if (slug || conditionId) {
        tasks.push(
            fetchMarketActivity(slug, conditionId)
                .then(activity => { result.activity = activity; })
                .catch(e => { result.activityError = e.message; })
        );
    }

    await Promise.all(tasks);

    return res.status(200).json(result);
}

async function fetchOrderBook(tokenId) {
    const resp = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
    if (!resp.ok) throw new Error(`Order book fetch failed: ${resp.status}`);
    const book = await resp.json();

    // Summarize depth
    const bids = (book.bids || []).slice(0, 10);
    const asks = (book.asks || []).slice(0, 10);

    const bidDepth = bids.reduce((sum, b) => sum + parseFloat(b.size || 0), 0);
    const askDepth = asks.reduce((sum, a) => sum + parseFloat(a.size || 0), 0);
    const bestBid = bids[0] ? parseFloat(bids[0].price) : null;
    const bestAsk = asks[0] ? parseFloat(asks[0].price) : null;
    const spread = bestBid && bestAsk ? bestAsk - bestBid : null;
    const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;

    return {
        bestBid,
        bestAsk,
        mid,
        spread,
        spreadPct: mid ? ((spread / mid) * 100) : null,
        bidDepthUsd: bidDepth,
        askDepthUsd: askDepth,
        depthRatio: askDepth > 0 ? (bidDepth / askDepth) : null,
        topBids: bids.slice(0, 5).map(b => ({ price: b.price, size: b.size })),
        topAsks: asks.slice(0, 5).map(a => ({ price: a.price, size: a.size })),
    };
}

async function fetchPriceHistory(tokenId) {
    // Polymarket CLOB provides timeseries via /prices-history endpoint
    const now = Math.floor(Date.now() / 1000);
    const oneDayAgo = now - 86400;
    const oneWeekAgo = now - 604800;

    // Fetch 1-day and 1-week timeseries in parallel
    const [day, week] = await Promise.all([
        fetchTimeseries(tokenId, oneDayAgo, now, 60),   // 1-min candles for 24h
        fetchTimeseries(tokenId, oneWeekAgo, now, 360),  // 6-min candles for 7d
    ]);

    // Compute price changes
    const current = day.length > 0 ? parseFloat(day[day.length - 1].p) : null;
    const dayAgo = day.length > 0 ? parseFloat(day[0].p) : null;
    const weekAgo = week.length > 0 ? parseFloat(week[0].p) : null;

    const change24h = current && dayAgo ? current - dayAgo : null;
    const change7d = current && weekAgo ? current - weekAgo : null;

    // Detect momentum: is price trending up or down over last 6 hours?
    const sixHoursAgo = now - 21600;
    const recentPrices = day.filter(p => p.t >= sixHoursAgo);
    let momentum = 'flat';
    if (recentPrices.length >= 3) {
        const firstThird = recentPrices.slice(0, Math.floor(recentPrices.length / 3));
        const lastThird = recentPrices.slice(-Math.floor(recentPrices.length / 3));
        const avgFirst = firstThird.reduce((s, p) => s + parseFloat(p.p), 0) / firstThird.length;
        const avgLast = lastThird.reduce((s, p) => s + parseFloat(p.p), 0) / lastThird.length;
        const diff = avgLast - avgFirst;
        if (diff > 0.02) momentum = 'rising';
        else if (diff < -0.02) momentum = 'falling';
    }

    // Detect volatility: standard deviation of 24h prices
    let volatility = null;
    if (day.length > 5) {
        const prices = day.map(p => parseFloat(p.p));
        const mean = prices.reduce((s, p) => s + p, 0) / prices.length;
        const variance = prices.reduce((s, p) => s + (p - mean) ** 2, 0) / prices.length;
        volatility = Math.sqrt(variance);
    }

    // High/low over 24h
    const dayPrices = day.map(p => parseFloat(p.p));
    const high24h = dayPrices.length > 0 ? Math.max(...dayPrices) : null;
    const low24h = dayPrices.length > 0 ? Math.min(...dayPrices) : null;

    return {
        current,
        change24h,
        change24hPct: dayAgo ? ((change24h / dayAgo) * 100) : null,
        change7d,
        change7dPct: weekAgo ? ((change7d / weekAgo) * 100) : null,
        high24h,
        low24h,
        momentum,
        volatility24h: volatility,
        dataPoints24h: day.length,
        dataPoints7d: week.length,
        // Include recent candles for the frontend chart
        candles24h: day.slice(-48).map(p => ({ t: p.t, p: parseFloat(p.p) })),
        candles7d: week.slice(-28).map(p => ({ t: p.t, p: parseFloat(p.p) })),
    };
}

async function fetchTimeseries(tokenId, startTs, endTs, interval) {
    try {
        const url = `https://clob.polymarket.com/prices-history?market=${tokenId}&startTs=${startTs}&endTs=${endTs}&fidelity=${interval}`;
        const resp = await fetch(url);
        if (!resp.ok) return [];
        const data = await resp.json();
        return data.history || data || [];
    } catch {
        return [];
    }
}

async function fetchMarketActivity(slug, conditionId) {
    try {
        let url;
        if (slug) {
            url = `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`;
        } else {
            url = `https://gamma-api.polymarket.com/markets?condition_id=${encodeURIComponent(conditionId)}`;
        }
        const resp = await fetch(url);
        if (!resp.ok) return null;
        const data = await resp.json();
        const market = Array.isArray(data) ? data[0] : data;
        if (!market) return null;

        return {
            resolutionSource: market.resolutionSource || null,
            tags: market.tags || [],
            startDate: market.startDate,
            endDate: market.endDate,
            enableOrderBook: market.enableOrderBook,
            active: market.active,
            closed: market.closed,
            acceptingOrders: market.acceptingOrders,
            volumeTotal: market.volume,
            volume24hr: market.volume24hr,
            liquidityTotal: market.liquidity,
            commentCount: market.commentCount || 0,
        };
    } catch {
        return null;
    }
}
