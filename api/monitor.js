// Vercel Serverless Function — Position Monitor
//
// Checks all open positions against live prices (Polymarket + Kalshi).
// Detects: stop-loss, trailing stop, take-profit, price spikes,
// momentum reversals, time-based urgency, and near-resolution.
// Returns a list of recommended actions (exit, hold, add).

import { getMidpoint, getBestPrice } from './lib/clob.js';
import { getOrderBook as getKalshiOrderBook, summarizeOrderBook as summarizeKalshiOB, getMarket as getKalshiMarket } from './lib/kalshi.js';
import { searchNews } from './lib/search.js';
import { getAllSportsOdds, findMatchingOdds, formatOddsForPrompt } from './lib/odds.js';
import { getSportsContext } from './lib/sports.js';
import { buildSelfReflectionContext, logMonitorDecision } from './lib/trade-logger.js';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Anthropic-Key, X-Brave-Key, X-Odds-Key');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const {
        positions = [],
        stopLossPct = 30,
        takeProfitPct = 50,
        trailingStopPct = 15,
        spikeThreshold = 15,
        momentumWindow = 5,
    } = req.body;

    // API keys for smart exit analysis
    const anthropicKey = req.headers['x-anthropic-key'] || process.env.ANTHROPIC_API_KEY || '';
    const braveKey = req.headers['x-brave-key'] || process.env.BRAVE_API_KEY || '';
    const oddsKey = req.headers['x-odds-key'] || process.env.ODDS_API_KEY || '';

    if (positions.length === 0) {
        return res.status(200).json({ alerts: [], updatedPositions: [], actions: [] });
    }

    const alerts = [];
    const actions = [];
    const updatedPositions = [];

    // Fetch live prices + recent history for all positions in parallel
    const pricePromises = positions.map(async (pos) => {
        const updated = { ...pos };

        const posId = pos.tokenId || pos.ticker;
        if (!posId) {
            updatedPositions.push(updated);
            return;
        }

        try {
            // Fetch current price — route to correct exchange
            const isKalshi = pos.exchange === 'kalshi';
            const [priceData, recentPrices] = await Promise.all([
                isKalshi ? getKalshiPrice(pos.ticker, pos.outcome) : getBestPrice(pos.tokenId),
                isKalshi ? Promise.resolve([]) : fetchRecentPrices(pos.tokenId),
            ]);

            const livePrice = priceData.mid;

            if (livePrice == null) {
                updatedPositions.push(updated);
                return;
            }

            updated.currentPrice = livePrice;
            updated.bestBid = priceData.bestBid;
            updated.bestAsk = priceData.bestAsk;
            updated.spread = priceData.spread;

            const entryPrice = pos.avgPrice || pos.entryPrice;
            const pnlPct = entryPrice > 0 ? ((livePrice - entryPrice) / entryPrice) * 100 : 0;
            const pnlAbs = (livePrice - entryPrice) * (pos.shares || 0);
            updated.pnlPct = pnlPct;
            updated.pnlAbs = pnlAbs;

            // Track high-water mark for trailing stop
            const prevHighWater = pos.highWaterPrice || entryPrice;
            const highWater = Math.max(prevHighWater, livePrice);
            updated.highWaterPrice = highWater;

            const dropFromPeak = highWater > 0 ? ((highWater - livePrice) / highWater) * 100 : 0;
            updated.dropFromPeak = dropFromPeak;

            // Detect momentum direction from recent prices
            const momentum = detectMomentum(recentPrices, momentumWindow);
            updated.momentum = momentum.direction;
            updated.momentumStrength = momentum.strength;

            // --- SMART EXIT: Only sell when Claude says to, based on data ---
            // No dumb stop-losses. Prediction markets resolve at $0 or $1.
            // Hold through dips. Only exit if the thesis changed.

            const exitCandidate = { tokenId: pos.tokenId, ticker: pos.ticker, exchange: pos.exchange, market: pos.market, outcome: pos.outcome, shares: pos.shares, currentPrice: livePrice, pnlPct };

            // Check if position is worth reviewing (significant move or nearing expiry)
            const worthReviewing = Math.abs(pnlPct) >= 10 || (pos.endDate && ((new Date(pos.endDate) - new Date()) / 3600000) < 6);

            if (worthReviewing && anthropicKey) {
                const triggerMsg = pnlPct <= 0
                    ? `Down ${Math.abs(pnlPct).toFixed(1)}% (${cents(entryPrice)} → ${cents(livePrice)})`
                    : `Up ${pnlPct.toFixed(1)}% (${cents(entryPrice)} → ${cents(livePrice)})`;
                const triggerType = pnlPct <= -20 ? 'losing' : pnlPct >= 20 ? 'winning' : 'expiring';

                const decision = await smartExitAnalysis(pos, livePrice, pnlPct, entryPrice, triggerType, triggerMsg, anthropicKey, braveKey, oddsKey).catch(() => ({ action: 'HOLD', reasoning: 'Analysis failed — holding by default' }));

                // Persist every monitor decision for audit trail
                try {
                    logMonitorDecision({
                        ticker: pos.ticker,
                        market: pos.market,
                        outcome: pos.outcome,
                        strategy: pos.strategy || 'unknown',
                        entryPrice,
                        livePrice,
                        pnlPct,
                        triggerType,
                        triggerMsg,
                        decision: decision.action,
                        reasoning: decision.reasoning,
                        endDate: pos.endDate || null,
                        hoursToResolution: pos.endDate ? (new Date(pos.endDate) - new Date()) / 3600000 : null,
                    });
                } catch {}

                if (decision.action === 'SELL') {
                    alerts.push({ type: 'smart_exit', severity: 'critical', market: pos.market, message: `SMART EXIT: ${triggerMsg}. Claude says: ${decision.reasoning}`, tokenId: pos.tokenId });
                    actions.push({ type: 'exit', reason: `smart_${triggerType}`, ...exitCandidate });
                } else {
                    alerts.push({ type: 'smart_hold', severity: 'info', market: pos.market, message: `HOLDING: ${triggerMsg}. Claude says: ${decision.reasoning}`, tokenId: pos.tokenId });
                }
            }

            // 6. Time-based urgency: market resolving soon
            if (pos.endDate) {
                const hoursLeft = (new Date(pos.endDate) - new Date()) / (1000 * 60 * 60);
                if (hoursLeft > 0 && hoursLeft <= 24) {
                    updated.hoursToResolution = hoursLeft;

                    // Only auto-exit in extreme cases (< 1h left, down big)
                    // Prediction markets resolve at $0 or $1 — premature exits lock in small losses
                    if (hoursLeft <= 1 && pnlPct < -15) {
                        alerts.push({
                            type: 'expiring_soon',
                            severity: 'critical',
                            market: pos.market,
                            message: `EXPIRING: Market resolves in ${hoursLeft.toFixed(1)}h. Position is down ${Math.abs(pnlPct).toFixed(1)}%. Consider exiting to avoid binary resolution risk.`,
                            tokenId: pos.tokenId,
                        });
                        actions.push({
                            type: 'exit',
                            reason: 'expiring_losing',
                            tokenId: pos.tokenId, ticker: pos.ticker, exchange: pos.exchange,
                            market: pos.market,
                            outcome: pos.outcome,
                            shares: pos.shares,
                            currentPrice: livePrice,
                            pnlPct,
                            hoursLeft,
                        });
                    }
                    // If less than 2 hours and profitable, take profit (lock it in before resolution)
                    else if (hoursLeft <= 2 && pnlPct >= 10) {
                        alerts.push({
                            type: 'expiring_soon',
                            severity: 'positive',
                            market: pos.market,
                            message: `EXPIRING: Market resolves in ${hoursLeft.toFixed(1)}h. Position is up ${pnlPct.toFixed(1)}%. Consider taking profit before resolution.`,
                            tokenId: pos.tokenId,
                        });
                        actions.push({
                            type: 'exit',
                            reason: 'expiring_profitable',
                            tokenId: pos.tokenId, ticker: pos.ticker, exchange: pos.exchange,
                            market: pos.market,
                            outcome: pos.outcome,
                            shares: pos.shares,
                            currentPrice: livePrice,
                            pnlPct,
                            hoursLeft,
                        });
                    }
                    // Alert if <24h regardless
                    else if (hoursLeft <= 24) {
                        alerts.push({
                            type: 'expiring_soon',
                            severity: 'info',
                            market: pos.market,
                            message: `Market resolves in ${hoursLeft.toFixed(0)}h. Position: ${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(1)}%.`,
                            tokenId: pos.tokenId,
                        });
                    }
                }
            }

            // 7. Near-resolution: price approaching 0 or 1
            if (livePrice >= 0.95 || livePrice <= 0.05) {
                const resolving = livePrice >= 0.95 ? 'YES resolving' : 'NO resolving';
                const isWinning = (livePrice >= 0.95 && pos.outcome === 'Yes') ||
                                  (livePrice <= 0.05 && pos.outcome === 'No');
                alerts.push({
                    type: 'near_resolution',
                    severity: isWinning ? 'positive' : 'critical',
                    market: pos.market,
                    message: `RESOLVING: Market ${resolving} (${cents(livePrice)}). ${isWinning ? 'Your position is winning!' : 'Your position may lose.'}`,
                    tokenId: pos.tokenId,
                });

                if (!isWinning) {
                    actions.push({
                        type: 'exit',
                        reason: 'near_resolution_losing',
                        tokenId: pos.tokenId, ticker: pos.ticker, exchange: pos.exchange,
                        market: pos.market,
                        outcome: pos.outcome,
                        shares: pos.shares,
                        currentPrice: livePrice,
                        pnlPct,
                    });
                }
            }

            updatedPositions.push(updated);
        } catch (err) {
            updated.priceError = err.message;
            updatedPositions.push(updated);
        }
    });

    await Promise.all(pricePromises);

    return res.status(200).json({
        timestamp: new Date().toISOString(),
        alerts,
        actions,
        updatedPositions,
        positionsChecked: positions.length,
    });
}

