// Vercel Serverless Function — Autonomous Trading Loop with Live Data
//
// 1. Fetches top markets from Gamma API
// 2. For each candidate: fetches live order book + price history from CLOB
// 3. Claude analyzes with full live context (not just static snapshots)
// 4. Executes trades using Kelly-informed sizing
// 5. Enforces portfolio-level risk limits

import { ethers } from 'ethers';
import { buildMarketOrder, signOrder, submitOrder, getMidpoint } from './lib/clob.js';
import { searchNews } from './lib/search.js';

export const config = {
    maxDuration: 60,
};

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Anthropic-Key, X-Brave-Key, X-Poly-Api-Key, X-Poly-Secret, X-Poly-Passphrase, X-Poly-Private-Key');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const {
        budget = 100,
        spent = 0,
        maxPerTrade = 25,
        riskLevel = 'moderate',
        marketsToScan = 10,
        existingPositions = [],
        dryRun = false,
    } = req.body;

    const anthropicKey = req.headers['x-anthropic-key'] || process.env.ANTHROPIC_API_KEY;
    const polyApiKey = req.headers['x-poly-api-key'] || process.env.POLYMARKET_API_KEY;
    const polySecret = req.headers['x-poly-secret'] || process.env.POLYMARKET_API_SECRET;
    const polyPassphrase = req.headers['x-poly-passphrase'] || process.env.POLYMARKET_PASSPHRASE;
    const polyPrivateKey = req.headers['x-poly-private-key'] || process.env.POLYMARKET_PRIVATE_KEY;

    if (!anthropicKey) {
        return res.status(400).json({ error: 'Anthropic API key required for autonomous trading' });
    }

    const remaining = budget - spent;
    if (remaining < 1) {
        return res.status(200).json({ message: 'Budget exhausted', budget, spent, remaining: 0, trades: [] });
    }

    const hasLiveCreds = !!(polyApiKey && polySecret && polyPassphrase && polyPrivateKey);
    const report = {
        startedAt: new Date().toISOString(),
        budget, spent, remaining,
        marketsScanned: 0, marketsAnalyzed: 0, tradesExecuted: 0, totalSpent: 0,
        trades: [], analyses: [], errors: [],
        live: hasLiveCreds && !dryRun,
    };

    try {
        // Step 1: Fetch top markets
        const markets = await fetchTopMarkets(marketsToScan);
        report.marketsScanned = markets.length;

        // Step 2: Filter
        const candidates = markets.filter(m => {
            const tokens = parseJsonSafe(m.clobTokenIds, []);
            const hasPosition = tokens.some(t => existingPositions.includes(t));
            const liquidity = parseFloat(m.liquidity || 0);
            return !hasPosition && liquidity >= 5000;
        });

        // Step 3: Analyze each with live data (max 5 per run)
        const toAnalyze = candidates.slice(0, Math.min(5, candidates.length));
        let budgetLeft = remaining;

        // Portfolio-level risk: max 40% of budget in any single market
        const maxSingleMarketPct = 0.4;
        // Max number of trades per bot run
        const maxTradesPerRun = 3;

        for (const market of toAnalyze) {
            if (budgetLeft < 1 || report.tradesExecuted >= maxTradesPerRun) break;

            try {
                // Fetch live context + news before analysis
                const tokens = parseJsonSafe(market.clobTokenIds, []);
                const yesTokenId = tokens[0] || '';

                const searchKeys = {
                    braveKey: req.headers['x-brave-key'] || process.env.BRAVE_API_KEY || '',
                    googleKey: process.env.GOOGLE_SEARCH_KEY || '',
                    googleCx: process.env.GOOGLE_CX || '',
                };

                const [liveContext, newsContext] = await Promise.all([
                    yesTokenId ? fetchLiveContext(yesTokenId) : Promise.resolve({}),
                    searchNews(market.question, searchKeys).catch(() => null),
                ]);
                liveContext.news = newsContext;

                const analysis = await analyzeWithClaude(market, anthropicKey, riskLevel, budgetLeft, maxPerTrade, liveContext);
                report.marketsAnalyzed++;
                report.analyses.push({
                    market: market.question,
                    marketId: market.id,
                    recommendation: analysis.recommendation,
                    liveData: liveContext.summary || null,
                });

                const rec = analysis.recommendation;
                if (shouldExecute(rec, riskLevel)) {
                    // Kelly-informed position sizing
                    const tradeAmount = calculateKellySize(rec, budgetLeft, maxPerTrade, budget, maxSingleMarketPct);

                    if (tradeAmount >= 1) {
                        const prices = parseJsonSafe(market.outcomePrices, []);
                        const isYes = rec.action.includes('YES');
                        const tokenIdx = isYes ? 0 : 1;
                        const tokenId = tokens[tokenIdx] || '';
                        const price = prices[tokenIdx] ? parseFloat(prices[tokenIdx]) : 0.5;

                        // Check spread is acceptable (< 5% for auto-trades)
                        const ob = liveContext.orderBook;
                        if (ob && ob.spreadPct > 5) {
                            report.analyses[report.analyses.length - 1].skipped = 'spread too wide';
                            continue;
                        }

                        const trade = await executeTrade({
                            tokenId, side: 'BUY', amount: tradeAmount, price,
                            negRisk: market.negRisk || false,
                            market, outcome: isYes ? 'Yes' : 'No',
                            hasLiveCreds, dryRun,
                            polyApiKey, polySecret, polyPassphrase, polyPrivateKey,
                        });

                        report.trades.push(trade);
                        report.tradesExecuted++;
                        report.totalSpent += tradeAmount;
                        budgetLeft -= tradeAmount;
                    }
                }
            } catch (err) {
                report.errors.push({ market: market.question, error: err.message });
            }
        }

        report.remaining = budgetLeft;
        report.completedAt = new Date().toISOString();
        return res.status(200).json(report);

    } catch (error) {
        console.error('Auto-trade loop error:', error);
        report.errors.push({ error: error.message });
        return res.status(500).json(report);
    }
}

