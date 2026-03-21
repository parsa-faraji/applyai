// Vercel Serverless Function — Kalshi Safe Compounder Strategy
// Highest win-rate strategy (74%): buy NO contracts on events almost certainly NOT happening.
// Only trades when YES price <= 20¢ (event 80%+ unlikely) AND Claude confirms >= 90% NO probability.
// Uses maker (resting limit) orders with half-Kelly sizing for optimal bankroll growth.
// Sports markets allowed when bookmaker odds confirm the favorite-longshot bias edge.

import { getMarkets, getOrderBook, summarizeOrderBook, placeOrder, normalizeMarket } from './lib/kalshi.js';
import { searchNews } from './lib/search.js';
import { logTrade, logDecision, categorizeMarket, buildSelfReflectionContext } from './lib/trade-logger.js';
import { getAllSportsOdds, findMatchingOdds, formatOddsForPrompt } from './lib/odds.js';

export const config = { maxDuration: 60 };

// Always skip: esports and obscure leagues with no bookmaker data
const ALWAYS_SKIP = [
    'KXCS2', 'KXEUROLEAGUE', 'KXATPCHALLENGER', 'KXCBA', 'KXKHL',
    'KXAHL', 'KXLIIGA', 'KXINTLFRIEND',
];

// Major sports: allowed through with bookmaker odds confirmation
const SPORTS_PREFIXES = [
    'KXNBA', 'KXNFL', 'KXNHL', 'KXMLB', 'KXNCAA', 'KXUFC', 'KXPGA', 'KXATP',
];

