#!/usr/bin/env node
/**
 * Meta-Agent — Statistics engine + self-improving strategy optimizer
 *
 * Runs every 30 minutes (standalone process, same pattern as autopilot.js).
 * Reads trade history + resolutions, computes empirical performance stats,
 * and dynamically adjusts strategy parameters based on ACTUAL outcomes.
 *
 * Responsibilities:
 * 1. Performance by category/strategy — rolling 30-day stats
 * 2. Signal-level win rates — which data sources actually predict wins
 * 3. Edge bucket analysis — are our edge estimates accurate?
 * 4. Empirical Kelly sizing — replace Claude's confidence with real data
 * 5. Category circuit breakers — block losing categories
 * 6. Strategy promotion/demotion — paper→live when proven, live→paper when failing
 * 7. True P&L — include API costs in profitability calculation
 *
 * Usage: node meta-agent.js [--dry-run]
 * Environment: META_AGENT_ENABLED=true (kill switch)
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

import { readMetaConfig, writeMetaConfig } from './api/lib/meta-config.js';
import { readTrades, readDecisions } from './api/lib/trade-logger.js';

const DRY_RUN = process.argv.includes('--dry-run');
const INTERVAL = 30 * 60 * 1000; // 30 minutes

// Config constants
const CIRCUIT_BREAKER_MIN_TRADES = 5;
const EDGE_DECAY_THRESHOLD = 0.10;
const MIN_BUDGET_FLOOR_PCT = 0.10;
const BASELINE_BUDGET = 50;
const PROMOTION_MIN_TRADES = 20;
const PROMOTION_MIN_WIN_RATE = 0.52;
const DEMOTION_MIN_TRADES = 20;
const DEMOTION_WIN_RATE = 0.40;

function log(msg) {
    console.log(`[META ${new Date().toLocaleTimeString()}] ${msg}`);
}

// ── Data readers ──

function readResolutions() {
    const resPath = path.join(__dirname, 'data', 'resolutions.jsonl');
    if (!fs.existsSync(resPath)) return [];
    return fs.readFileSync(resPath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
}

function filterByDays(resolutions, days) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return resolutions.filter(r => new Date(r.timestamp) >= cutoff);
}

// ── Analysis functions ──

function computeStats(resolutions, key) {
    const stats = {};
    for (const r of resolutions) {
        const k = r[key] || 'unknown';
        if (!stats[k]) stats[k] = { wins: 0, losses: 0, totalPnl: 0, trades: 0, winRate: 0 };
        const s = stats[k];
        s.trades++;
        if (r.won) s.wins++; else s.losses++;
        s.totalPnl += r.totalPnl || 0;
        s.winRate = s.wins / s.trades;
    }
    return stats;
}

/**
 * Signal-level win rates — which combinations of data sources actually work?
 */
function computeSignalStats(resolutions) {
    const stats = {};
    for (const r of resolutions) {
        const signals = [];
        if (r.hadOdds) signals.push('odds');
        if (r.hadNews) signals.push('news');
        if (r.hadEnsemble) signals.push('ensemble');
        if (r.hadSports) signals.push('sports');
        if (r.hadWeather) signals.push('weather');
        const key = signals.length > 0 ? signals.sort().join('+') : 'none';
        if (!stats[key]) stats[key] = { wins: 0, losses: 0, totalPnl: 0, trades: 0, winRate: 0, avgEdge: 0, totalEdge: 0 };
        const s = stats[key];
        s.trades++;
        if (r.won) s.wins++; else s.losses++;
        s.totalPnl += r.totalPnl || 0;
        s.totalEdge += r.estimated_edge || r.edge || 0;
        s.winRate = s.wins / s.trades;
        s.avgEdge = s.totalEdge / s.trades;
    }
    return stats;
}

/**
 * Edge bucket analysis — are our edge estimates accurate?
 * Groups trades by estimated edge into 5-point buckets, shows actual win rate per bucket.
 */
function computeEdgeBuckets(resolutions) {
    const BUCKET_SIZE = 5;
    const buckets = {};
    for (const r of resolutions) {
        const edge = Math.abs(r.estimated_edge || r.edge || 0);
        const bucketMin = Math.floor(edge / BUCKET_SIZE) * BUCKET_SIZE;
        const key = `${bucketMin}-${bucketMin + BUCKET_SIZE}`;
        if (!buckets[key]) buckets[key] = { wins: 0, losses: 0, trades: 0, winRate: 0, totalPnl: 0 };
        const b = buckets[key];
        b.trades++;
        if (r.won) b.wins++; else b.losses++;
        b.totalPnl += r.totalPnl || 0;
        b.winRate = b.wins / b.trades;
    }
    return buckets;
}

