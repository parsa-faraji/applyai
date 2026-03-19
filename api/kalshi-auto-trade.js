// Vercel Serverless Function — Kalshi autonomous trading bot
// Same smart logic as Polymarket bot: news search, calibration, Kelly sizing, spread filtering

import { getMarkets, getOrderBook, summarizeOrderBook, placeOrder, normalizeMarket } from './lib/kalshi.js';
import { searchNews } from './lib/search.js';
import { getAllSportsOdds, findMatchingOdds, formatOddsForPrompt } from './lib/odds.js';
import { getEconomicContext } from './lib/fred.js';
import { getWeatherContext } from './lib/noaa.js';
import { runEnsemble, formatEnsembleForPrompt } from './lib/ensemble.js';
import { getSportsContext } from './lib/sports.js';
import { logTrade, logDecision, categorizeMarket } from './lib/trade-logger.js';
import { calibrateWithContext } from './lib/calibration.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Anthropic-Key, X-Brave-Key, X-Odds-Key, X-OpenRouter-Key, X-Kalshi-Key-Id, X-Kalshi-Private-Key');

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
        existingPositions = [],  // tickers we already own
        existingEventTickers = [],  // event_tickers of current positions (both-sides guard)
        recentlyExited = [],        // tickers/event_tickers exited recently (cooldown)
        sessionTradedTickers = [],  // tickers already traded this session (no duplicates)
        maxTradesPerCycle = 2,   // cap trades per cycle
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
    const oddsApiKey = req.headers['x-odds-key'] || process.env.ODDS_API_KEY || '';
    const openrouterKey = req.headers['x-openrouter-key'] || process.env.OPENROUTER_API_KEY || '';

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
        // Fetch bookmaker odds for sports markets (one call covers all sports)
        let allOdds = [];
        if (oddsApiKey) {
            try {
                allOdds = await getAllSportsOdds(oddsApiKey);
                console.log(`Fetched odds for ${allOdds.length} sporting events`);
            } catch (e) {
                console.error('Odds API error:', e.message);
            }
        }

        // Fetch more markets than needed, then pick the most tradeable ones
        const fetchLimit = Math.max(parseInt(marketLimit) * 5, 50);
        const params = { limit: fetchLimit, status: 'open', _smartSort: true };
        if (series_ticker) params.series_ticker = series_ticker;
        const data = await getMarkets(params);

        // Research-backed market filters (KalshiBench + ryanfrigo bot data)
        const allMarkets = (data.markets || []).filter(m => {
            const t = m.title || '';
            const ticker = m.ticker || '';
            const vol = parseFloat(m.volume_24h_fp) || 0;

            // === HARD BLOCKS (proven money losers) ===
            // Multivariate/parlay markets
            if (/^(yes|no)\s/i.test(t)) return false;
            if ((t.match(/,/g) || []).length >= 2 && /\d+\+/.test(t)) return false;
            // First goalscorer (lottery)
            if (/first goal/i.test(t) || /first scorer/i.test(t)) return false;
            // "What will X say" (coin flip, Claude admits no edge)
            if (/what will .+ say/i.test(t)) return false;
            // Triple doubles (too rare)
            if (/triple double/i.test(t)) return false;
            // Double doubles (too rare)
            if (/double double/i.test(t)) return false;
            // ATP Challenger / obscure tennis (no data, void risks, -ROI)
            if (/KXATPCHALLENGER/i.test(ticker)) return false;
            if (/challenger/i.test(t)) return false;
            // Obscure hockey/esports goals
            if (/\d+\+ (goals|strikeouts|saves|home runs)/i.test(t)) return false;
            // Player prop markets (Claude has no edge — pure guessing)
            if (/\d+\+ (points|assists|rebounds|passing yards|rushing yards|receptions|tackles|sacks|interceptions)/i.test(t)) return false;
            // Individual player performance (no reliable data source)
            if (/will .+ (score|record|have|get|throw|rush for|pass for)/i.test(t) && /\d+/.test(t)) return false;
            // Social media / streaming / app store (no data source)
            if (/twitter|tweet|followers|subscribers|downloads|app store|streaming/i.test(t)) return false;
            // Economics: CPI, Fed, GDP, unemployment — LLMs have 50% accuracy (KalshiBench)
            if (/\bcpi\b|inflation rate|consumer price|unemployment rate|jobless|nonfarm payroll/i.test(t)) return false;
            if (/\bfed\b.*rate|federal fund|fomc|rate (hike|cut|decision)/i.test(t)) return false;
            if (/\bgdp\b|gross domestic/i.test(t)) return false;
            // Crypto: LLMs have 36% accuracy — worse than random (KalshiBench)
            if (/bitcoin|ethereum|crypto|btc|eth|solana|dogecoin/i.test(t)) return false;
            // Mentions/social: 52% accuracy — no edge
            if (/\btweet\b|mention|say.*about|post.*about/i.test(t)) return false;

            // === QUALITY FILTERS ===
            // Price: only 25-75¢ (sweet spot for edge vs fees)
            const price = parseFloat(m.last_price_dollars || '0.5');
            if (price < 0.25 || price > 0.75) return false;
            // Volume: require minimum activity (skip dead markets)
            if (vol < 10) return false;
            return true;
        });

        // Score and rank markets by tradeability:
        // - Price away from 50/50 = market has a view = more info available
        // - Higher volume/open interest = more liquid, better fills
        // - Avoid extreme prices (>95¢ or <5¢) where edge is minimal
        // Note: Kalshi API uses _dollars (0.00-1.00) and _fp suffixes
        const scored = allMarkets.map(m => {
            const yesPrice = (parseFloat(m.yes_bid_dollars) || parseFloat(m.last_price_dollars) || 0.5) * 100;
            const priceDist = Math.abs(yesPrice - 50); // 0-50, higher = more asymmetric
            const vol = parseFloat(m.volume_24h_fp) || parseFloat(m.volume_fp) || 0;
            const oi = parseFloat(m.open_interest_fp) || 0;
            const tooExtreme = yesPrice > 95 || yesPrice < 5;
            const score = (tooExtreme ? 0 : priceDist * 2) + Math.log1p(vol) * 3 + Math.log1p(oi) * 2;
            return { market: m, score };
        });
        scored.sort((a, b) => b.score - a.score);
        const markets = scored.slice(0, parseInt(marketLimit)).map(s => s.market);
        report.marketsScanned = allMarkets.length;

        let budgetLeft = budget;
        let tradesThisCycle = 0;
        const ownedTickers = new Set(existingPositions);
        const tradedEvents = new Set(); // prevent buying both sides of same event
        const recentlyExitedSet = new Set(recentlyExited);
        const existingEventSet = new Set(existingEventTickers);
        const sessionTradedSet = new Set(sessionTradedTickers);

        // Game-level correlation guard: extract game keys from existing positions
        // Different bet types on the same game (spread, totals, moneyline) share a
        // common game key like "26MAR18PORIND" — extract this to prevent correlated bets
        const existingGameKeys = new Set();
        for (const ticker of existingPositions) {
            const gameKey = extractGameKey(ticker);
            if (gameKey) existingGameKeys.add(gameKey);
        }


        for (const rawMarket of markets) {
            if (budgetLeft < 1) break;
            if (tradesThisCycle >= maxTradesPerCycle) break;

            // Skip markets we already own
            if (ownedTickers.has(rawMarket.ticker)) continue;

            // Skip if we already traded in this event (prevents buying both sides)
            const eventTicker = rawMarket.event_ticker || '';
            if (eventTicker && tradedEvents.has(eventTicker)) continue;

            // Skip recently exited markets (2h cooldown — don't re-enter after a loss)
            if (recentlyExitedSet.has(rawMarket.ticker)) continue;
            if (eventTicker && recentlyExitedSet.has(eventTicker)) continue;

            // Skip markets already traded this session (prevent duplicate resting orders)
            if (sessionTradedSet.has(rawMarket.ticker)) continue;

            // Skip if we already hold a position in this event (both-sides guard)
            if (eventTicker && existingEventSet.has(eventTicker)) continue;

            // Game-level correlation guard: different bet types on same game
            // (e.g., moneyline + spread + totals all for Portland at Indiana)
            const gameKey = extractGameKey(rawMarket.ticker);
            if (gameKey && existingGameKeys.has(gameKey)) continue;

            const market = normalizeMarket(rawMarket);

            try {
                // Fetch order book + news + all domain data in parallel
                const [obData, newsContext, econContext, weatherContext, sportsContext] = await Promise.all([
                    getOrderBook(rawMarket.ticker).catch(() => null),
                    searchNews(market.question, searchKeys).catch(() => null),
                    getEconomicContext(market.question).catch(() => ''),
                    getWeatherContext(market.question).catch(() => ''),
                    getSportsContext(market.question).catch(() => ''),
                ]);

                const ob = obData ? summarizeOrderBook(obData) : null;
                const oddsData = allOdds.length > 0 ? findMatchingOdds(market.question, allOdds) : null;

                // Check spread BEFORE running expensive analysis (saves API calls)
                if (ob && ob.spreadPct > 5) {
                    report.analyses.push({
                        market: market.question,
                        ticker: rawMarket.ticker,
                        recommendation: { action: 'HOLD', reasoning: 'Spread too wide — skipping analysis' },
                        skipped: `spread ${ob.spreadPct.toFixed(1)}% > 5%`,
                    });
                    continue;
                }

                // Sports markets REQUIRE bookmaker odds — Claude alone can't price sports
                const SPORTS_TICKER_RE = /^KX(NBA|NFL|NHL|MLB|NCAA|NCAAMB|NCAAF|UFC|PGA|ATP|WTA|MLS|WNBA|SOCCER|EUROLEAGUE|CS2|COLLEGE)/i;
                if (SPORTS_TICKER_RE.test(rawMarket.ticker) && allOdds.length === 0) {
                    report.analyses.push({
                        market: market.question,
                        ticker: rawMarket.ticker,
                        recommendation: { action: 'HOLD', reasoning: 'Sports market with no bookmaker odds — skipping' },
                        skipped: 'no odds data for sports market',
                    });
                    continue;
                }

                // Run multi-LLM ensemble for independent probability estimate
                let ensembleData = null;
                if (openrouterKey) {
                    const ensembleContext = buildResearchContext({ news: newsContext, odds: oddsData, economic: econContext, weather: weatherContext });
                    ensembleData = await runEnsemble(market.question, market.description, ensembleContext, { anthropicKey, openrouterKey }).catch(() => null);
                }

                const liveContext = { orderBook: ob, news: newsContext, odds: oddsData, economic: econContext, weather: weatherContext, sports: sportsContext, ensemble: ensembleData };

                const analysis = await analyzeWithClaude(market, anthropicKey, riskLevel, budgetLeft, maxPerTrade, liveContext);
                report.marketsAnalyzed++;
                // Summarize what data Claude had for this decision
                const oddsInfo = oddsData?.consensus
                    ? Object.entries(oddsData.consensus).map(([team, d]) => `${team}: ${(d.avgProb * 100).toFixed(0)}%`).join(', ')
                    : null;

                const category = categorizeMarket(rawMarket.ticker, market.question);
                report.analyses.push({
                    market: market.question,
                    ticker: rawMarket.ticker,
                    category,
                    recommendation: analysis.recommendation,
                    liveData: ob ? { spread: ob.spread, midpoint: ob.midpoint } : null,
                    oddsData: oddsInfo,
                    newsProvider: newsContext?.provider || null,
                });

                const rec = analysis.recommendation;

                // Log every decision for calibration analysis
                try {
                    logDecision({
                        strategy: 'auto-trade',
                        ticker: rawMarket.ticker,
                        eventTicker,
                        category,
                        market: market.question,
                        marketPrice: parseFloat(rawMarket.last_price_dollars) || null,
                        calibratedProbability: rec.researchProbability ?? null,
                        rawProbability: rec.rawProbability ?? null,
                        edge: rec.edge ?? null,
                        action: rec.action,
                        confidence: rec.confidence,
                        hadOdds: !!oddsData?.consensus,
                        hadNews: !!(newsContext?.headlines?.length),
                        hadEnsemble: !!ensembleData?.shouldTrade,
                        hadSports: !!sportsContext,
                        hadEconomic: !!econContext,
                        hadWeather: !!weatherContext,
                        endDate: market.endDate || null,
                        reasoning: rec.reasoning,
                    });
                } catch {} // don't let logging failures break trading
                if (shouldExecute(rec, riskLevel)) {
                    const tradeAmount = calculateKellySize(rec, budgetLeft, maxPerTrade, budget, maxSingleMarketPct);

                    if (tradeAmount >= 1) {
                        const isYes = rec.action.includes('YES');
                        // Use maker orders (ask - 1¢) to save on fees (4x cheaper than taker)
                        // Trades may not fill immediately but the cost savings are significant
                        let priceCents;
                        if (isYes) {
                            priceCents = ob?.bestYesAsk ? ob.bestYesAsk - 1 : (rawMarket.yes_ask_dollars ? Math.round(parseFloat(rawMarket.yes_ask_dollars) * 100) - 1 : 50);
                        } else {
                            const noAsk = ob?.bestNoBid ? 100 - ob.bestNoBid : null;
                            priceCents = noAsk ? noAsk - 1 : (rawMarket.no_ask_dollars ? Math.round(parseFloat(rawMarket.no_ask_dollars) * 100) - 1 : 50);
                        }
                        priceCents = Math.min(priceCents, 99);
                        // EXECUTION PRICE CHECK: verify price is still in 25-75¢ range
                        if (priceCents < 25 || priceCents > 75) {
                            report.analyses[report.analyses.length - 1].skipped = `execution price ${priceCents}¢ outside 25-75¢ range`;
                            continue;
                        }
                        const contracts = Math.min(20, Math.floor((tradeAmount * 100) / priceCents));

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

                        // Attach reasoning to trade record
                        trade.reasoning = rec.reasoning;
                        trade.confidence = rec.confidence;
                        trade.edge = rec.edge;
                        trade.rawProbability = rec.rawProbability || null;
                        trade.hadOdds = !!oddsData?.consensus;
                        trade.hadNews = !!(newsContext?.headlines?.length);
                        trade.category = category;
                        trade.strategy = 'auto-trade';
                        trade.eventTicker = eventTicker;

                        // Persist to trade log
                        try { logTrade(trade); } catch {}

                        report.trades.push(trade);
                        report.tradesExecuted++;
                        tradesThisCycle++;
                        ownedTickers.add(rawMarket.ticker);
                        if (eventTicker) tradedEvents.add(eventTicker);
                        if (gameKey) existingGameKeys.add(gameKey);
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

// ─── Claude Analysis (Bull vs Bear Debate System) ───

// Helper: call Claude API and return the text response
async function callClaude(apiKey, prompt, maxTokens) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: maxTokens,
            messages: [{ role: 'user', content: prompt }],
        }),
    });

    if (!resp.ok) throw new Error(`Claude API ${resp.status}`);
    const data = await resp.json();
    return data.content?.[0]?.text || '';
}

