// Vercel Serverless Function — Kalshi autonomous trading bot
// Same smart logic as Polymarket bot: news search, calibration, Kelly sizing, spread filtering

import { getMarkets, getOrderBook, summarizeOrderBook, placeOrder, normalizeMarket } from './lib/kalshi.js';
import { searchNews } from './lib/search.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Anthropic-Key, X-Brave-Key, X-Kalshi-Key-Id, X-Kalshi-Private-Key');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const {
        budget = 100,
        maxPerTrade = 25,
        riskLevel = 'moderate',
        dryRun = true,
        marketLimit = 10,
        maxSingleMarketPct = 20,
        series_ticker,
    } = req.body;

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
        exchange: 'kalshi',
        marketsScanned: 0,
        marketsAnalyzed: 0,
        tradesExecuted: 0,
        totalSpent: 0,
        dryRun,
        hasLiveCreds,
        analyses: [],
        trades: [],
        errors: [],
    };

    try {
        // Fetch active Kalshi markets
        const params = { limit: parseInt(marketLimit), status: 'open' };
        if (series_ticker) params.series_ticker = series_ticker;
        const data = await getMarkets(params);
        const markets = (data.markets || []);
        report.marketsScanned = markets.length;

        let budgetLeft = budget;

        for (const rawMarket of markets) {
            if (budgetLeft < 1) break;

            const market = normalizeMarket(rawMarket);

            try {
                // Fetch order book + news in parallel
                const [obData, newsContext] = await Promise.all([
                    getOrderBook(rawMarket.ticker).catch(() => null),
                    searchNews(market.question, searchKeys).catch(() => null),
                ]);

                const ob = obData ? summarizeOrderBook(obData) : null;
                const liveContext = { orderBook: ob, news: newsContext };

                const analysis = await analyzeWithClaude(market, anthropicKey, riskLevel, budgetLeft, maxPerTrade, liveContext);
                report.marketsAnalyzed++;
                report.analyses.push({
                    market: market.question,
                    ticker: rawMarket.ticker,
                    recommendation: analysis.recommendation,
                    liveData: ob ? { spread: ob.spread, midpoint: ob.midpoint } : null,
                });

                const rec = analysis.recommendation;
                if (shouldExecute(rec, riskLevel)) {
                    const tradeAmount = calculateKellySize(rec, budgetLeft, maxPerTrade, budget, maxSingleMarketPct);

                    if (tradeAmount >= 1) {
                        // Check spread
                        if (ob && ob.spreadPct > 5) {
                            report.analyses[report.analyses.length - 1].skipped = 'spread too wide';
                            continue;
                        }

                        const isYes = rec.action.includes('YES');
                        const priceCents = isYes
                            ? (rawMarket.yes_ask || ob?.bestYesAsk || 50)
                            : (rawMarket.no_ask || (ob?.bestNoBid ? 100 - ob.bestNoBid : 50));
                        const contracts = Math.floor((tradeAmount * 100) / priceCents); // Kalshi prices in cents

                        if (contracts < 1) continue;

                        const trade = await executeKalshiTrade({
                            ticker: rawMarket.ticker,
                            side: isYes ? 'yes' : 'no',
                            action: 'buy',
                            count: contracts,
                            price: priceCents,
                            market,
                            hasLiveCreds, dryRun,
                            kalshiKeyId, kalshiPrivateKey,
                        });

                        report.trades.push(trade);
                        report.tradesExecuted++;
                        const spent = (priceCents * contracts) / 100;
                        report.totalSpent += spent;
                        budgetLeft -= spent;
                    }
                }
            } catch (err) {
                report.errors.push({ market: market.question, error: err.message });
            }
        }

    } catch (err) {
        report.errors.push({ market: 'fetch_markets', error: err.message });
    }

    return res.status(200).json(report);
}

// ─── Claude Analysis ───