/**
 * Empirical Kelly sizing — compute actual Kelly fractions from historical win rates.
 * Only for signal combinations with 20+ resolved trades.
 */
function computeEmpiricalKelly(signalStats) {
    const kelly = {};
    for (const [key, s] of Object.entries(signalStats)) {
        if (s.trades < 20) continue;
        // Simple Kelly for binary outcomes: f* = 2 * winRate - 1 (at ~50c prices)
        // More accurate: f* = (p*b - q) / b, but we approximate for typical Kalshi prices
        const f = Math.max(0, 2 * s.winRate - 1);
        kelly[key] = {
            fullKelly: parseFloat(f.toFixed(3)),
            quarterKelly: parseFloat((f * 0.25).toFixed(3)),
            winRate: parseFloat(s.winRate.toFixed(3)),
            sampleSize: s.trades,
        };
    }
    return kelly;
}

/**
 * Strategy promotion/demotion based on empirical performance.
 * Paper strategies with >55% win rate over 50+ trades → promote to live.
 * Live strategies with <40% win rate over 20+ trades → demote to paper.
 */
function computeStrategyModes(stratStats30d, prevModes) {
    const modes = { ...prevModes };

    for (const [strat, s] of Object.entries(stratStats30d)) {
        const currentMode = modes[strat] || 'paper';

        if (currentMode === 'paper') {
            // Check for promotion: enough data + good performance
            if (s.trades >= PROMOTION_MIN_TRADES && s.winRate >= PROMOTION_MIN_WIN_RATE && s.totalPnl > 0) {
                modes[strat] = 'live';
                log(`  PROMOTION: "${strat}" → LIVE (${s.trades} trades, ${(s.winRate * 100).toFixed(0)}% WR, $${s.totalPnl.toFixed(2)} P&L)`);
            }
        } else if (currentMode === 'live') {
            // Check for demotion: enough data + bad performance
            if (s.trades >= DEMOTION_MIN_TRADES && s.winRate < DEMOTION_WIN_RATE) {
                modes[strat] = 'paper';
                log(`  DEMOTION: "${strat}" → PAPER (${s.trades} trades, ${(s.winRate * 100).toFixed(0)}% WR, $${s.totalPnl.toFixed(2)} P&L)`);
            }
        }
    }

    // Safe-compounder stays live by default (structural edge from bookmaker odds)
    if (!modes['safe-compounder']) modes['safe-compounder'] = 'live';

    return modes;
}

// ── Main cycle (exported for use by autopilot.js) ──