/**
 * Get live price from Kalshi order book
 */
async function getKalshiPrice(ticker, outcome) {
    const isYes = (outcome || 'Yes').toLowerCase() === 'yes';

    try {
        // Try order book first
        const obData = await getKalshiOrderBook(ticker);
        const ob = summarizeKalshiOB(obData);

        if (ob && ob.midpoint) {
            // Midpoint is the YES price — flip for NO positions
            const yesMid = ob.midpoint / 100;
            const mid = isYes ? yesMid : 1 - yesMid;
            return {
                mid,
                bestBid: isYes ? (ob.bestYesBid ? ob.bestYesBid / 100 : null) : (ob.bestNoBid ? ob.bestNoBid / 100 : null),
                bestAsk: isYes ? (ob.bestYesAsk ? ob.bestYesAsk / 100 : null) : null,
                spread: ob.spread ? ob.spread / 100 : null,
            };
        }
    } catch {}

    // Fallback: use last_price from market data (works even with empty order books)
    // last_price_dollars is the YES price — flip for NO
    try {
        const marketData = await getKalshiMarket(ticker);
        const m = marketData.market || marketData;
        const lastPrice = parseFloat(m.last_price_dollars || '0');
        if (lastPrice > 0) {
            const mid = isYes ? lastPrice : 1 - lastPrice;
            return { mid, bestBid: null, bestAsk: null, spread: null };
        }
    } catch {}

    return { mid: null };
}