// Helper: extract and parse JSON from Claude's response text
function parseJsonResponse(text) {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');
    return JSON.parse(jsonMatch[0]);
}

// Helper: build contextual sections from live data (news, odds) — no market price shown
function buildResearchContext(liveContext) {
    let section = '';

    if (liveContext.news && liveContext.news.headlines?.length > 0) {
        const news = liveContext.news;
        section += `\n## Recent News
${news.headlines.map((h, i) => `- ${h}${news.snippets?.[i] ? ': ' + news.snippets[i] : ''}`).join('\n')}`;
    }

    if (liveContext.odds) {
        section += formatOddsForPrompt(liveContext.odds);
    }

    if (liveContext.economic) {
        section += '\n## Economic Data\n' + liveContext.economic;
    }

    if (liveContext.weather) {
        section += '\n## Weather Data\n' + liveContext.weather;
    }

    if (liveContext.sports) {
        section += '\n## Live Sports Data\n' + liveContext.sports;
    }

    if (liveContext.ensemble) {
        section += formatEnsembleForPrompt(liveContext.ensemble);
    }

    return section;
}

// Stage 1: Independent research estimate (no market price to prevent anchoring)
async function runResearchStage(market, apiKey, liveContext) {
    const researchContext = buildResearchContext(liveContext);

    const prompt = `You are a calibrated research analyst estimating event probabilities. Based ONLY on the evidence below, estimate the probability. DO NOT consider any market price.

Question: ${market.question}
Description: ${market.description || 'N/A'}
${researchContext}

CALIBRATION RULES:
- Consider base rates: what % of similar events happen historically?
- If key information is missing, stay closer to 50%
- Probabilities above 85% or below 15% require overwhelming evidence
- Use precise values (73%, not "about 70%")
- State what you DON'T know — uncertainty should widen your estimate toward 50%
- Prediction markets are efficient; explain specifically why the market might be wrong

Reply JSON: {"probability": 0.0-1.0, "keyFactors": ["factor1", "factor2"], "confidence": "low"|"medium"|"high"}`;

    const text = await callClaude(apiKey, prompt, 300);
    try {
        return { result: parseJsonResponse(text), rawText: text };
    } catch {
        return { result: { probability: 0.5, keyFactors: [], confidence: 'low' }, rawText: text };
    }
}