// ── Data Fetching ──────────────────────────────────────────

/**
 * Fetch the most active Polymarket markets sorted by 24h volume.
 * @param {number} limit - Maximum number of markets to return
 * @returns {Promise<Array<object>>} Array of Gamma API market objects
 * @throws {Error} If the Gamma API request fails
 */
async function fetchTopMarkets(limit) {
    const resp = await fetch(
        `https://gamma-api.polymarket.com/markets?limit=${limit}&active=true&closed=false&order=volume24hr&ascending=false`
    );
    if (!resp.ok) throw new Error(`Gamma API error: ${resp.status}`);
    return resp.json();
}

/**
 * Fetch live order book and 24h price history for a Polymarket token.
 * Computes spread, depth, momentum, and volatility metrics.
 * @param {string} tokenId - CLOB token ID for the YES outcome
 * @returns {Promise<{orderBook?: object, priceHistory?: object, summary: string}>}
 */
async function fetchLiveContext(tokenId) {
    const now = Math.floor(Date.now() / 1000);
    const oneDayAgo = now - 86400;

    const [bookResp, histResp] = await Promise.all([
        fetchSafe(`https://clob.polymarket.com/book?token_id=${tokenId}`),
        fetchSafe(`https://clob.polymarket.com/prices-history?market=${tokenId}&startTs=${oneDayAgo}&endTs=${now}&fidelity=60`),
    ]);

    const result = {};

    // Summarize order book
    if (bookResp) {
        const bids = (bookResp.bids || []).slice(0, 10);
        const asks = (bookResp.asks || []).slice(0, 10);
        const bidDepth = bids.reduce((s, b) => s + parseFloat(b.size || 0), 0);
        const askDepth = asks.reduce((s, a) => s + parseFloat(a.size || 0), 0);
        const bestBid = bids[0] ? parseFloat(bids[0].price) : null;
        const bestAsk = asks[0] ? parseFloat(asks[0].price) : null;
        const spread = bestBid && bestAsk ? bestAsk - bestBid : null;
        const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;

        result.orderBook = {
            bestBid, bestAsk, mid, spread,
            spreadPct: mid ? (spread / mid) * 100 : null,
            bidDepthUsd: bidDepth, askDepthUsd: askDepth,
            depthRatio: askDepth > 0 ? bidDepth / askDepth : null,
        };
    }

    // Analyze price history
    if (histResp) {
        const history = histResp.history || histResp || [];
        if (Array.isArray(history) && history.length > 0) {
            const prices = history.map(p => parseFloat(p.p));
            const current = prices[prices.length - 1];
            const dayAgo = prices[0];

            // Momentum
            const recent = prices.slice(-Math.floor(prices.length / 4));
            let momentum = 'flat';
            if (recent.length >= 3) {
                const thirdLen = Math.floor(recent.length / 3);
                const avgFirst = recent.slice(0, thirdLen).reduce((s, p) => s + p, 0) / thirdLen;
                const avgLast = recent.slice(-thirdLen).reduce((s, p) => s + p, 0) / thirdLen;
                if (avgLast - avgFirst > 0.02) momentum = 'rising';
                else if (avgLast - avgFirst < -0.02) momentum = 'falling';
            }

            // Volatility
            const mean = prices.reduce((s, p) => s + p, 0) / prices.length;
            const variance = prices.reduce((s, p) => s + (p - mean) ** 2, 0) / prices.length;

            result.priceHistory = {
                current,
                change24h: current - dayAgo,
                high24h: Math.max(...prices),
                low24h: Math.min(...prices),
                momentum,
                volatility: Math.sqrt(variance),
            };
        }
    }

    // Compact summary for logging
    const ob = result.orderBook;
    const ph = result.priceHistory;
    result.summary = [
        ob ? `spread=${ob.spreadPct?.toFixed(1)}%` : null,
        ob ? `depth=${ob.bidDepthUsd?.toFixed(0)}/${ob.askDepthUsd?.toFixed(0)}` : null,
        ph ? `momentum=${ph.momentum}` : null,
        ph ? `vol=${ph.volatility?.toFixed(3)}` : null,
    ].filter(Boolean).join(' ');

    return result;
}

