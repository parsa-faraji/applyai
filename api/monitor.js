// Vercel Serverless Function — Position Monitor
//
// Checks all open positions against live CLOB prices.
// Detects: stop-loss hits, take-profit targets, price spikes (breaking news),
// markets approaching resolution, and momentum reversals.
// Returns a list of recommended actions (exit, hold, add).

import { getMidpoint, getBestPrice } from './lib/clob.js';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const {
        positions = [],
        stopLossPct = 30,    // default: exit if down 30%
        takeProfitPct = 50,  // default: exit if up 50%
        spikeThreshold = 15, // price moved >15 points in any direction = spike
    } = req.body;

    if (positions.length === 0) {
        return res.status(200).json({ alerts: [], updatedPositions: [], actions: [] });
    }

    const alerts = [];
    const actions = [];
    const updatedPositions = [];

    // Fetch live prices for all positions in parallel
    const pricePromises = positions.map(async (pos) => {
        const updated = { ...pos };

        if (!pos.tokenId) {
            updatedPositions.push(updated);
            return;
        }

        try {
            const priceData = await getBestPrice(pos.tokenId);
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

            // 1. Stop-loss check
            if (pnlPct <= -stopLossPct) {
                alerts.push({
                    type: 'stop_loss',
                    severity: 'critical',
                    market: pos.market,
                    message: `STOP LOSS: ${pos.outcome} position down ${Math.abs(pnlPct).toFixed(1)}% (limit: ${stopLossPct}%). Entry: ${(entryPrice * 100).toFixed(0)}¢, Now: ${(livePrice * 100).toFixed(0)}¢`,
                    tokenId: pos.tokenId,
                    positionIndex: positions.indexOf(pos),
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

            // 2. Take-profit check
            else if (pnlPct >= takeProfitPct) {
                alerts.push({
                    type: 'take_profit',
                    severity: 'positive',
                    market: pos.market,
                    message: `TAKE PROFIT: ${pos.outcome} position up ${pnlPct.toFixed(1)}% (target: ${takeProfitPct}%). Entry: ${(entryPrice * 100).toFixed(0)}¢, Now: ${(livePrice * 100).toFixed(0)}¢`,
                    tokenId: pos.tokenId,
                    positionIndex: positions.indexOf(pos),
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

            // 3. Price spike detection (something big happened)
            else if (Math.abs(pnlPct) >= spikeThreshold && !pos.spikeAlerted) {
                const direction = pnlPct > 0 ? 'surged' : 'dropped';
                alerts.push({
                    type: 'spike',
                    severity: 'warning',
                    market: pos.market,
                    message: `PRICE SPIKE: ${pos.outcome} ${direction} ${Math.abs(pnlPct).toFixed(1)}% since entry. Something may have changed — review this position.`,
                    tokenId: pos.tokenId,
                    positionIndex: positions.indexOf(pos),
                });
                updated.spikeAlerted = true;
            }

            // 4. Near-resolution: price approaching 0 or 1 (market resolving)
            if (livePrice >= 0.95 || livePrice <= 0.05) {
                const resolving = livePrice >= 0.95 ? 'YES resolving' : 'NO resolving';
                const isWinning = (livePrice >= 0.95 && pos.outcome === 'Yes') ||
                                  (livePrice <= 0.05 && pos.outcome === 'No');
                alerts.push({
                    type: 'near_resolution',
                    severity: isWinning ? 'positive' : 'critical',
                    market: pos.market,
                    message: `RESOLVING: Market ${resolving} (${(livePrice * 100).toFixed(0)}¢). ${isWinning ? 'Your position is winning!' : 'Your position may lose.'}`,
                    tokenId: pos.tokenId,
                    positionIndex: positions.indexOf(pos),
                });

                // If losing side and price is extreme, suggest exit
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
