// Vercel Serverless Function — Claude market analysis with live context
// Fetches real-time order book, price history, news, and related markets before asking Claude

import { searchNews } from './lib/search.js';

export const config = {
    maxDuration: 30,
};

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Anthropic-Key, X-Brave-Key');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { market, riskLevel = 'moderate' } = req.body;

    if (!market) {
        return res.status(400).json({ error: 'Missing market data' });
    }

    const apiKey = req.headers['x-anthropic-key'] || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        return res.status(400).json({ error: 'No Anthropic API key provided. Set it in Settings or configure ANTHROPIC_API_KEY env var.' });
    }

    try {
        // Parse market data
        const outcomePrices = parseJson(market.outcomePrices, []);
        const outcomes = parseJson(market.outcomes, []);
        const tokens = parseJson(market.clobTokenIds, []);

        // Fetch live context in parallel: order book + price history + news
        const yesTokenId = tokens[0] || '';
        let liveContext = {};

        const searchKeys = {
            braveKey: req.headers['x-brave-key'] || process.env.BRAVE_API_KEY || '',
            googleKey: process.env.GOOGLE_SEARCH_KEY || '',
            googleCx: process.env.GOOGLE_CX || '',
        };

        // Fetch all context in parallel
        const contextPromises = [];

        if (yesTokenId) {
            contextPromises.push(
                fetchSafe(`https://clob.polymarket.com/book?token_id=${yesTokenId}`)
                    .then(summarizeOrderBook)
                    .then(ob => { liveContext.orderBook = ob; })
            );
            contextPromises.push(
                fetchSafe(`https://clob.polymarket.com/prices-history?market=${yesTokenId}&startTs=${Math.floor(Date.now() / 1000) - 86400}&endTs=${Math.floor(Date.now() / 1000)}&fidelity=60`)
                    .then(analyzePriceHistory)
                    .then(ph => { liveContext.priceHistory = ph; })
            );
        }

        // Always search for news (uses free Polymarket search as fallback)
        contextPromises.push(
            searchNews(market.question, searchKeys)
                .then(news => { liveContext.news = news; })
                .catch(() => { liveContext.news = null; })
        );

        await Promise.all(contextPromises);

        // Build enriched prompt
        const outcomeSummary = outcomes.map((name, i) => {
            const price = outcomePrices[i] ? (parseFloat(outcomePrices[i]) * 100).toFixed(1) : '?';
            return `  - ${name}: ${price}% (price: $${outcomePrices[i] || '?'})`;
        }).join('\n');

        const riskInstructions = {
            conservative: 'Only recommend trades where you have HIGH confidence (>75%) that the market is mispriced by at least 10 percentage points. Prefer smaller positions.',
            moderate: 'Recommend trades where you have moderate-to-high confidence the market is mispriced by at least 5-10 percentage points.',
            aggressive: 'Recommend trades even with moderate confidence of 3-5+ percentage point mispricings. Be more willing to take contrarian positions.',
        };

        // Build live data section
        let liveDataSection = '';

        if (liveContext.orderBook) {
            const ob = liveContext.orderBook;
            liveDataSection += `
## Live Order Book (YES token)
- Best Bid: ${ob.bestBid ? (ob.bestBid * 100).toFixed(1) + '¢' : 'N/A'} | Best Ask: ${ob.bestAsk ? (ob.bestAsk * 100).toFixed(1) + '¢' : 'N/A'}
- Spread: ${ob.spread ? (ob.spread * 100).toFixed(2) + '¢' : 'N/A'} (${ob.spreadPct ? ob.spreadPct.toFixed(1) + '%' : 'N/A'})
- Bid Depth: $${ob.bidDepthUsd?.toFixed(0) || '?'} | Ask Depth: $${ob.askDepthUsd?.toFixed(0) || '?'}
- Depth Ratio (bid/ask): ${ob.depthRatio?.toFixed(2) || 'N/A'} ${ob.depthRatio > 1.5 ? '(heavy buying pressure)' : ob.depthRatio < 0.67 ? '(heavy selling pressure)' : '(balanced)'}
`;
        }

        if (liveContext.priceHistory) {
            const ph = liveContext.priceHistory;
            liveDataSection += `
## Price Action (Last 24 Hours)
- Current Price: ${ph.current ? (ph.current * 100).toFixed(1) + '¢' : 'N/A'}
- 24h Change: ${ph.change24h != null ? (ph.change24h > 0 ? '+' : '') + (ph.change24h * 100).toFixed(1) + '¢' : 'N/A'} (${ph.change24hPct != null ? ph.change24hPct.toFixed(1) + '%' : 'N/A'})
- 24h High: ${ph.high24h ? (ph.high24h * 100).toFixed(1) + '¢' : 'N/A'} | 24h Low: ${ph.low24h ? (ph.low24h * 100).toFixed(1) + '¢' : 'N/A'}
- Momentum (6h): ${ph.momentum || 'unknown'}${ph.momentum === 'rising' ? ' — price trending up' : ph.momentum === 'falling' ? ' — price trending down' : ''}
- Volatility: ${ph.volatility24h != null ? (ph.volatility24h < 0.02 ? 'Low' : ph.volatility24h < 0.05 ? 'Moderate' : 'High') + ` (σ=${(ph.volatility24h * 100).toFixed(1)}¢)` : 'N/A'}
`;
        }

        // News section
        if (liveContext.news && liveContext.news.headlines?.length > 0) {
            const news = liveContext.news;
            liveDataSection += `
## Recent News & Context (${news.provider || 'web search'})
${news.headlines.map((h, i) => `- **${h}**${news.snippets[i] ? ` — ${news.snippets[i]}` : ''}${news.sources[i] ? ` (${news.sources[i]})` : ''}`).join('\n')}
`;
        }

        const prompt = `You are an expert prediction market trader. Analyze this Polymarket market using BOTH the static market info AND the live trading data below.

## Market Information
**Question:** ${market.question}
**Description:** ${market.description || 'No description provided'}
**Category:** ${market.groupItemTitle || market.category || 'Unknown'}
**End Date:** ${market.endDate || 'Unknown'}
**Volume:** $${market.volume ? Number(market.volume).toLocaleString() : 'Unknown'}
**24h Volume:** $${market.volume24hr ? Number(market.volume24hr).toLocaleString() : 'Unknown'}
**Liquidity:** $${market.liquidity ? Number(market.liquidity).toLocaleString() : 'Unknown'}

## Current Prices (Market-Implied Probabilities)
${outcomeSummary}
${liveDataSection}
## Risk Tolerance
${riskInstructions[riskLevel] || riskInstructions.moderate}

## Calibration Rules (CRITICAL)
- You are NOT omniscient. Prediction markets aggregate thousands of informed traders. The market price is usually close to correct.
- To find edge, you need SPECIFIC INFORMATION the market hasn't priced in — recent news, a detail in the resolution criteria, or a logical error in how traders are interpreting the question.
- If you don't see a clear, articulable reason the market is wrong, recommend HOLD. "I think X is more likely" without evidence is NOT edge.
- High-volume, high-liquidity markets are the hardest to beat. The more traders, the more efficient the price.
- Base rates matter: "How often does X happen historically?" is more useful than gut feeling.
- If recent news strongly supports one side, check whether the price already moved — the market may have already priced it in.
- Be honest about your uncertainty. Saying "I don't know" is better than a bad trade.

## Your Task
1. **Read the news** — does any recent information change the probability vs what was known when the market price was set?
2. **Read the tape** — what does the price action, momentum, and order book tell you? Is smart money moving in one direction?
3. **Estimate** your own probability, anchoring on the market price and adjusting ONLY if you have specific evidence
4. **Compare** your estimate vs the market price — is there genuine edge, or are you just disagreeing without evidence?
5. **Recommend** HOLD unless you have a clear, evidence-backed reason the market is wrong

## Response Format
Respond with this exact structure:

### Key Factors
[2-4 bullet points on what drives this outcome]

### News & Context
[What does the recent news tell you? Has this information already been priced in? Any new developments?]

### Live Data Read
[What the order book and price action tell you — is this market efficient? Where is the smart money? Any unusual patterns?]

### Probability Estimate
[Your estimated probability for each outcome. Start from the market price and explain what specific evidence moves you away from it — or why the market is correct.]

### Market Edge
[Where you see mispricing, if any — account for the spread and execution costs. Be specific about WHY the market is wrong, not just that you disagree.]

### Recommendation
**Action:** [BUY YES / BUY NO / HOLD — no trade]
**Confidence:** [Low / Medium / High]
**Edge:** [Estimated edge in percentage points, AFTER spread costs, or 0 if HOLD]
**Reasoning:** [1-2 sentences citing specific evidence]
**Suggested Size:** [Small (5-10%) / Medium (15-25%) / Large (30-50%) of max position]`;

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 2000,
                messages: [{ role: 'user', content: prompt }],
            }),
        });

        if (!response.ok) {
            const errBody = await response.text();
            console.error('Anthropic API error:', response.status, errBody);
            return res.status(502).json({ error: `Claude API error: ${response.status}` });
        }

        const data = await response.json();
        const content = data.content?.[0]?.text || 'No analysis generated';
        const recommendation = parseRecommendation(content);

        return res.status(200).json({
            analysis: content,
            recommendation,
            liveContext,
            usage: data.usage,
        });

    } catch (error) {
        console.error('Analysis error:', error);
        return res.status(500).json({ error: error.message || 'Analysis failed' });
    }
}

