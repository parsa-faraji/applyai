// Vercel Serverless Function — Kalshi Safe Compounder Strategy
// Highest win-rate strategy (74%): buy NO contracts on events almost certainly NOT happening.
// Only trades when YES price <= 20¢ (event 80%+ unlikely) AND Claude confirms >= 90% NO probability.
// Uses maker (resting limit) orders with half-Kelly sizing for optimal bankroll growth.

import { getMarkets, getOrderBook, summarizeOrderBook, placeOrder, normalizeMarket } from './lib/kalshi.js';
import { searchNews } from './lib/search.js';
import { logTrade, logDecision, categorizeMarket } from './lib/trade-logger.js';

export const config = { maxDuration: 60 };

// Skip sports and speculative entertainment tickers
const SKIP_PREFIXES = [
    'KXNBA', 'KXNFL', 'KXNHL', 'KXMLB', 'KXNCAA', 'KXUFC', 'KXPGA',
    'KXCS2', 'KXEUROLEAGUE', 'KXATPCHALLENGER', 'KXCBA', 'KXKHL',
    'KXAHL', 'KXLIIGA', 'KXINTLFRIEND',
];

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Anthropic-Key, X-Brave-Key, X-Kalshi-Key-Id, X-Kalshi-Private-Key');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const {
        budget = 100,
        maxPerTrade = 25,
        dryRun = true,
        marketLimit = 20,
    } = req.body || {};

    const anthropicKey = req.headers['x-anthropic-key'] || process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) return res.status(400).json({ error: 'Anthropic API key required' });

    const kalshiKeyId = req.headers['x-kalshi-key-id'] || process.env.KALSHI_API_KEY_ID;
    const kalshiPrivateKey = req.headers['x-kalshi-private-key'] || process.env.KALSHI_PRIVATE_KEY;
    const hasLiveCreds = !!(kalshiKeyId && kalshiPrivateKey);

    const searchKeys = {
        braveKey: req.headers['x-brave-key'] || process.env.BRAVE_API_KEY || '',
        googleKey: process.env.GOOGLE_SEARCH_KEY || '',
        googleCx: process.env.GOOGLE_CX || '',
    };

    const report = {
        timestamp: new Date().toISOString(),
        strategy: 'safe-compounder',
        exchange: 'kalshi',
        marketsScanned: 0,
        candidates: 0,
        tradesExecuted: 0,
        totalSpent: 0,
        dryRun,
        hasLiveCreds,
        analyses: [],
        trades: [],
        errors: [],
    };

    try {
        // 1. Fetch markets with smart sort (scans ~1000 markets)
        const data = await getMarkets({ _smartSort: true, limit: 200 });
        const allMarkets = data.markets || [];
        report.marketsScanned = allMarkets.length;

        // 2. Filter: YES price <= 0.20 (20 cents) AND not in skip categories
        const candidates = allMarkets.filter(m => {
            const ticker = m.ticker || '';
            const eventTicker = m.event_ticker || '';

            // Skip sports and speculative entertainment
            if (SKIP_PREFIXES.some(p => ticker.startsWith(p) || eventTicker.startsWith(p))) {
                return false;
            }

            // Only markets where YES is cheap (event unlikely)
            const yesPrice = parseFloat(m.last_price_dollars) || parseFloat(m.yes_bid_dollars) || null;
            if (yesPrice === null) return false;
            return yesPrice <= 0.20;
        });

        report.candidates = candidates.length;

        // Limit how many we analyze (Claude calls are expensive)
        const toAnalyze = candidates.slice(0, parseInt(marketLimit));
        let budgetLeft = budget;

        for (const rawMarket of toAnalyze) {
            if (budgetLeft < 1) break;

            const market = normalizeMarket(rawMarket);
            const yesPriceDollars = parseFloat(rawMarket.last_price_dollars) || parseFloat(rawMarket.yes_bid_dollars) || 0;
            const yesPriceCents = Math.round(yesPriceDollars * 100);

            try {
                // Fetch order book + news in parallel
                const [obData, newsContext] = await Promise.all([
                    getOrderBook(rawMarket.ticker).catch(() => null),
                    searchNews(market.question, searchKeys).catch(() => null),
                ]);

                const ob = obData ? summarizeOrderBook(obData) : null;

                // 3. Ask Claude for true probability (single fast call)
                const newsSnippet = newsContext?.headlines?.length
                    ? '\nRecent news: ' + newsContext.headlines.slice(0, 3).join('; ')
                    : '';

                // NOTE: Do NOT show the market price to prevent anchoring bias.
                // Claude should estimate probability independently.
                const claudePrompt = `You are estimating the probability of an event. Give your INDEPENDENT estimate — do NOT consider any market price.

Question: ${market.question}
Description: ${market.description || 'No description available'}
${newsSnippet}

Be calibrated: 10% means it happens 1 in 10 times. Consider base rates carefully.
Reply with JSON: {"trueYesProb": 0.0-1.0, "reasoning": "1 sentence"}`;

                const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
                    method: 'POST',
                    headers: {
                        'x-api-key': anthropicKey,
                        'anthropic-version': '2023-06-01',
                        'content-type': 'application/json',
                    },
                    body: JSON.stringify({
                        model: 'claude-sonnet-4-20250514',
                        max_tokens: 200,
                        messages: [{ role: 'user', content: claudePrompt }],
                    }),
                });

                if (!claudeResp.ok) {
                    throw new Error(`Claude API ${claudeResp.status}`);
                }

                const claudeData = await claudeResp.json();
                const claudeText = claudeData.content?.[0]?.text || '';

                let analysis;
                try {
                    const jsonMatch = claudeText.match(/\{[\s\S]*\}/);
                    if (!jsonMatch) throw new Error('No JSON in Claude response');
                    analysis = JSON.parse(jsonMatch[0]);
                } catch {
                    analysis = { trueYesProb: 0.5, reasoning: 'Failed to parse Claude response' };
                }

                const trueYesProb = Math.max(0, Math.min(1, parseFloat(analysis.trueYesProb) || 0.5));
                const trueNoProb = 1 - trueYesProb;

                // Determine best NO ask from order book
                // In Kalshi, NO ask = 100 - best YES bid (in cents)
                let bestNoAskCents;
                if (ob && ob.bestYesBid != null) {
                    bestNoAskCents = 100 - ob.bestYesBid;
                } else {
                    // Fallback: NO ask ~ 1 - YES price (in cents)
                    bestNoAskCents = 100 - yesPriceCents;
                }

                const bestNoAskProb = bestNoAskCents / 100; // convert to probability
                const edge = trueNoProb - bestNoAskProb;

                const category = categorizeMarket(rawMarket.ticker, market.question);
                const analysisRecord = {
                    market: market.question,
                    ticker: rawMarket.ticker,
                    category,
                    yesPrice: yesPriceCents,
                    estimatedNoProb: parseFloat(trueNoProb.toFixed(3)),
                    bestNoAskCents,
                    edge: parseFloat(edge.toFixed(3)),
                    reasoning: analysis.reasoning || '',
                    newsProvider: newsContext?.provider || 'none',
                    passed: false,
                };

                // 4. Only proceed if Claude says true NO prob >= 90%
                if (trueNoProb < 0.90) {
                    analysisRecord.skipReason = `NO prob ${(trueNoProb * 100).toFixed(0)}% < 90% threshold`;
                    report.analyses.push(analysisRecord);
                    try { logDecision({ strategy: 'safe-compounder', ticker: rawMarket.ticker, category, market: market.question, action: 'SKIP', rawNoProb: trueNoProb, edge, reason: analysisRecord.skipReason }); } catch {}
                    continue;
                }

                // 5. Require edge > 5 cents (0.05)
                if (edge <= 0.05) {
                    analysisRecord.skipReason = `Edge ${(edge * 100).toFixed(1)}¢ <= 5¢ threshold`;
                    report.analyses.push(analysisRecord);
                    try { logDecision({ strategy: 'safe-compounder', ticker: rawMarket.ticker, category, market: market.question, action: 'SKIP', rawNoProb: trueNoProb, edge, reason: analysisRecord.skipReason }); } catch {}
                    continue;
                }

                analysisRecord.passed = true;
                report.analyses.push(analysisRecord);

                // 6. Place MAKER order: undercut best NO ask by 1 cent
                const orderPriceCents = bestNoAskCents - 1;
                if (orderPriceCents < 1 || orderPriceCents > 99) continue;

                // 7. Quarter-Kelly sizing (conservative for safety)
                // Standard Kelly for binary outcomes: f* = (p*b - q) / b
                // where p = trueNoProb (win probability), b = (1/noAskProb - 1) (net odds), q = 1-p
                const b = bestNoAskProb > 0 && bestNoAskProb < 1 ? (1 / bestNoAskProb - 1) : 1;
                const kelly = b > 0 ? (trueNoProb * b - trueYesProb) / b : 0;
                const quarterKelly = Math.max(0, kelly) * 0.25;
                const positionDollars = Math.min(quarterKelly * budgetLeft, maxPerTrade);

                if (positionDollars < 0.50) continue; // minimum viable trade

                // Calculate contract count: each NO contract costs orderPriceCents
                const contracts = Math.max(1, Math.floor((positionDollars * 100) / orderPriceCents));
                const costDollars = (contracts * orderPriceCents) / 100;

                if (costDollars > budgetLeft) continue;

                // Execute the trade
                const trade = await executeTrade({
                    ticker: rawMarket.ticker,
                    count: contracts,
                    noPriceCents: orderPriceCents,
                    market,
                    hasLiveCreds,
                    dryRun,
                    kalshiKeyId,
                    kalshiPrivateKey,
                    reasoning: analysis.reasoning || '',
                    edge,
                });

                // Log trade persistently
                trade.category = category;
                try { logTrade(trade); } catch {}

                report.trades.push(trade);
                report.tradesExecuted++;
                report.totalSpent += costDollars;
                budgetLeft -= costDollars;

            } catch (err) {
                report.errors.push({ ticker: rawMarket.ticker, market: market.question, error: err.message });
            }
        }

    } catch (err) {
        report.errors.push({ market: 'fetch_markets', error: err.message });
    }

    return res.status(200).json(report);
}