/**
 * Fetch last 2 hours of 1-minute price data for momentum detection
 */
async function fetchRecentPrices(tokenId) {
    try {
        const now = Math.floor(Date.now() / 1000);
        const resp = await fetch(
            `https://clob.polymarket.com/prices-history?market=${tokenId}&startTs=${now - 7200}&endTs=${now}&fidelity=60`
        );
        if (!resp.ok) return [];
        const data = await resp.json();
        return (data.history || []).map(p => parseFloat(p.p));
    } catch {
        return [];
    }
}

/**
 * Detect momentum direction and reversals from recent price data.
 * Compares two consecutive windows of prices to determine trend.
 *
 * @param {number[]} prices - Array of recent prices (chronological order)
 * @param {number} [window=5] - Number of data points per comparison window
 * @returns {{direction: 'rising'|'falling'|'flat', strength: number, reversal: boolean}}
 *   - direction: current price trend
 *   - strength: 0-1 normalized magnitude of the move
 *   - reversal: true if trend direction changed between windows
 */
function detectMomentum(prices, window = 5) {
    if (!prices || prices.length < window * 2) {
        return { direction: 'flat', strength: 0, reversal: false };
    }

    // Compare two windows: the previous window vs the most recent window
    const recent = prices.slice(-window);
    const previous = prices.slice(-window * 2, -window);

    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const previousAvg = previous.reduce((a, b) => a + b, 0) / previous.length;
    const recentTrend = recent[recent.length - 1] - recent[0];
    const previousTrend = previous[previous.length - 1] - previous[0];

    // Direction based on recent window
    const diff = recentAvg - previousAvg;
    let direction = 'flat';
    if (diff > 0.01) direction = 'rising';
    else if (diff < -0.01) direction = 'falling';

    // Strength: how much the price moved relative to total range
    const allPrices = [...previous, ...recent];
    const range = Math.max(...allPrices) - Math.min(...allPrices);
    const strength = range > 0 ? Math.min(1, Math.abs(diff) / range) : 0;

    // Reversal: previous trend was in one direction, recent trend reversed
    const reversal = (previousTrend > 0.01 && recentTrend < -0.01) ||
                     (previousTrend < -0.01 && recentTrend > 0.01);

    return { direction, strength, reversal };
}