// Sports require higher edge due to higher variance in outcomes
const SPORTS_MIN_EDGE = 0.07; // 7 cents
const DEFAULT_MIN_EDGE = 0.05; // 5 cents

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Anthropic-Key, X-Brave-Key, X-Kalshi-Key-Id, X-Kalshi-Private-Key, X-Odds-Key');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const {
        budget = 100,
        maxPerTrade = 25,
        dryRun = true,
        marketLimit = 20,
        existingPositions = [],
    } = req.body || {};

    const anthropicKey = req.headers['x-anthropic-key'] || process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) return res.status(400).json({ error: 'Anthropic API key required' });

    const kalshiKeyId = req.headers['x-kalshi-key-id'] || process.env.KALSHI_API_KEY_ID;
    const kalshiPrivateKey = req.headers['x-kalshi-private-key'] || process.env.KALSHI_PRIVATE_KEY;
    const hasLiveCreds = !!(kalshiKeyId && kalshiPrivateKey);
    const oddsApiKey = req.headers['x-odds-key'] || process.env.ODDS_API_KEY || '';

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

        // 1. Fetch markets with smart sort (scans ~1000 markets)
        const data = await getMarkets({ _smartSort: true, limit: 200 });
        const allMarkets = data.markets || [];
        report.marketsScanned = allMarkets.length;

        // 2. Filter: YES price <= 0.20 (20 cents) AND not in always-skip categories
        //    Sports markets pass through but are flagged for odds confirmation
        const candidates = allMarkets.filter(m => {
            const ticker = m.ticker || '';
            const eventTicker = m.event_ticker || '';

            // Always skip esports and obscure leagues (no bookmaker data available)
            if (ALWAYS_SKIP.some(p => ticker.startsWith(p) || eventTicker.startsWith(p))) {
                return false;
            }

            // Only markets where YES is cheap (event unlikely)
            const yesPrice = parseFloat(m.last_price_dollars) || parseFloat(m.yes_bid_dollars) || null;
            if (yesPrice === null) return false;
            return yesPrice <= 0.20;
        }).map(m => {
            const ticker = m.ticker || '';
            const eventTicker = m.event_ticker || '';
            const isSport = SPORTS_PREFIXES.some(p => ticker.startsWith(p) || eventTicker.startsWith(p));
            // Attach sports flag directly to the raw market object copy
            return { ...m, _needsOddsConfirmation: isSport };
        });

        report.candidates = candidates.length;

        // Limit how many we analyze (Claude calls are expensive)
        const toAnalyze = candidates.slice(0, parseInt(marketLimit));
        let budgetLeft = budget;
        const ownedTickers = new Set(existingPositions);

        for (const rawMarket of toAnalyze) {
            if (budgetLeft < 1) break;

            // Skip markets we already have a position in (prevent stacking orders)
            if (ownedTickers.has(rawMarket.ticker)) continue;

            const market = normalizeMarket(rawMarket);
            const yesPriceDollars = parseFloat(rawMarket.last_price_dollars) || parseFloat(rawMarket.yes_bid_dollars) || 0;
            const yesPriceCents = Math.round(yesPriceDollars * 100);
            const isSportsMarket = rawMarket._needsOddsConfirmation;

            try {
                // ─── Sports odds gate: check bookmaker data BEFORE Claude call ───
                let oddsData = null;
                let bookmakerNoProb = null; // vig-free consensus NO probability from bookmakers
                let bookmakerLongshotProb = null; // vig-free YES (longshot) probability

                if (isSportsMarket) {
                    // For sports, we MUST have bookmaker odds — no external data = no trade
                    if (allOdds.length === 0) {
                        const category = categorizeMarket(rawMarket.ticker, market.question);
                        const skipReason = 'Sports market skipped: no odds API data available';
                        report.analyses.push({
                            market: market.question, ticker: rawMarket.ticker, category,
                            yesPrice: yesPriceCents, passed: false, skipReason, isSport: true,
                        });
                        try { logDecision({ strategy: 'safe-compounder', ticker: rawMarket.ticker, category, market: market.question, action: 'SKIP', reason: skipReason }); } catch {}
                        continue;
                    }

                    oddsData = findMatchingOdds(market.question, allOdds);

                    if (!oddsData || !oddsData.consensus) {
                        const category = categorizeMarket(rawMarket.ticker, market.question);
                        const skipReason = 'Sports market skipped: no matching bookmaker odds found';
                        report.analyses.push({
                            market: market.question, ticker: rawMarket.ticker, category,
                            yesPrice: yesPriceCents, passed: false, skipReason, isSport: true,
                        });
                        try { logDecision({ strategy: 'safe-compounder', ticker: rawMarket.ticker, category, market: market.question, action: 'SKIP', reason: skipReason }); } catch {}
                        continue;
                    }

                    // Find the longshot side probability from bookmaker consensus.
                    // The Kalshi YES side is the longshot (YES <= 20c means <20% implied).
                    // We look for the lowest consensus probability among all outcomes — that's the longshot.
                    const consensusEntries = Object.entries(oddsData.consensus);
                    let minProb = 1;
                    let maxProb = 0;
                    for (const [, data] of consensusEntries) {
                        if (data.avgProb < minProb) minProb = data.avgProb;
                        if (data.avgProb > maxProb) maxProb = data.avgProb;
                    }

                    // The longshot's consensus probability
                    bookmakerLongshotProb = minProb;
                    bookmakerNoProb = 1 - bookmakerLongshotProb;

                    // Gate 1: If bookmaker says longshot has >20% chance, not a clear enough longshot
                    if (bookmakerLongshotProb > 0.20) {
                        const category = categorizeMarket(rawMarket.ticker, market.question);
                        const skipReason = `Sports longshot at ${(bookmakerLongshotProb * 100).toFixed(1)}% > 20% bookmaker threshold`;
                        report.analyses.push({
                            market: market.question, ticker: rawMarket.ticker, category,
                            yesPrice: yesPriceCents, passed: false, skipReason, isSport: true,
                            bookmakerLongshotProb: parseFloat(bookmakerLongshotProb.toFixed(3)),
                        });
                        try { logDecision({ strategy: 'safe-compounder', ticker: rawMarket.ticker, category, market: market.question, action: 'SKIP', reason: skipReason, bookmakerLongshotProb }); } catch {}
                        continue;
                    }
                }

                // Fetch order book + news in parallel
                const [obData, newsContext] = await Promise.all([
                    getOrderBook(rawMarket.ticker).catch(() => null),
                    searchNews(market.question, searchKeys).catch(() => null),
                ]);

                const ob = obData ? summarizeOrderBook(obData) : null;

                // ─── Determine trueNoProb based on sports vs non-sports ───
                let trueYesProb;
                let trueNoProb;
                let reasoning;
                let usedBookmakerDirectly = false;

                if (isSportsMarket && bookmakerLongshotProb !== null && bookmakerLongshotProb <= 0.15) {
                    // Bookmaker says longshot has <=15%: use bookmaker NO probability directly
                    // (don't rely on Claude for sports — bookmakers are better calibrated)
                    trueNoProb = bookmakerNoProb;
                    trueYesProb = bookmakerLongshotProb;
                    reasoning = `Bookmaker consensus: longshot at ${(bookmakerLongshotProb * 100).toFixed(1)}% (vig-free). Using bookmaker NO prob directly.`;
                    usedBookmakerDirectly = true;
                } else {
                    // Non-sports path OR sports with 15-20% longshot (needs Claude confirmation)
                    const newsSnippet = newsContext?.headlines?.length
                        ? '\nRecent news: ' + newsContext.headlines.slice(0, 3).join('; ')
                        : '';

                    // For sports with odds in the 15-20% zone, include bookmaker context for Claude
                    const oddsContext = (isSportsMarket && oddsData)
                        ? '\n' + formatOddsForPrompt(oddsData)
                        : '';

                    // NOTE: Do NOT show the market price to prevent anchoring bias.
                    // Claude should estimate probability independently.
                    const selfReflection = buildSelfReflectionContext(20);
                    const claudePrompt = `You are estimating the probability of an event. Give your INDEPENDENT estimate — do NOT consider any market price.
${selfReflection}
Question: ${market.question}
Description: ${market.description || 'No description available'}
${newsSnippet}${oddsContext}

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

                    trueYesProb = Math.max(0, Math.min(1, parseFloat(analysis.trueYesProb) || 0.5));
                    trueNoProb = 1 - trueYesProb;
                    reasoning = analysis.reasoning || '';

                    // For sports in the 15-20% zone: Claude must agree with bookmaker direction
                    if (isSportsMarket && bookmakerLongshotProb !== null) {
                        // Bookmaker says longshot is 15-20%. Claude must also say YES < 20%.
                        if (trueYesProb > 0.20) {
                            const category = categorizeMarket(rawMarket.ticker, market.question);
                            const skipReason = `Sports 15-20% zone: Claude YES ${(trueYesProb * 100).toFixed(0)}% disagrees with bookmaker ${(bookmakerLongshotProb * 100).toFixed(0)}%`;
                            report.analyses.push({
                                market: market.question, ticker: rawMarket.ticker, category,
                                yesPrice: yesPriceCents, passed: false, skipReason, isSport: true,
                                bookmakerLongshotProb: parseFloat(bookmakerLongshotProb.toFixed(3)),
                                claudeYesProb: parseFloat(trueYesProb.toFixed(3)),
                            });
                            try { logDecision({ strategy: 'safe-compounder', ticker: rawMarket.ticker, category, market: market.question, action: 'SKIP', reason: skipReason, bookmakerLongshotProb, claudeYesProb: trueYesProb }); } catch {}
                            continue;
                        }
                    }
                }

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
                const minEdge = isSportsMarket ? SPORTS_MIN_EDGE : DEFAULT_MIN_EDGE;

                const category = categorizeMarket(rawMarket.ticker, market.question);
                const analysisRecord = {
                    market: market.question,
                    ticker: rawMarket.ticker,
                    category,
                    yesPrice: yesPriceCents,
                    estimatedNoProb: parseFloat(trueNoProb.toFixed(3)),
                    bestNoAskCents,
                    edge: parseFloat(edge.toFixed(3)),
                    reasoning,
                    newsProvider: newsContext?.provider || 'none',
                    passed: false,
                };

                // Add sports-specific fields to analysis record
                if (isSportsMarket) {
                    analysisRecord.isSport = true;
                    analysisRecord.hadOdds = true;
                    analysisRecord.bookmakerLongshotProb = bookmakerLongshotProb != null ? parseFloat(bookmakerLongshotProb.toFixed(3)) : null;
                    analysisRecord.bookmakerNoProb = bookmakerNoProb != null ? parseFloat(bookmakerNoProb.toFixed(3)) : null;
                    analysisRecord.usedBookmakerDirectly = usedBookmakerDirectly;
                    analysisRecord.minEdge = SPORTS_MIN_EDGE;
                }

                // 4. Only proceed if true NO prob >= 90%
                if (trueNoProb < 0.90) {
                    analysisRecord.skipReason = `NO prob ${(trueNoProb * 100).toFixed(0)}% < 90% threshold`;
                    report.analyses.push(analysisRecord);
                    try { logDecision({ strategy: 'safe-compounder', ticker: rawMarket.ticker, category, market: market.question, action: 'SKIP', rawNoProb: trueNoProb, edge, reason: analysisRecord.skipReason, ...(isSportsMarket && { hadOdds: true, bookmakerNoProb }) }); } catch {}
                    continue;
                }

                // 5. Require edge > threshold (7c for sports, 5c for non-sports)
                if (edge <= minEdge) {
                    analysisRecord.skipReason = `Edge ${(edge * 100).toFixed(1)}¢ <= ${(minEdge * 100).toFixed(0)}¢ threshold${isSportsMarket ? ' (sports)' : ''}`;
                    report.analyses.push(analysisRecord);
                    try { logDecision({ strategy: 'safe-compounder', ticker: rawMarket.ticker, category, market: market.question, action: 'SKIP', rawNoProb: trueNoProb, edge, reason: analysisRecord.skipReason, ...(isSportsMarket && { hadOdds: true, bookmakerNoProb }) }); } catch {}
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
                    reasoning,
                    edge,
                });

                // Enrich trade with full data source flags for empirical tracking
                trade.category = category;
                trade.hadNews = !!(newsContext?.headlines?.length);
                trade.hadEnsemble = false;
                trade.hadSports = false;
                trade.hadEconomic = false;
                trade.hadWeather = false;
                trade.rawProbability = trueYesProb;
                trade.marketPrice = yesPriceDollars;
                trade.estimated_edge = edge;
                trade.apiCost = usedBookmakerDirectly ? 0 : 0.10;
                if (isSportsMarket) {
                    trade.hadOdds = true;
                    trade.bookmakerNoProb = bookmakerNoProb != null ? parseFloat(bookmakerNoProb.toFixed(3)) : null;
                    trade.bookmakerLongshotProb = bookmakerLongshotProb != null ? parseFloat(bookmakerLongshotProb.toFixed(3)) : null;
                    trade.usedBookmakerDirectly = usedBookmakerDirectly;
                    trade.isSport = true;
                }
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
        // Set 20-minute expiration so stale orders don't fill at bad prices
        const expirationTs = Math.floor(Date.now() / 1000) + 20 * 60;
        const result = await placeOrder(
            {
                ticker,
                side: 'no',
                action: 'buy',
                count,
                type: 'limit',
                no_price: noPriceCents,
                expiration_ts: expirationTs,
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
