// Resolution checker + learning endpoint
// Checks settled markets, records win/loss, updates Platt scaling calibration,
// and tracks per-category/strategy performance.
//
// Called periodically by the autopilot (every ~10 cycles).
// Returns: { resolved, calibrationStats, performanceByCategory, performanceByStrategy }

import { getMarket } from './lib/kalshi.js';
import { readTrades, readDecisions, readCycleActions, logResolution } from './lib/trade-logger.js';
import { updateCalibration, getCalibrationStats } from './lib/calibration.js';

export const config = { maxDuration: 30 };

// In-memory performance tracking (survives across cycles within a deploy)
const performance = {
    byCategory: {},   // e.g. 'sports-nba': { wins, losses, totalPnl, ... }
    byStrategy: {},   // e.g. 'safe-compounder': { wins, losses, ... }
    resolved: new Set(),  // tickers we've already processed (avoid double-counting)
    lastCheck: 0,
};

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const report = {
        timestamp: new Date().toISOString(),
        tradesChecked: 0,
        newResolutions: 0,
        resolved: [],
        calibrationStats: null,
        performanceByCategory: {},
        performanceByStrategy: {},
        errors: [],
    };

    try {
        // 1. Read all logged trades
        const trades = readTrades();
        if (trades.length === 0) {
            report.calibrationStats = getCalibrationStats();
            report.performanceByCategory = performance.byCategory;
            report.performanceByStrategy = performance.byStrategy;
            return res.status(200).json(report);
        }

        // 2. Find trades we haven't checked yet
        const unchecked = trades.filter(t =>
            t.ticker && !performance.resolved.has(t.ticker)
        );
        report.tradesChecked = unchecked.length;

        // 3. Check each trade's market for resolution
        // Batch: check up to 20 per cycle to avoid rate limiting
        const toCheck = unchecked.slice(0, 20);

        const results = await Promise.allSettled(
            toCheck.map(async trade => {
                try {
                    const marketData = await getMarket(trade.ticker);
                    const market = marketData.market || marketData;
                    return { trade, market };
                } catch (err) {
                    return { trade, error: err.message };
                }
            })
        );

        for (const r of results) {
            if (r.status !== 'fulfilled') continue;
            const { trade, market, error } = r.value;

            if (error) {
                report.errors.push({ ticker: trade.ticker, error });
                continue;
            }

            if (!market) continue;

            // Check if market has settled
            const status = (market.status || '').toLowerCase();
            const isClosed = status === 'settled' || status === 'closed' || status === 'finalized';

            if (!isClosed) continue;

            // Determine outcome: last_price at 0 or 1 after settlement
            const settlementPrice = parseFloat(market.last_price_dollars || market.result_price || '');
            if (isNaN(settlementPrice)) continue;

            // YES resolved if settlement price >= 0.95, NO resolved if <= 0.05
            const yesWon = settlementPrice >= 0.95;
            const noWon = settlementPrice <= 0.05;

            if (!yesWon && !noWon) continue; // ambiguous — skip

            const tradeSide = (trade.side || trade.outcome || 'yes').toLowerCase();
            const tradeWon = (tradeSide === 'yes' && yesWon) || (tradeSide === 'no' && noWon);

            const entryPrice = trade.price || trade.avgPrice || 0.5;
            const pnlPerContract = tradeWon ? (1 - entryPrice) : -entryPrice;
            const contracts = trade.count || trade.shares || 1;
            const totalPnl = pnlPerContract * contracts;

            const resolution = {
                ticker: trade.ticker,
                market: trade.market || market.title,
                strategy: trade.strategy || 'unknown',
                category: trade.category || 'other',
                side: tradeSide,
                entryPrice,
                settlementPrice,
                won: tradeWon,
                pnlPerContract,
                totalPnl,
                contracts,
                hadOdds: trade.hadOdds || false,
                hadNews: trade.hadNews || false,
                hadEnsemble: trade.hadEnsemble || false,
                hadSports: trade.hadSports || false,
                hadEconomic: trade.hadEconomic || false,
                hadWeather: trade.hadWeather || false,
                edge: trade.edge || null,
                estimated_edge: trade.estimated_edge || trade.edge || null,
                rawProbability: trade.rawProbability || null,
                calibratedProbability: trade.calibratedProbability || null,
                marketPrice: trade.marketPrice || trade.price || null,
                apiCost: trade.apiCost || null,
                confidence: trade.confidence || null,
            };

            report.resolved.push(resolution);
            report.newResolutions++;
            performance.resolved.add(trade.ticker);

            // Persist resolution to JSONL for self-reflection context
            try { logResolution(resolution); } catch (err) { console.error('[learn] logResolution failed:', err.message); }

            // 4. Update Platt scaling calibration
            // MUST use the RAW (pre-calibration) probability, not the calibrated one.
            // Using calibrated values would cause double-calibration, pushing k→1.0.
            const rawProb = trade.rawProbability || null;
            if (rawProb != null) {
                const actual = yesWon ? 1 : 0;
                updateCalibration(rawProb, actual);
            }

            // 5. Track per-category performance
            const cat = resolution.category;
            if (!performance.byCategory[cat]) {
                performance.byCategory[cat] = { wins: 0, losses: 0, totalPnl: 0, trades: 0, winRate: 0 };
            }
            const catStats = performance.byCategory[cat];
            catStats.trades++;
            if (tradeWon) catStats.wins++; else catStats.losses++;
            catStats.totalPnl += totalPnl;
            catStats.winRate = catStats.trades > 0 ? catStats.wins / catStats.trades : 0;

            // 6. Track per-strategy performance
            const strat = resolution.strategy;
            if (!performance.byStrategy[strat]) {
                performance.byStrategy[strat] = { wins: 0, losses: 0, totalPnl: 0, trades: 0, winRate: 0 };
            }
            const stratStats = performance.byStrategy[strat];
            stratStats.trades++;
            if (tradeWon) stratStats.wins++; else stratStats.losses++;
            stratStats.totalPnl += totalPnl;
            stratStats.winRate = stratStats.trades > 0 ? stratStats.wins / stratStats.trades : 0;
        }

        // 7. Paper trade resolution tracking
        // Read paper trades from cycle-actions.jsonl and check if their markets resolved.
        // This lets the meta-agent evaluate auto-trade performance before promoting to live.
        const cycleActions = readCycleActions();
        const paperTrades = cycleActions.filter(a =>
            a.action === 'buy' && a.paper && a.ticker && !performance.resolved.has(a.ticker)
        );
        const paperToCheck = paperTrades.slice(0, 10);

        if (paperToCheck.length > 0) {
            const paperResults = await Promise.allSettled(
                paperToCheck.map(async pt => {
                    try {
                        const marketData = await getMarket(pt.ticker);
                        return { trade: pt, market: marketData.market || marketData };
                    } catch (err) {
                        return { trade: pt, error: err.message };
                    }
                })
            );

            for (const r of paperResults) {
                if (r.status !== 'fulfilled') continue;
                const { trade: pt, market, error } = r.value;
                if (error || !market) continue;

                const status = (market.status || '').toLowerCase();
                if (status !== 'settled' && status !== 'closed' && status !== 'finalized') continue;

                const settlementPrice = parseFloat(market.last_price_dollars || market.result_price || '');
                if (isNaN(settlementPrice)) continue;

                const yesWon = settlementPrice >= 0.95;
                const noWon = settlementPrice <= 0.05;
                if (!yesWon && !noWon) continue;

                const side = (pt.side || 'yes').toLowerCase();
                const won = (side === 'yes' && yesWon) || (side === 'no' && noWon);
                const entryPrice = pt.price || 0.5;
                const contracts = pt.count || 1;
                const pnlPerContract = won ? (1 - entryPrice) : -entryPrice;

                const resolution = {
                    ticker: pt.ticker,
                    market: pt.market || market.title,
                    strategy: pt.strategy || 'auto-trade',
                    category: pt.category || 'other',
                    side,
                    entryPrice,
                    settlementPrice,
                    won,
                    pnlPerContract,
                    totalPnl: pnlPerContract * contracts,
                    contracts,
                    paper: true,
                    edge: pt.edge || null,
                };

                report.resolved.push(resolution);
                report.newResolutions++;
                performance.resolved.add(pt.ticker);

                try { logResolution(resolution); } catch (err) { console.error('[learn] paper logResolution failed:', err.message); }

                // Track in performance stats (paper trades count for promotion evaluation)
                const cat = resolution.category;
                if (!performance.byCategory[cat]) performance.byCategory[cat] = { wins: 0, losses: 0, totalPnl: 0, trades: 0, winRate: 0 };
                performance.byCategory[cat].trades++;
                if (won) performance.byCategory[cat].wins++; else performance.byCategory[cat].losses++;
                performance.byCategory[cat].totalPnl += resolution.totalPnl;
                performance.byCategory[cat].winRate = performance.byCategory[cat].wins / performance.byCategory[cat].trades;

                const strat = resolution.strategy;
                if (!performance.byStrategy[strat]) performance.byStrategy[strat] = { wins: 0, losses: 0, totalPnl: 0, trades: 0, winRate: 0 };
                performance.byStrategy[strat].trades++;
                if (won) performance.byStrategy[strat].wins++; else performance.byStrategy[strat].losses++;
                performance.byStrategy[strat].totalPnl += resolution.totalPnl;
                performance.byStrategy[strat].winRate = performance.byStrategy[strat].wins / performance.byStrategy[strat].trades;
            }
        }

        performance.lastCheck = Date.now();

    } catch (err) {
        report.errors.push({ error: err.message });
    }

    report.calibrationStats = getCalibrationStats();
    report.performanceByCategory = performance.byCategory;
    report.performanceByStrategy = performance.byStrategy;

    return res.status(200).json(report);
}

/**
 * Get current performance stats (callable from other modules)
 */
export function getPerformanceStats() {
    return {
        byCategory: { ...performance.byCategory },
        byStrategy: { ...performance.byStrategy },
        totalResolved: performance.resolved.size,
        lastCheck: performance.lastCheck,
    };
}