// Stage 2: Bull and Bear cases (run in parallel)
async function runBullBearStage(market, apiKey, researchProb, marketPrice) {
    const probPct = (researchProb * 100).toFixed(0);

    const bullPrompt = `You are a BULL arguing FOR this trade. The research estimate is ${probPct}% but the market price is ${marketPrice}¢. Make the STRONGEST case for why the market is wrong and there IS edge. Arguments, catalysts, why the price should be higher/lower.

Question: ${market.question}
Description: ${market.description || 'N/A'}

JSON: {"case": "2-3 sentences", "estimatedEdge": number, "conviction": 0-1}`;

    const bearPrompt = `You are a BEAR arguing AGAINST this trade. The research estimate is ${probPct}% and the market price is ${marketPrice}¢. Make the STRONGEST case for why there is NO edge and the market is right. Counter-arguments, risks, why the price is fair.

Question: ${market.question}
Description: ${market.description || 'N/A'}

JSON: {"case": "2-3 sentences", "risks": ["risk1"], "conviction": 0-1}`;

    const [bullText, bearText] = await Promise.all([
        callClaude(apiKey, bullPrompt, 200),
        callClaude(apiKey, bearPrompt, 200),
    ]);

    let bull, bear;
    try {
        bull = parseJsonResponse(bullText);
    } catch {
        bull = { case: 'Failed to parse bull case', estimatedEdge: 0, conviction: 0 };
    }
    try {
        bear = parseJsonResponse(bearText);
    } catch {
        bear = { case: 'Failed to parse bear case', risks: [], conviction: 0 };
    }

    return { bull, bear, bullRaw: bullText, bearRaw: bearText };
}