async function fetchSafe(url) {
    try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        return resp.json();
    } catch { return null; }
}

// ── Claude Analysis ────────────────────────────────────────

async function analyzeWithClaude(market, apiKey, riskLevel, budgetLeft, maxPerTrade, liveContext) {
    const outcomePrices = parseJsonSafe(market.outcomePrices, []);
    const outcomes = parseJsonSafe(market.outcomes, []);

    const outcomeSummary = outcomes.map((name, i) => {
        const price = outcomePrices[i] ? (parseFloat(outcomePrices[i]) * 100).toFixed(1) : '?';
        return `  - ${name}: ${price}%`;
    }).join('\n');

    const riskMap = {
        conservative: 'Only trade with >75% confidence and >10pt edge. Small positions only.',
        moderate: 'Trade with moderate-high confidence and >5pt edge.',
        aggressive: 'Trade with moderate confidence and >3pt edge. Larger positions OK.',
    };

    // Build live data section
    let liveSection = '';
    const ob = liveContext?.orderBook;
    const ph = liveContext?.priceHistory;

    if (ob) {
        liveSection += `\n## Live Order Book
- Bid: ${ob.bestBid ? (ob.bestBid * 100).toFixed(1) + '¢' : '?'} | Ask: ${ob.bestAsk ? (ob.bestAsk * 100).toFixed(1) + '¢' : '?'} | Spread: ${ob.spreadPct ? ob.spreadPct.toFixed(1) + '%' : '?'}
- Bid depth: $${ob.bidDepthUsd?.toFixed(0) || '?'} | Ask depth: $${ob.askDepthUsd?.toFixed(0) || '?'}
- Depth ratio: ${ob.depthRatio?.toFixed(2) || '?'} ${ob.depthRatio > 1.5 ? '(buying pressure)' : ob.depthRatio < 0.67 ? '(selling pressure)' : '(balanced)'}`;
    }

    if (ph) {
        liveSection += `\n## 24h Price Action
- Current: ${(ph.current * 100).toFixed(1)}¢ | Change: ${ph.change24h > 0 ? '+' : ''}${(ph.change24h * 100).toFixed(1)}¢
- High: ${(ph.high24h * 100).toFixed(1)}¢ | Low: ${(ph.low24h * 100).toFixed(1)}¢
- Momentum: ${ph.momentum} | Volatility: ${ph.volatility < 0.02 ? 'low' : ph.volatility < 0.05 ? 'moderate' : 'high'}`;
    }

    // News section
    const news = liveContext?.news;
    if (news && news.headlines?.length > 0) {
        liveSection += `\n## Recent News
${news.headlines.map((h, i) => `- ${h}${news.snippets?.[i] ? ': ' + news.snippets[i] : ''}`).join('\n')}`;
    }

    const prompt = `You are an autonomous prediction market trading bot managing $${budgetLeft.toFixed(0)} remaining (max $${maxPerTrade}/trade). Analyze this market using the live data AND recent news.

## Market
**Question:** ${market.question}
**Description:** ${market.description || 'N/A'}
**End Date:** ${market.endDate || 'Unknown'}
**Volume:** $${formatNum(market.volume)} | **24h Vol:** $${formatNum(market.volume24hr)} | **Liquidity:** $${formatNum(market.liquidity)}

## Prices
${outcomeSummary}
${liveSection}

## Calibration
- The market price reflects thousands of informed traders. It is usually approximately correct.
- Only trade when you have SPECIFIC evidence (from news, data, or logic) that the market is wrong.
- "I think X is more likely" without evidence is NOT edge. Recommend HOLD.
- If news supports one side, the price may have ALREADY moved — check the 24h change.
- High-volume markets are the hardest to beat. Be honest about uncertainty.

## Rules
${riskMap[riskLevel] || riskMap.moderate}
- You MUST be selective. Only trade when you see genuine mispricing backed by evidence.
- Factor in: spread cost, order book depth, momentum, and whether news is already priced in.
- If the spread is >3%, that eats into your edge — account for it.
- If momentum conflicts with your thesis, reduce confidence.

## Response (JSON only)
{
  "action": "BUY YES" | "BUY NO" | "HOLD",
  "confidence": "Low" | "Medium" | "High",
  "edgePercent": <your estimated edge in percentage points AFTER spread costs>,
  "reasoning": "<2-3 sentences including what the live data tells you>",
  "suggestedSize": "Small" | "Medium" | "Large",
  "myProbability": <0-100>,
  "spreadAdjustedEdge": <edge minus half the spread>
}`;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 600,
            messages: [{ role: 'user', content: prompt }],
        }),
    });

    if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`Claude API error: ${resp.status} - ${err}`);
    }

    const data = await resp.json();
    const text = data.content?.[0]?.text || '{}';

    let recommendation;
    try {
        const jsonStr = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
        recommendation = JSON.parse(jsonStr);
    } catch {
        recommendation = { action: 'HOLD', confidence: 'Low', reasoning: 'Failed to parse', edgePercent: 0 };
    }

    return { recommendation, usage: data.usage };
}