function cents(price) {
    return (price * 100).toFixed(0) + '¢';
}

/**
 * Ask Claude whether to sell or hold a position that hit a threshold.
 * Returns { action: 'SELL' | 'HOLD', reasoning: string }
 */
async function smartExitAnalysis(pos, livePrice, pnlPct, entryPrice, triggerType, triggerMsg, anthropicKey, braveKey, oddsKey) {
    // Gather ALL context: news + odds + live sports + economic + weather
    let context = '';

    // All data sources in parallel
    const [news, sportsCtx, econCtx, weatherCtx] = await Promise.all([
        searchNews(pos.market, { braveKey }).catch(() => null),
        getSportsContext(pos.market).catch(() => ''),
        import('./lib/fred.js').then(m => m.getEconomicContext(pos.market)).catch(() => ''),
        import('./lib/noaa.js').then(m => m.getWeatherContext(pos.market)).catch(() => ''),
    ]);

    if (news?.headlines?.length > 0) {
        context += '\n## Recent News\n' + news.headlines.map((h, i) => `- ${h}${news.snippets?.[i] ? ': ' + news.snippets[i] : ''}`).join('\n');
    }

    if (sportsCtx) context += '\n## Live Sports Data\n' + sportsCtx;
    if (econCtx) context += '\n## Economic Data\n' + econCtx;
    if (weatherCtx) context += '\n## Weather Data\n' + weatherCtx;

    // Only fetch odds for sports positions (save API quota — 500 req/month free tier)
    const isSportsMarket = /\b(nba|nfl|nhl|mlb|ncaa|ufc|mma|tennis|soccer|football|basketball|baseball|hockey)\b/i.test(pos.market || '');
    if (oddsKey && isSportsMarket) {
        try {
            const allOdds = await getAllSportsOdds(oddsKey).catch(() => []);
            const odds = findMatchingOdds(pos.market, allOdds);
            if (odds) context += formatOddsForPrompt(odds);
        } catch {}
    }

    const selfReflection = buildSelfReflectionContext(20);

    const prompt = `You are monitoring a prediction market position. A threshold was triggered and you must decide: SELL now or HOLD.
${selfReflection}
## Position
- **Market:** ${pos.market}
- **Side:** ${pos.outcome}
- **Entry Price:** ${cents(entryPrice)}
- **Current Price:** ${cents(livePrice)}
- **P&L:** ${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(1)}%
- **Trigger:** ${triggerType} — ${triggerMsg}
- **End Date:** ${pos.endDate || 'Unknown'}
${context}

## Decision Framework
- If the position is losing AND news/odds suggest it will keep losing → SELL
- If the position is losing BUT news/odds suggest a recovery is likely → HOLD
- If the position is profitable AND news/odds suggest the trend continues → HOLD for more
- If the position is profitable BUT showing signs of reversal → SELL to lock in profit
- If no news/odds data is available, lean toward HOLD (prediction markets resolve at $0 or $1 — premature exits lock in losses)
- Consider time to resolution — if the market resolves soon, holding a loser is riskier

## Grounding Rules
- ONLY cite facts from the data above. Do NOT fabricate news, scores, or events.
- If no relevant data is available, default to HOLD.
- Your reasoning must reference specific data points provided above.

## Response (JSON only)
{"action": "SELL" or "HOLD", "reasoning": "<1 sentence citing specific data above>"}`;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 200,
            temperature: 0,
            messages: [{ role: 'user', content: prompt }],
        }),
    });

    if (!resp.ok) throw new Error(`Claude API ${resp.status}`);
    const data = await resp.json();
    const text = data.content?.[0]?.text || '';

    try {
        const json = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{}');
        return { action: json.action === 'HOLD' ? 'HOLD' : 'SELL', reasoning: json.reasoning || 'No reasoning' };
    } catch {
        return { action: 'SELL', reasoning: 'Parse error — defaulting to sell' };
    }
}