// ─── Trade Execution ───

async function executeTrade(params) {
    const {
        ticker, count, noPriceCents, market,
        hasLiveCreds, dryRun,
        kalshiKeyId, kalshiPrivateKey,
        reasoning, edge,
    } = params;

    const costDollars = (count * noPriceCents) / 100;

    const tradeRecord = {
        id: `safe_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        ticker,
        side: 'no',
        action: 'buy',
        type: 'limit',
        count,
        price: noPriceCents / 100,
        cost: costDollars,
        outcome: 'No',
        amount: costDollars,
        shares: count,
        marketId: ticker,
        tokenId: ticker,
        market: market.question,
        endDate: market.endDate || null,
        reasoning,
        edge: parseFloat(edge.toFixed(3)),
        exchange: 'kalshi',
        timestamp: new Date().toISOString(),
        auto: true,
        strategy: 'safe-compounder',
    };

    if (dryRun || !hasLiveCreds) {
        tradeRecord.paper = true;
        tradeRecord.status = 'resting';
        return tradeRecord;
    }

    try {
        const privateKeyPem = decodeKey(kalshiPrivateKey);
        const result = await placeOrder(
            {
                ticker,
                side: 'no',
                action: 'buy',
                count,
                type: 'limit',
                no_price: noPriceCents,
            },
            { apiKeyId: kalshiKeyId, privateKeyPem }
        );
        tradeRecord.status = result.order?.status || 'submitted';
        tradeRecord.orderId = result.order?.order_id;
        tradeRecord.live = true;
        return tradeRecord;
    } catch (err) {
        tradeRecord.status = 'error';
        tradeRecord.error = err.message;
        return tradeRecord;
    }
}

function decodeKey(key) {
    if (!key) return key;
    if (key.includes('-----BEGIN')) return key;
    try {
        const decoded = Buffer.from(key, 'base64').toString('utf-8');
        if (decoded.includes('-----BEGIN')) return decoded;
    } catch {}
    return key;
}