export function runMetaCycle() {
    log('═══ Meta-agent cycle starting ═══');

    const prevConfig = readMetaConfig();
    const allResolutions = readResolutions();

    if (allResolutions.length === 0) {
        log('  No resolutions yet — skipping analysis');
        log('═══ Meta-agent cycle complete (no data) ═══\n');
        return;
    }

    const last30d = filterByDays(allResolutions, 30);
    const last90d = filterByDays(allResolutions, 90);

    log(`  Data: ${allResolutions.length} total resolutions, ${last30d.length} in 30d, ${last90d.length} in 90d`);

    // 1. Performance by category and strategy
    const catStats30d = computeStats(last30d, 'category');
    const stratStats30d = computeStats(last30d, 'strategy');
    const stratStats90d = computeStats(last90d, 'strategy');

    log('  30-day performance by category:');
    for (const [cat, s] of Object.entries(catStats30d)) {
        log(`    ${cat}: ${s.wins}W/${s.losses}L (${(s.winRate * 100).toFixed(0)}%) P&L: $${s.totalPnl.toFixed(2)}`);
    }
    log('  30-day performance by strategy:');
    for (const [strat, s] of Object.entries(stratStats30d)) {
        log(`    ${strat}: ${s.wins}W/${s.losses}L (${(s.winRate * 100).toFixed(0)}%) P&L: $${s.totalPnl.toFixed(2)}`);
    }

    // 2. Signal-level win rates
    const signalStats = computeSignalStats(last30d);
    log('  Signal-level win rates:');
    for (const [key, s] of Object.entries(signalStats).sort((a, b) => b[1].trades - a[1].trades)) {
        const profitable = s.totalPnl > 0 ? '+' : '';
        log(`    [${key}]: ${s.wins}W/${s.losses}L (${(s.winRate * 100).toFixed(0)}%) avgEdge: ${s.avgEdge.toFixed(1)}pts P&L: ${profitable}$${s.totalPnl.toFixed(2)} (${s.trades} trades)`);
    }

    // 3. Edge bucket analysis
    const edgeBuckets = computeEdgeBuckets(last30d);
    log('  Edge buckets (estimated vs actual):');
    for (const [bucket, b] of Object.entries(edgeBuckets).sort((a, b) => a[0].localeCompare(b[0]))) {
        const calibration = b.winRate > 0.5 ? 'PROFITABLE' : 'LOSING';
        log(`    ${bucket}pts: ${b.wins}W/${b.losses}L (${(b.winRate * 100).toFixed(0)}%) P&L: $${b.totalPnl.toFixed(2)} [${calibration}]`);
    }

    // 4. Empirical Kelly
    const empiricalKelly = computeEmpiricalKelly(signalStats);
    if (Object.keys(empiricalKelly).length > 0) {
        log('  Empirical Kelly fractions (signals with 20+ trades):');
        for (const [key, k] of Object.entries(empiricalKelly)) {
            log(`    [${key}]: quarterKelly=${k.quarterKelly} (WR: ${(k.winRate * 100).toFixed(0)}%, n=${k.sampleSize})`);
        }
    }

    // 5. Category circuit breakers
    const blockedCategories = [];
    for (const [cat, s] of Object.entries(catStats30d)) {
        if (s.trades >= CIRCUIT_BREAKER_MIN_TRADES && s.totalPnl < 0) {
            blockedCategories.push(cat);
            log(`  CIRCUIT BREAKER: Blocking "${cat}" — ${s.trades} trades, $${s.totalPnl.toFixed(2)} P&L`);
        }
    }

    // 6. Edge decay detection
    const edgeDecayAlerts = [];
    for (const [strat, s30] of Object.entries(stratStats30d)) {
        const s90 = stratStats90d[strat];
        if (!s90 || s90.trades < 10 || s30.trades < 5) continue;
        const winRateDrop = s90.winRate - s30.winRate;
        if (winRateDrop >= EDGE_DECAY_THRESHOLD) {
            edgeDecayAlerts.push({
                strategy: strat, winRate30d: s30.winRate, winRate90d: s90.winRate,
                drop: winRateDrop, detectedAt: new Date().toISOString(),
            });
            log(`  EDGE DECAY: "${strat}" dropped ${(winRateDrop * 100).toFixed(1)}% (90d: ${(s90.winRate * 100).toFixed(0)}% → 30d: ${(s30.winRate * 100).toFixed(0)}%)`);
        }
    }

    // 7. Dynamic strategy budgets
    const strategyBudgets = {};
    const strategies = Object.keys(stratStats30d);
    if (strategies.length > 0) {
        const scores = {};
        let totalScore = 0;
        for (const strat of strategies) {
            const s = stratStats30d[strat];
            const normalizedPnl = Math.max(-1, Math.min(1, s.totalPnl / (BASELINE_BUDGET * 2)));
            const score = Math.max(MIN_BUDGET_FLOOR_PCT, s.winRate * (1 + normalizedPnl));
            scores[strat] = score;
            totalScore += score;
        }
        for (const strat of strategies) {
            const proportion = totalScore > 0 ? scores[strat] / totalScore : 1 / strategies.length;
            strategyBudgets[strat] = Math.max(
                BASELINE_BUDGET * MIN_BUDGET_FLOOR_PCT,
                Math.round(BASELINE_BUDGET * 2 * proportion)
            );
        }
    }

    // 8. Strategy promotion/demotion
    const strategyModes = computeStrategyModes(stratStats30d, prevConfig.strategyModes || {});

    // 9. True P&L (include API costs)
    const totalGrossPnl = last30d.reduce((sum, r) => sum + (r.totalPnl || 0), 0);
    const totalApiCost = last30d.reduce((sum, r) => sum + (r.apiCost || 0.20), 0);
    // Also count decisions that didn't result in trades (still cost API calls)
    const decisions = readDecisions();
    const recentDecisions = decisions.filter(d => new Date(d.timestamp) >= new Date(Date.now() - 30 * 86400000));
    const decisionApiCost = recentDecisions.length * 0.15;
    const totalCost = totalApiCost + decisionApiCost;
    const netPnl = totalGrossPnl - totalCost;

    log(`  TRUE P&L (30d): $${totalGrossPnl.toFixed(2)} gross - $${totalCost.toFixed(2)} API costs = $${netPnl.toFixed(2)} net`);
    log(`    Trade API costs: $${totalApiCost.toFixed(2)} | Decision API costs: $${decisionApiCost.toFixed(2)} (${recentDecisions.length} decisions)`);

    // 10. Build self-reflection context
    const recentResolved = allResolutions.slice(-20);
    let selfReflectionContext = '';
    if (recentResolved.length > 0) {
        const wins = recentResolved.filter(r => r.won).length;
        selfReflectionContext = `Track Record (${recentResolved.length}): ${wins}W/${recentResolved.length - wins}L (${(wins / recentResolved.length * 100).toFixed(0)}%)`;

        const worstCats = Object.entries(catStats30d)
            .filter(([, s]) => s.trades >= 3 && s.totalPnl < 0)
            .sort((a, b) => a[1].totalPnl - b[1].totalPnl)
            .slice(0, 3);
        if (worstCats.length > 0) {
            selfReflectionContext += '. Worst: ' + worstCats.map(([cat, s]) => `${cat} (${(s.winRate * 100).toFixed(0)}%)`).join(', ');
        }

        // Add best signal combinations
        const bestSignals = Object.entries(signalStats)
            .filter(([, s]) => s.trades >= 5 && s.winRate > 0.55)
            .sort((a, b) => b[1].winRate - a[1].winRate)
            .slice(0, 3);
        if (bestSignals.length > 0) {
            selfReflectionContext += '. Best signals: ' + bestSignals.map(([key, s]) => `${key} (${(s.winRate * 100).toFixed(0)}%)`).join(', ');
        }
    }

    // Build and write config
    const newConfig = {
        lastUpdated: new Date().toISOString(),
        blockedCategories,
        strategyBudgets: Object.keys(strategyBudgets).length > 0 ? strategyBudgets : prevConfig.strategyBudgets,
        strategyModes,
        edgeDecayAlerts,
        selfReflectionContext,
        signalStats,
        edgeBuckets,
        empiricalKelly,
        performanceSnapshot: {
            byCategory30d: catStats30d,
            byStrategy30d: stratStats30d,
            totalResolutions: allResolutions.length,
            netPnl30d: parseFloat(netPnl.toFixed(2)),
            grossPnl30d: parseFloat(totalGrossPnl.toFixed(2)),
            apiCost30d: parseFloat(totalCost.toFixed(2)),
        },
    };

    // Log mode changes
    const prevModes = prevConfig.strategyModes || {};
    for (const [strat, mode] of Object.entries(strategyModes)) {
        if (prevModes[strat] !== mode) {
            log(`  MODE CHANGE: ${strat}: ${prevModes[strat] || 'unset'} → ${mode}`);
        }
    }

    if (DRY_RUN) {
        log('  DRY RUN — would write config:');
        log(`    blockedCategories: ${JSON.stringify(blockedCategories)}`);
        log(`    strategyModes: ${JSON.stringify(strategyModes)}`);
        log(`    strategyBudgets: ${JSON.stringify(newConfig.strategyBudgets)}`);
    } else {
        writeMetaConfig(newConfig);
        log('  Config written to data/meta-config.json');
    }

    log('═══ Meta-agent cycle complete ═══\n');
}

// ── Standalone mode: only runs when executed directly (not when imported) ──
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
    if (process.env.META_AGENT_ENABLED === 'false') {
        log('META_AGENT_ENABLED=false — exiting');
        process.exit(0);
    }

    log('Meta-agent starting (standalone mode)...');
    log(`Mode: ${DRY_RUN ? 'DRY RUN (no config writes)' : 'LIVE'}`);
    log(`Interval: ${INTERVAL / 60000} minutes`);
    log('');

    runMetaCycle();
    setInterval(runMetaCycle, INTERVAL);
}