// ── Trade Execution Logic ──────────────────────────────────

/**
 * Determine whether a Claude recommendation meets the threshold for execution
 * based on the user's risk tolerance. Uses spread-adjusted edge when available.
 *
 * @param {object} rec - Claude's recommendation (action, confidence, edgePercent, spreadAdjustedEdge)
 * @param {'conservative'|'moderate'|'aggressive'} riskLevel - User's risk setting
 * @returns {boolean} true if the trade should be executed
 */
function shouldExecute(rec, riskLevel) {
    if (!rec || rec.action === 'HOLD') return false;

    // Use spread-adjusted edge when available
    const edge = Math.abs(rec.spreadAdjustedEdge || rec.edgePercent || 0);
    const conf = (rec.confidence || '').toLowerCase();

    if (riskLevel === 'conservative') return conf === 'high' && edge >= 10;
    if (riskLevel === 'moderate') return (conf === 'high' || conf === 'medium') && edge >= 5;
    return conf !== 'low' && edge >= 3; // aggressive
}

/**
 * Calculate position size using half-Kelly criterion with confidence scaling.
 *
 * Kelly fraction: f* = (bp - q) / b, where b = payout odds, p = probability, q = 1-p
 * Half-Kelly is used for safety (reduces variance at cost of ~25% expected growth).
 * The result is further scaled by confidence level and capped by portfolio limits.
 *
 * @param {object} rec - Recommendation with myProbability, spreadAdjustedEdge, confidence
 * @param {number} budgetLeft - Remaining USDC budget for this session
 * @param {number} maxPerTrade - Maximum USDC per individual trade
 * @param {number} totalBudget - Total portfolio budget (for percentage caps)
 * @param {number} maxSinglePct - Maximum fraction of total budget in a single market (0-1)
 * @returns {number} Trade amount in USDC (integer, may be 0)
 */
