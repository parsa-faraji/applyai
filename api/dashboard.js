// Dashboard API — aggregates all bot data for the live UI.
// Reads JSONL logs, meta-config, calibration, and returns a summary.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

function readJsonl(filename, limit = 0) {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
    const parsed = lines.map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    return limit > 0 ? parsed.slice(-limit) : parsed;
}

function readJson(filename) {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { return null; }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        // Read all data sources
        const allCycles = readJsonl('cycle-actions.jsonl');
        const allResolutions = readJsonl('resolutions.jsonl');
        const allMonitor = readJsonl('monitor-decisions.jsonl', 30);
        const allTrades = readJsonl('trades.jsonl');
        const metaConfig = readJson('meta-config.json');
        const calibration = readJson('calibration.json');

        // Today's data
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayTs = todayStart.getTime();

        const todayCycles = allCycles.filter(a => new Date(a.timestamp).getTime() >= todayTs);
        const todayResolutions = allResolutions.filter(r => new Date(r.timestamp).getTime() >= todayTs);
        const todayTrades = allTrades.filter(t => new Date(t.timestamp).getTime() >= todayTs);

        const todayBuys = todayCycles.filter(a => a.action === 'buy');
        const todayExits = todayCycles.filter(a => a.action === 'exit');
        const todayExitFails = todayCycles.filter(a => a.action === 'exit_failed');

        // Strategy performance (all-time from resolutions)
        const strategies = {};
        for (const r of allResolutions) {
            const s = r.strategy || 'unknown';
            if (!strategies[s]) strategies[s] = { wins: 0, losses: 0, pnl: 0, trades: 0 };
            strategies[s].trades++;
            if (r.won) strategies[s].wins++; else strategies[s].losses++;
            strategies[s].pnl += r.totalPnl || 0;
        }

        // Category performance (all-time)
        const categories = {};
        for (const r of allResolutions) {
            const c = r.category || 'other';
            if (!categories[c]) categories[c] = { wins: 0, losses: 0, pnl: 0, trades: 0 };
            categories[c].trades++;
            if (r.won) categories[c].wins++; else categories[c].losses++;
            categories[c].pnl += r.totalPnl || 0;
        }

        // Recent activity (last 50 cycle actions, newest first)
        const recentActivity = allCycles.slice(-50).reverse().map(a => ({
            time: a.timestamp,
            action: a.action,
            strategy: a.strategy || '',
            ticker: a.ticker || '',
            market: a.market || '',
            side: a.side || '',
            count: a.count || 0,
            price: a.price || 0,
            paper: a.paper || false,
            reason: a.reason || '',
            edge: a.edge || null,
            error: a.error || '',
        }));

        // Paper trades tracker — merge cycle-action paper buys with resolution outcomes
        // Deduplicate: only show latest entry per ticker (bot may trade same ticker across cycles)
        const paperBuysRaw = allCycles.filter(a => a.action === 'buy' && a.paper && a.ticker);
        const seenPaperTickers = new Set();
        const paperBuys = paperBuysRaw.filter(pb => {
            if (seenPaperTickers.has(pb.ticker)) return false;
            seenPaperTickers.add(pb.ticker);
            return true;
        });

        const paperTrades = paperBuys.map(pb => {
            // Match resolution by ticker — don't require paper flag since trades.jsonl resolutions lack it
            const resolution = allResolutions.find(r => r.ticker === pb.ticker);
            if (resolution) {
                return {
                    ticker: pb.ticker,
                    market: pb.market || resolution.market || pb.ticker,
                    strategy: pb.strategy || 'auto-trade',
                    side: pb.side || 'yes',
                    entryPrice: pb.price || 0,
                    count: pb.count || 1,
                    edge: pb.edge || null,
                    time: pb.timestamp,
                    status: 'resolved',
                    won: resolution.won,
                    pnl: resolution.totalPnl || 0,
                    settlementPrice: resolution.settlementPrice,
                    resolvedAt: resolution.timestamp,
                };
            }
            return {
                ticker: pb.ticker,
                market: pb.market || pb.ticker,
                strategy: pb.strategy || 'auto-trade',
                side: pb.side || 'yes',
                entryPrice: pb.price || 0,
                count: pb.count || 1,
                edge: pb.edge || null,
                time: pb.timestamp,
                status: 'open',
            };
        }).reverse(); // newest first

        // Also include live (non-paper) trades — deduplicate by ticker
        const liveTradesRaw = allCycles.filter(a => a.action === 'buy' && !a.paper && a.ticker);
        const seenLiveTickers = new Set();
        const liveTradesBuys = liveTradesRaw.filter(lb => {
            if (seenLiveTickers.has(lb.ticker)) return false;
            seenLiveTickers.add(lb.ticker);
            return true;
        });
        const liveTrades = liveTradesBuys.map(lb => {
            const resolution = allResolutions.find(r => r.ticker === lb.ticker);
            if (resolution) {
                return {
                    ticker: lb.ticker,
                    market: lb.market || resolution.market || lb.ticker,
                    strategy: lb.strategy || 'safe-compounder',
                    side: lb.side || 'no',
                    entryPrice: lb.price || 0,
                    count: lb.count || 1,
                    edge: lb.edge || null,
                    time: lb.timestamp,
                    status: 'resolved',
                    won: resolution.won,
                    pnl: resolution.totalPnl || 0,
                    settlementPrice: resolution.settlementPrice,
                    resolvedAt: resolution.timestamp,
                    live: true,
                };
            }
            return {
                ticker: lb.ticker,
                market: lb.market || lb.ticker,
                strategy: lb.strategy || 'safe-compounder',
                side: lb.side || 'no',
                entryPrice: lb.price || 0,
                count: lb.count || 1,
                edge: lb.edge || null,
                time: lb.timestamp,
                status: 'open',
                live: true,
            };
        }).reverse();

        // All-time stats
        const totalWins = allResolutions.filter(r => r.won).length;
        const totalPnl = allResolutions.reduce((s, r) => s + (r.totalPnl || 0), 0);

        return res.status(200).json({
            today: {
                buys: todayBuys.length,
                paperBuys: todayBuys.filter(b => b.paper).length,
                exits: todayExits.length,
                exitFails: todayExitFails.length,
                resolutions: todayResolutions.length,
                wins: todayResolutions.filter(r => r.won).length,
                pnl: todayResolutions.reduce((s, r) => s + (r.totalPnl || 0), 0),
                trades: todayTrades.length,
            },
            allTime: {
                trades: allTrades.length,
                resolutions: allResolutions.length,
                wins: totalWins,
                winRate: allResolutions.length > 0 ? totalWins / allResolutions.length : 0,
                pnl: totalPnl,
                cycleActions: allCycles.length,
                monitorDecisions: allMonitor.length,
            },
            strategies,
            categories,
            paperTrades,
            liveTrades,
            recentActivity,
            recentMonitor: allMonitor.slice(-15).reverse().map(d => ({
                time: d.timestamp,
                ticker: d.ticker || '',
                market: d.market || '',
                decision: d.decision || '',
                trigger: d.triggerType || '',
                pnlPct: d.pnlPct || 0,
                reasoning: d.reasoning || '',
            })),
            meta: metaConfig ? {
                lastUpdated: metaConfig.lastUpdated,
                strategyModes: metaConfig.strategyModes || {},
                blockedCategories: metaConfig.blockedCategories || [],
                strategyBudgets: metaConfig.strategyBudgets || {},
            } : null,
            calibration: calibration || { k: 0.65, b: 0, updates: 0 },
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}