// Stage 3: Final trading decision synthesizing all inputs
async function runFinalDecision(market, apiKey, researchProb, marketPrice, bull, bear, riskLevel, budgetLeft, maxPerTrade) {
    const riskMap = {
        conservative: 'Only trade with HIGH confidence (>75%) and >10pt edge after spread.',
        moderate: 'Trade with moderate-high confidence and >5pt edge after spread.',
        aggressive: 'Trade with moderate confidence and >3pt edge after spread.',
    };

    const probPct = (researchProb * 100).toFixed(0);
    const edgeEstimate = bull.estimatedEdge || Math.abs(researchProb * 100 - marketPrice);

    const prompt = `You are making the final trading decision. You are managing $${budgetLeft.toFixed(0)} remaining (max $${maxPerTrade}/trade). Here is the full analysis:

- Independent research probability: ${probPct}%
- Market price: ${marketPrice}¢
- BULL case: ${bull.case} (conviction: ${bull.conviction})
- BEAR case: ${bear.case} (conviction: ${bear.conviction})
- Edge estimate: ${edgeEstimate.toFixed(1)}pts

Rules:
- If Bull and Bear both have high conviction (>0.7) → models disagree → reduce position size or HOLD
- If research probability differs from market by >10pts AND Bull conviction > Bear conviction → TRADE
- If Bear conviction > Bull conviction → HOLD (the market is probably right)
- Use fractional Kelly (0.25x) for sizing, max 3% of budget per trade
- Risk level: ${riskMap[riskLevel] || riskMap.moderate}

JSON: {"action": "BUY YES"|"BUY NO"|"HOLD", "confidence": "low"|"medium"|"high", "edge": number, "kellyFraction": 0.0-0.25, "reasoning": "1-2 sentences with specific evidence", "bullConviction": number, "bearConviction": number}`;

    const text = await callClaude(apiKey, prompt, 400);
    try {
        return { result: parseJsonResponse(text), rawText: text };
    } catch {
        return { result: { action: 'HOLD', confidence: 'low', edge: 0, kellyFraction: 0, reasoning: 'Parse error in final decision', bullConviction: 0, bearConviction: 0 }, rawText: text };
    }
}

