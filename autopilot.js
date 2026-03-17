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
const INTERVAL = parseInt(process.env.CYCLE_INTERVAL_MIN || '10') * 60 * 1000;

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
};

async function callEndpoint(name, path, body = {}) {
    // Estimate API cost per endpoint
    const costMap = { 'Safe Compounder': 0.05, 'Market Maker': 0, 'Trading Bot': 0.30, 'Monitor': 0.05, 'Sync': 0, 'Re-sync': 0, 'Cleanup': 0, 'Assess': 0.50 };
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

                    // Execute exits even in circuit breaker mode
                    const exitActions = (mon.actions || []).filter(a => a.type === 'exit');
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

    // 1b. Cancel stale resting orders (older than 15 min)
    if (sync?.openOrders > 0) {
        log('  Cleaning up stale resting orders...');
        const cleanup = await callEndpoint('Cleanup', '/api/kalshi-cleanup', { maxAgeMinutes: 15 });
        if (cleanup) {
            log(`  Cleanup: ${cleanup.cancelled || 0} cancelled, ${cleanup.kept || 0} kept`);
        }
    }

    // 2. Safe Compounder
    log('  Running Safe Compounder...');
    const safe = await callEndpoint('Safe Compounder', '/api/kalshi-safe-compounder', {
        budget: 50, maxPerTrade: 10, dryRun: false, marketLimit: 20,
    });
    if (safe) {
        log(`  Safe: scanned ${safe.marketsScanned || '?'}, ${safe.candidates || 0} candidates, ${safe.tradesExecuted || 0} trades`);
        for (const t of (safe.trades || [])) {
            log(`    → NO ${t.market?.slice(0, 50)} — ${t.count} contracts @ ${t.price}¢`);
        }
    }

    // 3. Market Maker
    log('  Running Market Maker...');
    const mm = await callEndpoint('Market Maker', '/api/kalshi-market-maker', {
        budget: 50, maxPerMarket: 10, maxMarkets: 5, dryRun: false,
    });
    if (mm) {
        log(`  MM: ${mm.marketsQuoted || 0} markets quoted, ${mm.ordersPlaced || 0} orders`);
        for (const q of (mm.quotes || [])) {
            log(`    → ${q.market?.slice(0, 40)} Buy@${q.buyPrice}¢ / Sell@${q.sellPrice}¢ (spread ${q.spread}¢)`);
        }
    }

    // 4. Trading Bot (Bull vs Bear) — PAUSED until calibration validated
    // The bot keeps claiming 30-45pt edge on player props which is wildly overconfident
    // Only monitor should run until we verify predictions match outcomes
    log('  Trading Bot: PAUSED (monitor-only mode until calibration validated)');
    const bot = null;
    /*const bot = await callEndpoint('Trading Bot', '/api/kalshi-auto-trade', {
        budget: 50, maxPerTrade: 10, riskLevel: 'moderate', dryRun: false, marketLimit: 5,
        existingPositions: (sync?.positions || []).map(p => p.ticker).filter(Boolean),
        maxTradesPerCycle: 2,
    });*/
    if (bot) {
        stats.totalTrades += bot.tradesExecuted || 0;
        stats.totalBuys += bot.tradesExecuted || 0;
        log(`  Bot: scanned ${bot.marketsScanned || '?'}, analyzed ${bot.marketsAnalyzed || '?'}, ${bot.tradesExecuted || 0} trades (total: ${stats.totalTrades})`);
        for (const t of (bot.trades || [])) {
            log(`    → ${t.outcome} ${t.market?.slice(0, 50)} — $${t.amount} @ ${(t.price * 100).toFixed(0)}¢`);
        }
        for (const a of (bot.analyses || [])) {
            if (a.recommendation?.action !== 'HOLD') {
                log(`    📊 ${a.recommendation.action}: ${a.market?.slice(0, 50)} (${a.recommendation.confidence}, edge: ${a.recommendation.edge}pts)`);
            }
        }
    }

    // 5. Re-sync
    await callEndpoint('Re-sync', '/api/kalshi-sync');

    // 6. Monitor
    log('  Running Monitor...');
    const positions = sync?.positions || [];
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

            // 7. Execute monitor's exit recommendations
            const exitActions = (mon.actions || []).filter(a => a.type === 'exit');
            if (exitActions.length > 0) {
                log(`  Executing ${exitActions.length} exit(s)...`);
                for (const exit of exitActions) {
                    // Find position details to sell
                    const pos = positions.find(p => (p.ticker === exit.ticker) || (p.tokenId === exit.tokenId));
                    if (!pos) {
                        log(`    ⚠ Could not find position for ${exit.ticker || exit.tokenId}`);
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
                            log(`    ✓ Sold ${Math.abs(shares)} ${side.toUpperCase()} contracts of ${exit.ticker} @ ${sellResult.trade.price}¢ (reason: ${exit.reason})`);
                        } else {
                            log(`    ✗ Sell failed for ${exit.ticker}: ${sellResult?.error || 'unknown'}`);
                        }
                    } catch (err) {
                        log(`    ✗ Sell error for ${exit.ticker}: ${err.message}`);
                    }
                }
            }
        }
    }

    log('═══ Cycle complete ═══\n');
}

let cycleCount = 0;

// Start
log('Autopilot starting...');
log(`Server: ${SERVER}`);
log(`Cycle interval: ${INTERVAL / 60000} minutes`);
log(`API keys: Anthropic=${HEADERS['X-Anthropic-Key'] ? 'YES' : 'NO'}, Brave=${HEADERS['X-Brave-Key'] ? 'YES' : 'NO'}, Odds=${HEADERS['X-Odds-Key'] ? 'YES' : 'NO'}, OpenRouter=${HEADERS['X-OpenRouter-Key'] ? 'YES' : 'NO'}, Kalshi=${HEADERS['X-Kalshi-Key-Id'] ? 'YES' : 'NO'}`);
log('');

// Run immediately, then on interval
runCycle().then(() => {
    setInterval(runCycle, INTERVAL);
});