function calculateKellySize(rec, budgetLeft, maxPerTrade, totalBudget, maxSinglePct) {
    const prob = (rec.myProbability || 50) / 100;
    const edge = Math.abs(rec.spreadAdjustedEdge || rec.edgePercent || 0) / 100;

    // Kelly fraction: f* = (bp - q) / b where b = odds, p = prob, q = 1-p
    // For binary markets with cost = price: simplified Kelly
    // Use half-Kelly for safety
    const price = prob; // approximate
    const odds = (1 / price) - 1; // payout odds
    const kellyFraction = odds > 0 ? ((odds * prob - (1 - prob)) / odds) : 0;
    const halfKelly = Math.max(0, kellyFraction / 2);

    // Constrain by confidence
    const confMultiplier = rec.confidence === 'High' ? 1.0 : rec.confidence === 'Medium' ? 0.6 : 0.3;

    // Start with Kelly-based size, constrained by maxPerTrade
    let amount = Math.round(maxPerTrade * Math.min(halfKelly * 10, 1) * confMultiplier);

    // Enforce portfolio-level cap
    const maxSingle = totalBudget * maxSinglePct;
    amount = Math.min(amount, maxPerTrade, budgetLeft, maxSingle);
    amount = Math.max(amount, 0);

    return amount;
}

async function executeTrade(params) {
    const {
        tokenId, side, amount, price, negRisk, market, outcome,
        hasLiveCreds, dryRun,
        polyApiKey, polySecret, polyPassphrase, polyPrivateKey,
    } = params;

    const shares = amount / price;

    const tradeRecord = {
        id: `auto_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        tokenId, side, amount, price, shares,
        market: market.question,
        marketId: market.id,
        outcome,
        endDate: market.endDate || null,
        timestamp: new Date().toISOString(),
        auto: true,
    };

    if (dryRun) {
        tradeRecord.status = 'dry_run';
        tradeRecord.live = false;
        return tradeRecord;
    }

    if (hasLiveCreds) {
        try {
            let tradePrice;
            try {
                tradePrice = await getMidpoint(tokenId);
            } catch {
                tradePrice = price;
            }

            // 2% slippage for auto-trades
            const slippagePrice = Math.min(tradePrice * 1.02, 0.99);

            const order = buildMarketOrder({
                tokenId, side, amount, price: slippagePrice, negRisk,
            });

            const signed = await signOrder(order, polyPrivateKey, negRisk);
            const signerAddress = new ethers.Wallet(polyPrivateKey).address;
            const result = await submitOrder(signed, polyApiKey, polySecret, polyPassphrase, signerAddress);

            tradeRecord.status = result.status || 'submitted';
            tradeRecord.live = true;
            tradeRecord.clobOrderId = result.orderID || result.id;
            tradeRecord.executedPrice = tradePrice;
            tradeRecord.shares = amount / tradePrice;
        } catch (err) {
            tradeRecord.status = 'failed';
            tradeRecord.error = err.message;
            tradeRecord.live = false;
        }
    } else {
        tradeRecord.status = 'paper';
        tradeRecord.live = false;
    }

    return tradeRecord;
}

// ── Utilities ──────────────────────────────────────────────

function parseJsonSafe(val, fallback) {
    if (Array.isArray(val)) return val;
    if (typeof val === 'string') {
        try { return JSON.parse(val); } catch { return fallback; }
    }
    return fallback;
}

function formatNum(n) {
    const num = parseFloat(n || 0);
    if (num >= 1e6) return (num / 1e6).toFixed(1) + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(0) + 'K';
    return num.toFixed(0);
}