async function analyzeWithClaude(market, apiKey, riskLevel, budgetLeft, maxPerTrade, liveContext) {
    const riskMap = {
        conservative: 'Only trade with HIGH confidence (>75%) and >10pt edge after spread.',
        moderate: 'Trade with moderate-high confidence and >5pt edge after spread.',
        aggressive: 'Trade with moderate confidence and >3pt edge after spread.',
    };

    const prices = market.outcomePrices || [];
    const yesPrice = prices[0] ? (parseFloat(prices[0]) * 100).toFixed(0) : '?';
    const noPrice = prices[1] ? (parseFloat(prices[1]) * 100).toFixed(0) : '?';

    let liveSection = '';
    if (liveContext.orderBook) {
        const ob = liveContext.orderBook;
        liveSection += `\n## Order Book
- Best Yes Bid: ${ob.bestYesBid || '?'}¢ | Best Yes Ask: ${ob.bestYesAsk || '?'}¢
- Spread: ${ob.spread || '?'}¢ (${ob.spreadPct?.toFixed(1) || '?'}%)
- Midpoint: ${ob.midpoint?.toFixed(0) || '?'}¢
- Yes Depth: $${ob.yesDepthUsd?.toFixed(0) || '?'} | No Depth: $${ob.noDepthUsd?.toFixed(0) || '?'}`;
    }

    if (liveContext.news && liveContext.news.headlines?.length > 0) {
        const news = liveContext.news;
        liveSection += `\n## Recent News
${news.headlines.map((h, i) => `- ${h}${news.snippets?.[i] ? ': ' + news.snippets[i] : ''}`).join('\n')}`;
    }

    const prompt = `You are an autonomous prediction market trading bot managing $${budgetLeft.toFixed(0)} remaining (max $${maxPerTrade}/trade). Analyze this Kalshi market.

## Market
**Question:** ${market.question}
**Description:** ${market.description || 'N/A'}
**End Date:** ${market.endDate || 'Unknown'}
**Open Interest:** ${market.open_interest || '?'} contracts

## Prices
- Yes: ${yesPrice}¢ | No: ${noPrice}¢
${liveSection}

## Calibration
- The market price reflects many informed traders. It is usually approximately correct.
- Only trade when you have SPECIFIC evidence (from news, data, or logic) that the market is wrong.
- "I think X is more likely" without evidence is NOT edge. Recommend HOLD.
- If news supports one side, the price may have ALREADY moved — check the order book.
- Be honest about uncertainty. HOLD is the default.

## Rules
${riskMap[riskLevel] || riskMap.moderate}
- Factor in spread cost, depth, and whether news is already priced in.
- If spread >5%, account for it eating your edge.

## Response (JSON only)
{
  "action": "BUY YES" | "BUY NO" | "HOLD",
  "confidence": "low" | "medium" | "high",
  "edge": <estimated edge in percentage points after spread, 0 if HOLD>,
  "kellyFraction": <0.0 to 0.5>,
  "reasoning": "<1-2 sentences with specific evidence>"
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

    if (!resp.ok) throw new Error(`Claude API ${resp.status}`);
    const data = await resp.json();
    const text = data.content?.[0]?.text || '';

    try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON in response');
        const rec = JSON.parse(jsonMatch[0]);
        return { recommendation: rec, rawResponse: text };
    } catch {
        return { recommendation: { action: 'HOLD', confidence: 'low', edge: 0, reasoning: 'Parse error' }, rawResponse: text };
    }
}

// ─── Trade Execution ───

function shouldExecute(rec, riskLevel) {
    if (!rec || rec.action === 'HOLD') return false;
    const minConfidence = { conservative: 'high', moderate: 'medium', aggressive: 'low' };
    const levels = ['low', 'medium', 'high'];
    return levels.indexOf(rec.confidence) >= levels.indexOf(minConfidence[riskLevel] || 'medium');
}

function calculateKellySize(rec, budgetLeft, maxPerTrade, totalBudget, maxSinglePct) {
    const kelly = Math.min(rec.kellyFraction || 0.1, 0.5);
    const halfKelly = kelly / 2;
    let size = budgetLeft * halfKelly;
    size = Math.min(size, maxPerTrade);
    size = Math.min(size, totalBudget * (maxSinglePct / 100));
    return Math.max(0, size);
}

async function executeKalshiTrade(params) {
    const { ticker, side, action, count, price, market, hasLiveCreds, dryRun, kalshiKeyId, kalshiPrivateKey } = params;
    const costCents = price * count;
    const costDollars = costCents / 100;

    const tradeRecord = {
        id: `auto_kalshi_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        ticker, side, action, count, price,
        cost: costDollars,
        market: market.question,
        endDate: market.endDate || null,
        timestamp: new Date().toISOString(),
        auto: true,
        exchange: 'kalshi',
    };

    if (dryRun || !hasLiveCreds) {
        tradeRecord.paper = true;
        tradeRecord.status = 'filled';
        return tradeRecord;
    }

    try {
        const privateKeyPem = decodeKey(kalshiPrivateKey);
        const result = await placeOrder(
            { ticker, side, action, count, [`${side}_price`]: price },
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
