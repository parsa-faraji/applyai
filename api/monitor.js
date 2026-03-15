// Vercel Serverless Function — Position Monitor
//
// Checks all open positions against live prices (Polymarket + Kalshi).
// Detects: stop-loss, trailing stop, take-profit, price spikes,
// momentum reversals, time-based urgency, and near-resolution.
// Returns a list of recommended actions (exit, hold, add).

import { getMidpoint, getBestPrice } from './lib/clob.js';
import { getOrderBook as getKalshiOrderBook, summarizeOrderBook as summarizeKalshiOB } from './lib/kalshi.js';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const {
        positions = [],
        stopLossPct = 30,         // exit if down 30% from entry
        takeProfitPct = 50,       // exit if up 50% from entry
        trailingStopPct = 15,     // NEW: exit if price drops 15% from peak
        spikeThreshold = 15,      // alert if price moves >15 points
        momentumWindow = 5,       // NEW: number of recent prices to detect reversal
    } = req.body;

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

            // --- EXIT CHECKS (priority order) ---

            // 1. Stop-loss: down too much from entry
            if (pnlPct <= -stopLossPct) {
                alerts.push({
                    type: 'stop_loss',
                    severity: 'critical',
                    market: pos.market,
                    message: `STOP LOSS: ${pos.outcome} down ${Math.abs(pnlPct).toFixed(1)}% from entry. Entry: ${cents(entryPrice)}, Now: ${cents(livePrice)}`,
                    tokenId: pos.tokenId,
                });
                actions.push({
                    type: 'exit',
                    reason: 'stop_loss',
                    tokenId: pos.tokenId,
                    market: pos.market,
                    outcome: pos.outcome,
                    shares: pos.shares,
                    currentPrice: livePrice,
                    pnlPct,
                });
            }

            // 2. Trailing stop: was profitable, now giving back gains
            // Only triggers if position was up at least 10% at some point
            else if (pnlPct > 0 && highWater > entryPrice * 1.10 && dropFromPeak >= trailingStopPct) {
                const peakPnl = ((highWater - entryPrice) / entryPrice * 100).toFixed(1);
                alerts.push({
                    type: 'trailing_stop',
                    severity: 'warning',
                    market: pos.market,
                    message: `TRAILING STOP: ${pos.outcome} peaked at +${peakPnl}%, now dropped ${dropFromPeak.toFixed(1)}% from peak. Locking in remaining +${pnlPct.toFixed(1)}% profit.`,
                    tokenId: pos.tokenId,
                });
                actions.push({
                    type: 'exit',
                    reason: 'trailing_stop',
                    tokenId: pos.tokenId,
                    market: pos.market,
                    outcome: pos.outcome,
                    shares: pos.shares,
                    currentPrice: livePrice,
                    pnlPct,
                });
            }

            // 3. Take-profit: up beyond target
            else if (pnlPct >= takeProfitPct) {
                alerts.push({
                    type: 'take_profit',
                    severity: 'positive',
                    market: pos.market,
                    message: `TAKE PROFIT: ${pos.outcome} up ${pnlPct.toFixed(1)}% (target: ${takeProfitPct}%). Entry: ${cents(entryPrice)}, Now: ${cents(livePrice)}`,
                    tokenId: pos.tokenId,
                });
                actions.push({
                    type: 'exit',
                    reason: 'take_profit',
                    tokenId: pos.tokenId,
                    market: pos.market,
                    outcome: pos.outcome,
                    shares: pos.shares,
                    currentPrice: livePrice,
                    pnlPct,
                });
            }

            // 4. Momentum reversal: price was going your way, now reversing hard
            else if (momentum.reversal && Math.abs(pnlPct) >= 5) {
                const goingAgainst = (pos.outcome === 'Yes' && momentum.direction === 'falling') ||
                                     (pos.outcome === 'No' && momentum.direction === 'rising');
                if (goingAgainst && momentum.strength >= 0.6) {
                    alerts.push({
                        type: 'momentum_reversal',
                        severity: 'warning',
                        market: pos.market,
                        message: `REVERSAL: ${pos.outcome} momentum turned ${momentum.direction} (strength: ${(momentum.strength * 100).toFixed(0)}%). Price moving against your position.`,
                        tokenId: pos.tokenId,
                    });
                    // Don't auto-exit on reversal alone, but flag for review
                    // Only auto-exit if also losing
                    if (pnlPct < 0) {
                        actions.push({
                            type: 'exit',
                            reason: 'momentum_reversal',
                            tokenId: pos.tokenId,
                            market: pos.market,
                            outcome: pos.outcome,
                            shares: pos.shares,
                            currentPrice: livePrice,
                            pnlPct,
                        });
                    }
                }
            }

            // 5. Price spike detection (something big happened)
            else if (Math.abs(pnlPct) >= spikeThreshold && !pos.spikeAlerted) {
                const direction = pnlPct > 0 ? 'surged' : 'dropped';
                alerts.push({
                    type: 'spike',
                    severity: 'warning',
                    market: pos.market,
                    message: `PRICE SPIKE: ${pos.outcome} ${direction} ${Math.abs(pnlPct).toFixed(1)}% since entry. Review this position.`,
                    tokenId: pos.tokenId,
                });
                updated.spikeAlerted = true;
            }

            // 6. Time-based urgency: market resolving soon
            if (pos.endDate) {
                const hoursLeft = (new Date(pos.endDate) - new Date()) / (1000 * 60 * 60);
                if (hoursLeft > 0 && hoursLeft <= 24) {
                    updated.hoursToResolution = hoursLeft;

                    // If less than 6 hours and position is losing, suggest exit
                    // (don't hold a losing position into resolution — binary outcome risk)
                    if (hoursLeft <= 6 && pnlPct < -5) {
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
                            tokenId: pos.tokenId,
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
                            tokenId: pos.tokenId,
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
                        tokenId: pos.tokenId,
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
    try {
        const obData = await getKalshiOrderBook(ticker);
        const ob = summarizeKalshiOB(obData);
        if (!ob) return { mid: null };

        const isYes = (outcome || 'Yes').toLowerCase() === 'yes';
        const mid = ob.midpoint ? ob.midpoint / 100 : null; // convert cents to 0-1
        const bestBid = isYes ? (ob.bestYesBid ? ob.bestYesBid / 100 : null) : (ob.bestNoBid ? ob.bestNoBid / 100 : null);
        const bestAsk = isYes ? (ob.bestYesAsk ? ob.bestYesAsk / 100 : null) : null;

        return { mid, bestBid, bestAsk, spread: ob.spread ? ob.spread / 100 : null };
    } catch {
        return { mid: null };
    }
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
 * Detect momentum direction and reversals from recent price data
 * Returns { direction: 'rising'|'falling'|'flat', strength: 0-1, reversal: boolean }
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