async function analyzeWithClaude(market, apiKey, riskLevel, budgetLeft, maxPerTrade, liveContext) {
    const prices = market.outcomePrices || [];
    const yesPrice = prices[0] ? parseFloat((parseFloat(prices[0]) * 100).toFixed(0)) : 50;

    // ── Stage 1: Independent research (no market price shown) ──
    const research = await runResearchStage(market, apiKey, liveContext);
    const rawProb = research.result.probability;

    // ── CALIBRATION: Platt scaling with context-aware k ──
    // Uses sigmoid(k * logit(raw) + b) where k < 1 compresses toward 50%.
    // When bookmaker odds exist, use them as the BASE probability and allow
    // Claude only a small Platt-scaled adjustment on top.

    let researchProb;

    if (liveContext.odds?.consensus) {
        // BEST CASE: Use bookmaker odds as base probability (they spend millions on this)
        const consensusEntries = Object.entries(liveContext.odds.consensus);
        const totalConsensus = consensusEntries.reduce((sum, [, d]) => sum + d.avgProb, 0);

        let oddsBaseProb;
        if (consensusEntries.length === 2) {
            const [side1, side2] = consensusEntries;
            const p1 = totalConsensus > 0 ? side1[1].avgProb / totalConsensus : side1[1].avgProb;
            const p2 = totalConsensus > 0 ? side2[1].avgProb / totalConsensus : side2[1].avgProb;
            oddsBaseProb = rawProb >= 0.5 ? Math.max(p1, p2) : Math.min(p1, p2);
        } else {
            const sorted = consensusEntries.sort((a, b) => b[1].avgProb - a[1].avgProb);
            oddsBaseProb = totalConsensus > 0 ? sorted[0][1].avgProb / totalConsensus : sorted[0][1].avgProb;
        }

        // Platt-scale Claude's estimate, then allow ±5pt adjustment on odds base
        const calibratedRaw = calibrateWithContext(rawProb, {
            hasOdds: true,
            hasEnsemble: !!liveContext.ensemble?.shouldTrade,
            hasNews: !!(liveContext.news?.headlines?.length),
            category: null,
        });
        const claudeAdjustment = Math.max(-0.05, Math.min(0.05, calibratedRaw - oddsBaseProb));
        researchProb = oddsBaseProb + claudeAdjustment;
    } else if (liveContext.ensemble?.shouldTrade && liveContext.ensemble.disagreement < 0.15) {
        // GOOD CASE: Platt-scale both Claude and ensemble, then blend
        const calibratedRaw = calibrateWithContext(rawProb, {
            hasOdds: false,
            hasEnsemble: true,
            hasNews: !!(liveContext.news?.headlines?.length),
            category: null,
        });
        // Weight ensemble 60%, Platt-calibrated Claude 40%
        const ensembleCalibrated = calibrateWithContext(liveContext.ensemble.consensusProbability, {
            hasOdds: false,
            hasEnsemble: true,
            hasNews: !!(liveContext.news?.headlines?.length),
            category: null,
        });
        researchProb = ensembleCalibrated * 0.6 + calibratedRaw * 0.4;
    } else {
        // WORST CASE: Claude alone — Platt scaling handles the shrinkage
        researchProb = calibrateWithContext(rawProb, {
            hasOdds: false,
            hasEnsemble: false,
            hasNews: !!(liveContext.news?.headlines?.length),
            category: null,
        });
    }

    // Clamp to valid range
    researchProb = Math.max(0.01, Math.min(0.99, researchProb));
    const calibratedEdge = Math.abs(researchProb * 100 - yesPrice);

    // ── INFORMATION QUALITY GATE: Require RELEVANT external data ──
    // Bookmaker odds are the gold standard (sharp money). News with 2+ headlines is decent.
    // ESPN scores alone are weak signal. FRED/NOAA data is only useful for matching markets.
    const hasOdds = !!liveContext.odds?.consensus;
    const hasRealNews = !!(liveContext.news?.headlines?.length >= 2 && liveContext.news.provider !== 'polymarket_related');
    const hasEnsemble = !!(liveContext.ensemble?.shouldTrade);
    const hasRelevantData = hasOdds || hasRealNews || hasEnsemble;
    if (!hasRelevantData && calibratedEdge < 20) {
        return {
            recommendation: { action: 'HOLD', confidence: 'low', edge: calibratedEdge, kellyFraction: 0, reasoning: `Insufficient data — need odds, news, ensemble, or very large edge (≥20pts). Edge: ${calibratedEdge.toFixed(1)}pts` },
            rawResponse: 'Skipped: no relevant external data and edge too small',
        };
    }

    // Require minimum edge: 10pts with odds/ensemble, 12pts without (was 8)
    const minEdge = liveContext.odds?.consensus ? 10 : 12;
    if (calibratedEdge < minEdge) {
        return {
            recommendation: { action: 'HOLD', confidence: 'low', edge: calibratedEdge, kellyFraction: 0, reasoning: `Calibrated edge only ${calibratedEdge.toFixed(1)}pts (need ≥${minEdge}pts). Raw: ${Math.abs(rawProb * 100 - yesPrice).toFixed(1)}pts` },
            rawResponse: `Calibrated prob: ${(researchProb*100).toFixed(0)}% (raw: ${(rawProb*100).toFixed(0)}%)`,
        };
    }

    // ── DIRECT DECISION: Skip bull/bear debate (research shows it adds cost, not signal) ──
    // The research stage + calibration + edge gate already filters well.
    // Bull/bear debate was Claude arguing with itself using the same information — no new signal.
    // This saves ~70% of Claude API cost per analyzed market.

    const isYes = researchProb * 100 > yesPrice; // model thinks YES is underpriced
    const action = calibratedEdge >= minEdge ? (isYes ? 'BUY YES' : 'BUY NO') : 'HOLD';

    // Server-side Kelly from edge (don't rely on Claude to compute this)
    const winProb = isYes ? researchProb : (1 - researchProb);
    const costProb = isYes ? yesPrice / 100 : (100 - yesPrice) / 100;
    const b = costProb > 0 && costProb < 1 ? (1 / costProb - 1) : 1;
    const kellyFull = b > 0 ? (winProb * b - (1 - winProb)) / b : 0;
    const kellyFraction = Math.max(0, Math.min(0.25, kellyFull * 0.25));

    const recommendation = {
        action,
        confidence: research.result.confidence || 'medium',
        edge: calibratedEdge,
        kellyFraction,
        reasoning: `Research: ${(researchProb * 100).toFixed(0)}% vs market ${yesPrice}¢ (${calibratedEdge.toFixed(1)}pt edge). ${research.result.keyFactors?.join('; ') || ''}`,
        researchProbability: researchProb,
        rawProbability: rawProb,
        researchKeyFactors: research.result.keyFactors || [],
        researchConfidence: research.result.confidence || 'low',
    };

    return { recommendation, rawResponse: research.rawText };
}