// Helpers

function parseJson(val, fallback) {
    if (Array.isArray(val)) return val;
    if (typeof val === 'string') {
        try { return JSON.parse(val); } catch { return fallback; }
    }
    return fallback;
}

async function fetchSafe(url) {
    try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        return resp.json();
    } catch {
        return null;
    }
}

function summarizeOrderBook(book) {
    if (!book) return null;
    const bids = (book.bids || []).slice(0, 10);
    const asks = (book.asks || []).slice(0, 10);

    const bidDepth = bids.reduce((s, b) => s + parseFloat(b.size || 0), 0);
    const askDepth = asks.reduce((s, a) => s + parseFloat(a.size || 0), 0);
    const bestBid = bids[0] ? parseFloat(bids[0].price) : null;
    const bestAsk = asks[0] ? parseFloat(asks[0].price) : null;
    const spread = bestBid && bestAsk ? bestAsk - bestBid : null;
    const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;

    return {
        bestBid, bestAsk, mid, spread,
        spreadPct: mid ? (spread / mid) * 100 : null,
        bidDepthUsd: bidDepth,
        askDepthUsd: askDepth,
        depthRatio: askDepth > 0 ? bidDepth / askDepth : null,
    };
}

function analyzePriceHistory(data) {
    if (!data) return null;
    const history = data.history || data || [];
    if (!Array.isArray(history) || history.length === 0) return null;

    const prices = history.map(p => parseFloat(p.p));
    const current = prices[prices.length - 1];
    const dayAgo = prices[0];
    const change24h = current - dayAgo;

    // High/low
    const high24h = Math.max(...prices);
    const low24h = Math.min(...prices);

    // Momentum: compare first third vs last third of last 6 hours
    const sixHoursIdx = Math.max(0, history.length - Math.floor(history.length / 4));
    const recentPrices = prices.slice(sixHoursIdx);
    let momentum = 'flat';
    if (recentPrices.length >= 3) {
        const thirdLen = Math.floor(recentPrices.length / 3);
        const avgFirst = recentPrices.slice(0, thirdLen).reduce((s, p) => s + p, 0) / thirdLen;
        const avgLast = recentPrices.slice(-thirdLen).reduce((s, p) => s + p, 0) / thirdLen;
        const diff = avgLast - avgFirst;
        if (diff > 0.02) momentum = 'rising';
        else if (diff < -0.02) momentum = 'falling';
    }

    // Volatility
    const mean = prices.reduce((s, p) => s + p, 0) / prices.length;
    const variance = prices.reduce((s, p) => s + (p - mean) ** 2, 0) / prices.length;
    const volatility24h = Math.sqrt(variance);

    return {
        current,
        change24h,
        change24hPct: dayAgo ? (change24h / dayAgo) * 100 : null,
        high24h,
        low24h,
        momentum,
        volatility24h,
        candles: history.slice(-48).map(p => ({ t: p.t, p: parseFloat(p.p) })),
    };
}

function parseRecommendation(text) {
    const rec = { action: 'HOLD', confidence: 'Low', reasoning: '', suggestedSize: 'Small' };

    const actionMatch = text.match(/\*\*Action:\*\*\s*(BUY YES|BUY NO|HOLD[^*]*)/i);
    if (actionMatch) rec.action = actionMatch[1].trim().toUpperCase();

    const confMatch = text.match(/\*\*Confidence:\*\*\s*(Low|Medium|High)/i);
    if (confMatch) rec.confidence = confMatch[1];

    const reasonMatch = text.match(/\*\*Reasoning:\*\*\s*(.+?)(?:\n|$)/i);
    if (reasonMatch) rec.reasoning = reasonMatch[1].trim();

    const sizeMatch = text.match(/\*\*Suggested Size:\*\*\s*(Small|Medium|Large)/i);
    if (sizeMatch) rec.suggestedSize = sizeMatch[1];

    return rec;
}
