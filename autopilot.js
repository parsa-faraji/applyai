#!/usr/bin/env node
/**
 * Server-side Autopilot — runs the trading bot independently of the browser.
 *
 * Usage: node autopilot.js
 *
 * Runs on a loop: sync → safe compounder → market maker → trading bot → monitor
 * Set environment variables for API keys, or it reads from .env file.
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY, BRAVE_API_KEY, ODDS_API_KEY, OPENROUTER_API_KEY,
 *   KALSHI_API_KEY_ID, KALSHI_PRIVATE_KEY
 *   CYCLE_INTERVAL_MIN (default: 10)
 *   SERVER_URL (default: http://localhost:3000)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { readMetaConfig } from './api/lib/meta-config.js';
import { logCycleAction } from './api/lib/trade-logger.js';
import { runMetaCycle } from './meta-agent.js';
import { generateDailyReport } from './api/lib/daily-report.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env file if it exists
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    for (const line of envContent.split('\n')) {
        const [key, ...vals] = line.split('=');
        if (key && !key.startsWith('#')) {
            process.env[key.trim()] = vals.join('=').trim().replace(/^["']|["']$/g, '');
        }
    }
}

const PORT = process.env.PORT || 3000;
const SERVER = process.env.SERVER_URL || `http://localhost:${PORT}`;
const INTERVAL = parseInt(process.env.CYCLE_INTERVAL_MIN || '20') * 60 * 1000;

const HEADERS = {
    'Content-Type': 'application/json',
};
if (process.env.ANTHROPIC_API_KEY) HEADERS['X-Anthropic-Key'] = process.env.ANTHROPIC_API_KEY;
if (process.env.BRAVE_API_KEY) HEADERS['X-Brave-Key'] = process.env.BRAVE_API_KEY;
if (process.env.ODDS_API_KEY) HEADERS['X-Odds-Key'] = process.env.ODDS_API_KEY;
if (process.env.OPENROUTER_API_KEY) HEADERS['X-OpenRouter-Key'] = process.env.OPENROUTER_API_KEY;
if (process.env.KALSHI_API_KEY_ID) HEADERS['X-Kalshi-Key-Id'] = process.env.KALSHI_API_KEY_ID;
if (process.env.KALSHI_PRIVATE_KEY) {
    // Base64 encode the private key for header transport
    const key = process.env.KALSHI_PRIVATE_KEY;
    HEADERS['X-Kalshi-Private-Key'] = key.includes('-----BEGIN') ? Buffer.from(key).toString('base64') : key;
}

function log(msg) {
    console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

// Track stats across cycles
const stats = {
    startBalance: null,
    currentBalance: null,
    totalTrades: 0,
    totalSells: 0,
    totalBuys: 0,
    estimatedApiCost: 0,
    cyclesRun: 0,
    startTime: Date.now(),
    recentExits: new Map(),      // ticker/event_ticker → timestamp (2h cooldown)
    sessionTrades: new Set(),    // tickers the bot has traded this session
    reportGeneratedToday: false, // flag to generate report once per day
};

async function callEndpoint(name, path, body = {}) {
    // Estimate API cost per endpoint
    const costMap = { 'Safe Compounder': 0.05, 'Weather Strategy': 0, 'Market Maker': 0, 'Trading Bot': 0.30, 'Monitor': 0.05, 'Sync': 0, 'Re-sync': 0, 'Cleanup': 0, 'Assess': 0.50, 'Learning': 0 };
    stats.estimatedApiCost += costMap[name] || 0;
    try {
        const resp = await fetch(`${SERVER}${path}`, {
            method: 'POST',
            headers: HEADERS,
            body: JSON.stringify(body),
        });
        const data = await resp.json();
        if (!resp.ok) {
            log(`  ${name}: ERROR ${resp.status} — ${data.error || 'unknown'}`);
            return null;
        }
        return data;
    } catch (err) {
        log(`  ${name}: FAILED — ${err.message}`);
        return null;
    }
}

async function runCycle() {
    log('═══ Autopilot cycle starting ═══');

    // Read meta-agent config for dynamic strategy adjustments
    let metaConfig = null;
    try {
        metaConfig = readMetaConfig();
        if (metaConfig.blockedCategories?.length > 0) {
            log(`  Meta-agent: blocked categories: ${metaConfig.blockedCategories.join(', ')}`);
        }
    } catch {
        log('  Meta-agent: config not available (using defaults)');
    }

    // 1. Sync positions
    const sync = await callEndpoint('Sync', '/api/kalshi-sync');
    if (sync) {
        const currentTotal = (sync.balance || 0) + (sync.portfolioValue || 0);
        if (stats.startBalance === null) stats.startBalance = currentTotal;
        stats.currentBalance = currentTotal;
        stats.cyclesRun++;

        const pnl = currentTotal - stats.startBalance;
        const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
        const runtime = ((Date.now() - stats.startTime) / 3600000).toFixed(1);
        const realizedPnl = sync.realizedPnl ? ` | Realized P&L: $${sync.realizedPnl.toFixed(2)}` : '';

        log(`  Kalshi: $${(sync.balance || 0).toFixed(2)} cash, $${currentTotal.toFixed(2)} total, ${sync.positions?.length || 0} positions, ${sync.openOrders || 0} resting`);
        log(`  Session: ${pnlStr} since start | Est. API cost: $${stats.estimatedApiCost.toFixed(2)} | Runtime: ${runtime}h | Cycles: ${stats.cyclesRun}${realizedPnl}`);
    }

    // Circuit breaker: if session P&L drops below -15%, pause NEW trading but still manage positions
    if (stats.startBalance && stats.currentBalance) {
        const sessionPnlPct = ((stats.currentBalance - stats.startBalance) / stats.startBalance) * 100;
        if (sessionPnlPct < -15) {
            log(`  ⚠ CIRCUIT BREAKER: Session down ${sessionPnlPct.toFixed(1)}% — pausing new trades. Still monitoring + exiting losers.`);
            // Skip to monitor — no new trades from safe compounder, market maker, or trading bot
            // But still execute exit recommendations from monitor (critical for loss management)
            const positions = sync?.positions || [];
            if (positions.length > 0) {
                const mon = await callEndpoint('Monitor', '/api/monitor', {
                    positions, stopLossPct: 20, takeProfitPct: 30, trailingStopPct: 10, spikeThreshold: 10,
                });
                if (mon) {
                    log(`  Monitor: ${mon.positionsChecked || 0} checked, ${mon.alerts?.length || 0} alerts, ${mon.actions?.length || 0} actions`);
                    for (const a of (mon.alerts || [])) log(`    ${a.type}: ${a.message}`);

                    // Execute exits even in circuit breaker mode (deduplicate by ticker)
                    const cbSeenTickers = new Set();
                    const exitActions = (mon.actions || []).filter(a => {
                        if (a.type !== 'exit') return false;
                        const key = a.ticker || a.tokenId;
                        if (cbSeenTickers.has(key)) return false;
                        cbSeenTickers.add(key);
                        return true;
                    });
                    for (const exit of exitActions) {
                        const pos = positions.find(p => p.ticker === exit.ticker || p.tokenId === exit.tokenId);
                        if (!pos) continue;
                        const shares = exit.shares || pos.position_fp || pos.shares || 0;
                        if (shares <= 0) continue;
                        const side = (pos.outcome || 'yes').toLowerCase();
                        try {
                            const sellResult = await callEndpoint('Exit Trade', '/api/kalshi-trade', {
                                ticker: exit.ticker || pos.ticker, side, action: 'sell', count: Math.abs(shares),
                            });
                            if (sellResult?.trade) {
                                stats.totalSells++;
                                stats.recentExits.set(exit.ticker, Date.now());
                                const exitedPos = positions.find(p => p.ticker === exit.ticker);
                                if (exitedPos?.event_ticker) stats.recentExits.set(exitedPos.event_ticker, Date.now());
                                log(`    ✓ EXIT: ${Math.abs(shares)} ${side.toUpperCase()} of ${exit.ticker} @ ${sellResult.trade.price}¢`);
                            }
                        } catch (err) {
                            log(`    ✗ Exit failed for ${exit.ticker}: ${err.message}`);
                        }
                    }
                }
            }
            log('═══ Cycle complete (circuit breaker active) ═══\n');
            return;
        }
    }

    // CASH GUARD: If cash is too low to trade, skip expensive Claude-based strategies
    const cashBalance = sync?.balance || 0;
    if (cashBalance < 2) {
        log(`  ⚠ LOW CASH: $${cashBalance.toFixed(2)} — skipping trading strategies (saves API costs)`);
        // Jump straight to monitor (still manage existing positions)
        const positions = sync?.positions || [];
        if (positions.length > 0) {
            log('  Running Monitor...');
            const mon = await callEndpoint('Monitor', '/api/monitor', {
                positions, stopLossPct: 30, takeProfitPct: 50, trailingStopPct: 15, spikeThreshold: 15,
            });
            if (mon) {
                log(`  Monitor: ${mon.positionsChecked || 0} checked, ${mon.alerts?.length || 0} alerts, ${mon.actions?.length || 0} actions`);
                for (const a of (mon.alerts || [])) log(`    ${a.type}: ${a.message}`);
                const seenTickers = new Set();
                const exitActions = (mon.actions || []).filter(a => {
                    if (a.type !== 'exit') return false;
                    const key = a.ticker || a.tokenId;
                    if (seenTickers.has(key)) return false;
                    seenTickers.add(key);
                    return true;
                });
                if (exitActions.length > 0) {
                    log(`  Executing ${exitActions.length} exit(s)...`);
                    for (const exit of exitActions) {
                        const pos = positions.find(p => (p.ticker === exit.ticker) || (p.tokenId === exit.tokenId));
                        if (!pos) continue;
                        const shares = exit.shares || pos.position_fp || pos.shares || 0;
                        if (shares <= 0) continue;
                        const side = (pos.outcome || 'yes').toLowerCase();
                        try {
                            const sellResult = await callEndpoint('Exit Trade', '/api/kalshi-trade', {
                                ticker: exit.ticker || pos.ticker, side, action: 'sell', count: Math.abs(shares),
                            });
                            if (sellResult?.trade) {
                                stats.totalSells++;
                                stats.recentExits.set(exit.ticker, Date.now());
                                const exitedPos = positions.find(p => p.ticker === exit.ticker);
                                if (exitedPos?.event_ticker) stats.recentExits.set(exitedPos.event_ticker, Date.now());
                                log(`    ✓ Sold ${Math.abs(shares)} ${side.toUpperCase()} of ${exit.ticker} @ ${sellResult.trade.price}¢ (reason: ${exit.reason})`);
                            }
                        } catch (err) {
                            log(`    ✗ Sell error: ${err.message}`);
                        }
                    }
                }
            }
        }
        log('═══ Cycle complete (low cash) ═══\n');
        return;
    }

    // 1b. Cancel stale resting orders (older than 15 min)
    if (sync?.openOrders > 0) {
        log('  Cleaning up stale resting orders...');
        const cleanup = await callEndpoint('Cleanup', '/api/kalshi-cleanup', { maxAgeMinutes: 15 });
        if (cleanup) {
            log(`  Cleanup: ${cleanup.cancelled || 0} cancelled, ${cleanup.kept || 0} kept`);
        }
    }

    // 2. Safe Compounder — cap budget to actual cash available
    log('  Running Safe Compounder...');
    const safeBudget = Math.min(metaConfig?.strategyBudgets?.['safe-compounder'] ?? 50, cashBalance);
    const safe = await callEndpoint('Safe Compounder', '/api/kalshi-safe-compounder', {
        budget: safeBudget, maxPerTrade: 10, dryRun: false, marketLimit: 20,
        existingPositions: (sync?.positions || []).map(p => p.ticker).filter(Boolean),
    });
    if (safe) {
        log(`  Safe: scanned ${safe.marketsScanned || '?'}, ${safe.candidates || 0} candidates, ${safe.tradesExecuted || 0} trades`);
        for (const t of (safe.trades || [])) {
            log(`    → NO ${t.market?.slice(0, 50)} — ${t.count} contracts @ ${t.price}¢`);
            try { logCycleAction({ action: 'buy', strategy: 'safe-compounder', ticker: t.ticker, side: 'no', count: t.count, price: t.price, market: t.market, cost: t.cost, edge: t.edge, cycle: stats.cyclesRun }); } catch {}
        }
    }

    // 2b. Weather Strategy — cap budget to remaining cash
    log('  Running Weather Strategy...');
    const weatherBudget = Math.min(50, Math.max(0, cashBalance - (safe?.totalSpent || 0)));
    const weather = await callEndpoint('Weather Strategy', '/api/kalshi-weather', {
        budget: weatherBudget, maxPerTrade: 10, dryRun: false, marketLimit: 10,
    });
    if (weather) {
        log(`  Weather: ${weather.marketsScanned || 0} scanned, ${weather.tradesExecuted || 0} trades`);
        for (const t of (weather.trades || [])) {
            log(`    → ${t.side.toUpperCase()} ${t.market?.slice(0, 60)} — ${t.count} @ ${(t.price*100).toFixed(0)}¢`);
        }
    }

    // 3. Market Maker — DISABLED
    // Critical bugs: sells wrong side (YES instead of NO), no order expiration,
    // requires sub-second latency we don't have from Vercel serverless.
    // Research confirms: market making from 10-min cycles is not viable.
    log('  Market Maker: DISABLED (wrong-side bug, needs sub-second latency)');

    // 4. Trading Bot — cap budget to remaining cash
    log('  Running Trading Bot...');
    // Clean up expired exit cooldowns (2 hours)
    const COOLDOWN_MS = 2 * 60 * 60 * 1000;
    for (const [key, ts] of stats.recentExits) {
        if (Date.now() - ts > COOLDOWN_MS) stats.recentExits.delete(key);
    }
    const spentSoFar = (safe?.totalSpent || 0) + (weather?.totalSpent || 0);
    const autoTradeMode = metaConfig?.strategyModes?.['auto-trade'] || 'paper';
    const botBudget = Math.min(metaConfig?.strategyBudgets?.['auto-trade'] ?? 50, Math.max(0, cashBalance - spentSoFar));
    const bot = await callEndpoint('Trading Bot', '/api/kalshi-auto-trade', {
        budget: botBudget, maxPerTrade: 10, riskLevel: 'moderate', dryRun: autoTradeMode !== 'live', marketLimit: 3,
        existingPositions: (sync?.positions || []).map(p => p.ticker).filter(Boolean),
        existingEventTickers: (sync?.positions || []).map(p => p.event_ticker).filter(Boolean),
        recentlyExited: [...stats.recentExits.keys()],
        sessionTradedTickers: [...stats.sessionTrades],
        maxTradesPerCycle: 2,
        blockedCategories: metaConfig?.blockedCategories || [],
    });
    if (bot) {
        stats.totalTrades += bot.tradesExecuted || 0;
        stats.totalBuys += bot.tradesExecuted || 0;
        // Track traded tickers to prevent re-entering same markets across cycles
        for (const t of (bot.trades || [])) {
            if (t.ticker) stats.sessionTrades.add(t.ticker);
            if (t.eventTicker) stats.sessionTrades.add(t.eventTicker);
        }
        const modeTag = autoTradeMode !== 'live' ? ' [PAPER]' : '';
        log(`  Bot${modeTag}: scanned ${bot.marketsScanned || '?'}, analyzed ${bot.marketsAnalyzed || '?'}, ${bot.tradesExecuted || 0} trades (total: ${stats.totalTrades})`);
        for (const t of (bot.trades || [])) {
            log(`    →${modeTag} ${t.outcome} ${t.market?.slice(0, 50)} — $${t.amount} @ ${(t.price * 100).toFixed(0)}¢`);
            try { logCycleAction({ action: 'buy', strategy: 'auto-trade', paper: autoTradeMode !== 'live', ticker: t.ticker, side: t.side, count: t.count || t.shares, price: t.price, market: t.market, cost: t.cost || t.amount, edge: t.edge, cycle: stats.cyclesRun }); } catch {}
        }
        for (const a of (bot.analyses || [])) {
            if (a.recommendation?.action !== 'HOLD') {
                log(`    📊 ${a.recommendation.action}: ${a.market?.slice(0, 50)} (${a.recommendation.confidence}, edge: ${a.recommendation.edge}pts)`);
            }
        }
    }

    // 5. Re-sync (get fresh positions + balance after trades)
    const resync = await callEndpoint('Re-sync', '/api/kalshi-sync');

    // 6. Monitor
    log('  Running Monitor...');
    const positions = resync?.positions || sync?.positions || [];
    if (positions.length > 0) {
        const mon = await callEndpoint('Monitor', '/api/monitor', {
            positions,
            stopLossPct: 30,
            takeProfitPct: 50,
            trailingStopPct: 15,
            spikeThreshold: 15,
        });
        if (mon) {
            log(`  Monitor: ${mon.positionsChecked || 0} checked, ${mon.alerts?.length || 0} alerts, ${mon.actions?.length || 0} actions`);
            for (const a of (mon.alerts || [])) {
                log(`    ${a.type}: ${a.message}`);
            }

            // 7. Execute monitor's exit recommendations (deduplicate by ticker)
            const allExits = (mon.actions || []).filter(a => a.type === 'exit');
            const seenTickers = new Set();
            const exitActions = allExits.filter(a => {
                const key = a.ticker || a.tokenId;
                if (seenTickers.has(key)) return false;
                seenTickers.add(key);
                return true;
            });

            // Strategy-aware filtering: safe-compounder NO positions should hold to resolution
            // (they win ~90% of the time — early exits sacrifice the full $1 payout for pennies minus fees)
            const filteredExits = exitActions.filter(exit => {
                const pos = positions.find(p => (p.ticker === exit.ticker) || (p.tokenId === exit.tokenId));
                if (!pos) return true; // let it through, will be caught later
                const isSafeCompounder = pos.strategy === 'safe-compounder';
                const isNo = (pos.outcome || '').toLowerCase() === 'no';
                if (isSafeCompounder && isNo && exit.reason !== 'near_resolution_losing') {
                    log(`    HOLD (safe-compounder): ${exit.ticker} — holding NO to resolution (reason: ${exit.reason})`);
                    return false;
                }
                return true;
            });

            if (filteredExits.length > 0) {
                // Cancel ALL resting orders first to free up locked cash
                // (Kalshi locks cash in resting buy orders — this is why sells fail with insufficient_balance)
                log(`  Cancelling resting orders to free cash for ${filteredExits.length} exit(s)...`);
                const cleanup = await callEndpoint('Pre-exit Cleanup', '/api/kalshi-cleanup', { maxAgeMinutes: 0 });
                if (cleanup) {
                    log(`    Cancelled ${cleanup.cancelled || 0} resting orders`);
                }

                log(`  Executing ${filteredExits.length} exit(s)${allExits.length > filteredExits.length ? ` (${allExits.length - filteredExits.length} filtered)` : ''}...`);
                for (const exit of filteredExits) {
                    // Find position details to sell
                    const pos = positions.find(p => (p.ticker === exit.ticker) || (p.tokenId === exit.tokenId));
                    if (!pos) {
                        log(`    Could not find position for ${exit.ticker || exit.tokenId}`);
                        continue;
                    }

                    const shares = exit.shares || pos.position_fp || pos.shares || 0;
                    if (shares <= 0) continue;

                    const side = (pos.outcome || 'yes').toLowerCase();
                    try {
                        const sellResult = await callEndpoint('Exit Trade', '/api/kalshi-trade', {
                            ticker: exit.ticker || pos.ticker,
                            side,
                            action: 'sell',
                            count: Math.abs(shares),
                        });
                        if (sellResult?.trade) {
                            stats.totalSells++;
                            stats.recentExits.set(exit.ticker, Date.now());
                            const exitedPos = positions.find(p => p.ticker === exit.ticker);
                            if (exitedPos?.event_ticker) stats.recentExits.set(exitedPos.event_ticker, Date.now());
                            log(`    Sold ${Math.abs(shares)} ${side.toUpperCase()} contracts of ${exit.ticker} @ ${sellResult.trade.price}¢ (reason: ${exit.reason})`);
                            // Persist exit action for audit trail
                            try { logCycleAction({ action: 'exit', ticker: exit.ticker, side, shares: Math.abs(shares), price: sellResult.trade.price, reason: exit.reason, pnlPct: exit.pnlPct, market: pos?.market, cycle: stats.cyclesRun }); } catch {}
                        } else {
                            log(`    Sell failed for ${exit.ticker}: ${sellResult?.error || 'unknown'}`);
                            try { logCycleAction({ action: 'exit_failed', ticker: exit.ticker, error: sellResult?.error || 'unknown', cycle: stats.cyclesRun }); } catch {}
                        }
                    } catch (err) {
                        log(`    Sell error for ${exit.ticker}: ${err.message}`);
                    }
                }
            }
        }
    }

    // 8. Learning: check resolved markets every 3 cycles (~60 min)
    if (stats.cyclesRun % 3 === 0) {
        log('  Running Learning Check...');
        const learn = await callEndpoint('Learning', '/api/kalshi-learn', {});
        if (learn) {
            if (learn.newResolutions > 0) {
                log(`  Learning: ${learn.newResolutions} new resolutions`);
                for (const r of (learn.resolved || [])) {
                    log(`    ${r.won ? '✓ WON' : '✗ LOST'}: ${r.market?.slice(0, 40)} (${r.strategy}, ${r.side}, P&L: $${r.totalPnl?.toFixed(2)})`);
                }
            }
            const cal = learn.calibrationStats;
            if (cal) {
                log(`  Calibration: k=${cal.k?.toFixed(3)}, b=${cal.b?.toFixed(3)}, updates=${cal.updates}, avgLoss=${cal.avgLoss?.toFixed(3) || 'N/A'}`);
            }
            // Log category performance if we have data
            const cats = learn.performanceByCategory || {};
            const activeCats = Object.entries(cats).filter(([, s]) => s.trades > 0);
            if (activeCats.length > 0) {
                log('  Performance by category:');
                for (const [cat, s] of activeCats) {
                    const status = s.trades >= 5 && s.winRate < 0.40 ? ' ⚠ UNDERPERFORMING' : '';
                    log(`    ${cat}: ${s.wins}W/${s.losses}L (${(s.winRate * 100).toFixed(0)}%) P&L: $${s.totalPnl.toFixed(2)}${status}`);
                }
            }
            // Edge decay detection: warn if overall strategy is losing after 10+ resolved trades
            const strats = learn.performanceByStrategy || {};
            for (const [strat, s] of Object.entries(strats)) {
                if (s.trades >= 10 && s.winRate < 0.40) {
                    log(`  ⚠ EDGE DECAY: ${strat} has ${(s.winRate * 100).toFixed(0)}% win rate over ${s.trades} trades — consider pausing`);
                }
            }
        }
    }

    // 9. Nightly report: generate PDF at end of day (11 PM - midnight)
    const hour = new Date().getHours();
    if (hour === 23 && !stats.reportGeneratedToday) {
        try {
            log('  Generating daily report...');
            const reportPath = await generateDailyReport();
            stats.reportGeneratedToday = true;
            log(`  Report saved: ${reportPath}`);
        } catch (err) {
            log(`  Report generation failed: ${err.message}`);
        }
    }
    // Reset flag at midnight
    if (hour === 0) stats.reportGeneratedToday = false;

    // 10. Meta-agent: compute stats, update strategy modes/budgets
    // Runs after learning so it has the latest resolution data.
    // Pure local math — no API calls, runs in milliseconds.
    if (stats.cyclesRun % 3 === 0) {
        try {
            runMetaCycle();
        } catch (err) {
            log(`  Meta-agent error: ${err.message}`);
        }
    }

    log('═══ Cycle complete ═══\n');
}

let cycleCount = 0;

// Start
log('Autopilot starting...');
log(`Server: ${SERVER}`);
log(`Cycle interval: ${INTERVAL / 60000} minutes`);
log('API Keys:');
log(`  Anthropic (Claude): ${HEADERS['X-Anthropic-Key'] ? '✓ SET' : '✗ MISSING — bot cannot trade'}`);
log(`  Kalshi:             ${HEADERS['X-Kalshi-Key-Id'] ? '✓ SET' : '✗ MISSING — no live trading'}`);
log(`  Brave Search:       ${HEADERS['X-Brave-Key'] ? '✓ SET' : '✗ MISSING — no news context'}`);
log(`  Odds API:           ${HEADERS['X-Odds-Key'] ? '✓ SET' : '✗ MISSING — sports trades disabled'}`);
log(`  OpenRouter:         ${HEADERS['X-OpenRouter-Key'] ? '✓ SET' : '○ NOT SET — ensemble disabled (saves money)'}`);
log(`  FRED:               ${process.env.FRED_API_KEY ? '✓ SET' : '○ DEMO KEY — may rate-limit'}`);
log(`  API-Sports:         ${process.env.API_SPORTS_KEY ? '✓ SET' : '○ NOT SET — no injury data'}`);
log('');

// Run immediately, then on interval
runCycle().then(() => {
    setInterval(runCycle, INTERVAL);
});