// ─── Trade Execution ───

function shouldExecute(rec, riskLevel) {
    if (!rec || rec.action === 'HOLD') return false;
    const minConfidence = { conservative: 'high', moderate: 'medium', aggressive: 'low' };
    const levels = ['low', 'medium', 'high'];
    return levels.indexOf(rec.confidence) >= levels.indexOf(minConfidence[riskLevel] || 'medium');
}

function calculateKellySize(rec, budgetLeft, maxPerTrade, totalBudget, maxSinglePct) {
    // Server-side Kelly verification — don't trust Claude's self-reported fraction.
    // Compute actual Kelly from the edge and price, then take the minimum.
    const edge = rec.edge || 0;
    const price = rec.researchProbability || 0.5;

    // Mathematical Kelly: f* = (p*b - q) / b where p=win_prob, b=net_odds, q=1-p
    // For a binary market: simplified to (p - market_price) / (1 - market_price)
    const marketProb = price; // approximate
    const computedKelly = edge > 0 ? Math.min(0.25, Math.max(0, edge / 100)) : 0;

    // Take the MINIMUM of Claude's suggestion and our computed value
    const claudeKelly = Math.min(rec.kellyFraction || 0.05, 0.25);
    const kelly = Math.min(claudeKelly, computedKelly > 0 ? computedKelly : claudeKelly);

    // If edge is zero or negative, don't trade regardless of what Claude said
    if (edge <= 0) return 0;

    let size = budgetLeft * kelly;
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
        ticker, side, action, count,
        price: price / 100,  // Convert cents to dollars (0-1) for frontend
        cost: costDollars,
        // Frontend-expected fields
        outcome: side === 'yes' ? 'Yes' : 'No',
        amount: costDollars,
        shares: count,
        marketId: ticker,
        tokenId: ticker,
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

/**
 * Extract a game-level key from a Kalshi ticker to detect correlated bets.
 * Tickers like KXNBASPREAD-26MAR18PORIND-POR13, KXNBATOTAL-26MAR18PORIND-249,
 * KXNBAGAME-26MAR18PORIND-POR all share the game key "26MAR18PORIND".
 * Returns the shared game portion or null if not a sports ticker.
 */
function extractGameKey(ticker) {
    if (!ticker) return null;
    // Pattern: KX<TYPE>-<DATE><TEAMS>-<DETAIL>
    // e.g. KXNBASPREAD-26MAR18PORIND-POR13 → 26MAR18PORIND
    const match = ticker.match(/^KX[A-Z]+-(\d{2}[A-Z]{3}\d{2}[A-Z]+)/);
    return match ? match[1] : null;
}
