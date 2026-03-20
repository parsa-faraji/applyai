#!/usr/bin/env node
/**
 * Meta-Agent — Self-improving strategy optimizer
 *
 * Runs every 30 minutes (standalone process, same pattern as autopilot.js).
 * Reads trade history + resolutions, computes rolling performance stats,
 * and dynamically adjusts strategy parameters.
 *
 * Responsibilities:
 * 1. Performance computation — rolling 30-day stats by category/strategy
 * 2. Category circuit breakers — block categories with negative 30-day P&L (5+ trades)
 * 3. Edge decay detection — compare 30-day vs 90-day win rates
 * 4. Dynamic strategy weighting — shift budget toward better strategies
 * 5. Self-reflection context — pre-build resolved trades summary
 * 6. Reporting — log structured report of changes
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
import { readTrades, getRecentResolved } from './api/lib/trade-logger.js';

const DRY_RUN = process.argv.includes('--dry-run');
const INTERVAL = 30 * 60 * 1000; // 30 minutes

// Config constants
const CIRCUIT_BREAKER_MIN_TRADES = 5;
const CIRCUIT_BREAKER_BLOCK_DAYS = 7;
const EDGE_DECAY_THRESHOLD = 0.10; // 10% drop triggers alert
const MIN_BUDGET_FLOOR_PCT = 0.10; // 10% of baseline minimum
const BASELINE_BUDGET = 50; // dollars per strategy

function log(msg) {
    console.log(`[META ${new Date().toLocaleTimeString()}] ${msg}`);
}

/**
 * Read resolutions from JSONL file directly (more reliable than in-memory)
 */
function readResolutions() {
    const resPath = path.join(__dirname, 'data', 'resolutions.jsonl');
    if (!fs.existsSync(resPath)) return [];
    return fs.readFileSync(resPath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
}

/**
 * Filter resolutions to a given time window
 */
function filterByDays(resolutions, days) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return resolutions.filter(r => new Date(r.timestamp) >= cutoff);
}

/**
 * Compute performance stats grouped by a key
 */
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
 * Main meta-agent cycle
 */
function runMetaCycle() {
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

    // 1. Performance computation
    const catStats30d = computeStats(last30d, 'category');
    const catStats90d = computeStats(last90d, 'category');
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

    // 2. Category circuit breakers
    const blockedCategories = [];
    for (const [cat, s] of Object.entries(catStats30d)) {
        if (s.trades >= CIRCUIT_BREAKER_MIN_TRADES && s.totalPnl < 0) {
            blockedCategories.push(cat);
            log(`  CIRCUIT BREAKER: Blocking "${cat}" — ${s.trades} trades, $${s.totalPnl.toFixed(2)} P&L (blocked for ${CIRCUIT_BREAKER_BLOCK_DAYS}d)`);
        }
    }

    // Also check previously blocked categories — unblock if they've been blocked long enough
    // (We don't have block timestamps in the simple model, so we just recompute each cycle)

    // 3. Edge decay detection
    const edgeDecayAlerts = [];
    for (const [strat, s30] of Object.entries(stratStats30d)) {
        const s90 = stratStats90d[strat];
        if (!s90 || s90.trades < 10) continue;
        if (s30.trades < 5) continue;

        const winRateDrop = s90.winRate - s30.winRate;
        if (winRateDrop >= EDGE_DECAY_THRESHOLD) {
            const alert = {
                strategy: strat,
                winRate30d: s30.winRate,
                winRate90d: s90.winRate,
                drop: winRateDrop,
                detectedAt: new Date().toISOString(),
            };
            edgeDecayAlerts.push(alert);
            log(`  EDGE DECAY: "${strat}" win rate dropped ${(winRateDrop * 100).toFixed(1)}% (90d: ${(s90.winRate * 100).toFixed(0)}% → 30d: ${(s30.winRate * 100).toFixed(0)}%)`);
        }
    }

    // 4. Dynamic strategy weighting
    const strategyBudgets = {};
    const strategies = Object.keys(stratStats30d);
    if (strategies.length > 0) {
        // Score each strategy: positive P&L = more budget, negative = less
        const scores = {};
        let totalPositiveScore = 0;

        for (const strat of strategies) {
            const s = stratStats30d[strat];
            // Score = win_rate * (1 + normalized_pnl) — penalize losers, reward winners
            const normalizedPnl = Math.max(-1, Math.min(1, s.totalPnl / (BASELINE_BUDGET * 2)));
            const score = Math.max(MIN_BUDGET_FLOOR_PCT, s.winRate * (1 + normalizedPnl));
            scores[strat] = score;
            totalPositiveScore += score;
        }

        // Normalize scores to budget allocation
        for (const strat of strategies) {
            const proportion = totalPositiveScore > 0 ? scores[strat] / totalPositiveScore : 1 / strategies.length;
            const budget = Math.max(
                BASELINE_BUDGET * MIN_BUDGET_FLOOR_PCT,
                Math.round(BASELINE_BUDGET * 2 * proportion) // Total pool = 2x baseline, distributed by performance
            );
            strategyBudgets[strat] = budget;
        }

        log('  Strategy budgets:');
        for (const [strat, budget] of Object.entries(strategyBudgets)) {
            const prev = prevConfig.strategyBudgets[strat] || BASELINE_BUDGET;
            const change = budget - prev;
            log(`    ${strat}: $${budget} (${change >= 0 ? '+' : ''}$${change})`);
        }
    }

    // 5. Build self-reflection context (pre-computed string for trading prompts)
    const recentResolved = allResolutions.slice(-20);
    let selfReflectionContext = '';
    if (recentResolved.length > 0) {
        const wins = recentResolved.filter(r => r.won).length;
        const losses = recentResolved.length - wins;
        const totalPnl = recentResolved.reduce((sum, r) => sum + (r.totalPnl || 0), 0);

        selfReflectionContext = `Recent Track Record (${recentResolved.length} trades): ${wins}W/${losses}L (${(wins / recentResolved.length * 100).toFixed(0)}%) P&L: $${totalPnl.toFixed(2)}`;

        // Add worst categories
        const worstCats = Object.entries(catStats30d)
            .filter(([, s]) => s.trades >= 3 && s.totalPnl < 0)
            .sort((a, b) => a[1].totalPnl - b[1].totalPnl)
            .slice(0, 3);
        if (worstCats.length > 0) {
            selfReflectionContext += '. Worst categories: ' + worstCats.map(([cat, s]) => `${cat} (${(s.winRate * 100).toFixed(0)}% WR, $${s.totalPnl.toFixed(2)})`).join(', ');
        }
    }

    // 6. Build new config
    const newConfig = {
        lastUpdated: new Date().toISOString(),
        blockedCategories,
        strategyBudgets: Object.keys(strategyBudgets).length > 0 ? strategyBudgets : prevConfig.strategyBudgets,
        edgeDecayAlerts,
        selfReflectionContext,
        performanceSnapshot: {
            byCategory30d: catStats30d,
            byStrategy30d: stratStats30d,
            totalResolutions: allResolutions.length,
        },
    };

    // Report changes
    const categoryChanges = JSON.stringify(blockedCategories) !== JSON.stringify(prevConfig.blockedCategories);
    const budgetChanges = JSON.stringify(newConfig.strategyBudgets) !== JSON.stringify(prevConfig.strategyBudgets);

    if (categoryChanges) {
        log(`  CONFIG CHANGE: blockedCategories ${JSON.stringify(prevConfig.blockedCategories)} → ${JSON.stringify(blockedCategories)}`);
    }
    if (edgeDecayAlerts.length > 0) {
        log(`  CONFIG CHANGE: ${edgeDecayAlerts.length} edge decay alert(s)`);
    }

    // Write config (or log in dry-run mode)
    if (DRY_RUN) {
        log('  DRY RUN — would write config:');
        log(`    blockedCategories: ${JSON.stringify(blockedCategories)}`);
        log(`    strategyBudgets: ${JSON.stringify(newConfig.strategyBudgets)}`);
        log(`    edgeDecayAlerts: ${edgeDecayAlerts.length}`);
    } else {
        writeMetaConfig(newConfig);
        log('  Config written to data/meta-config.json');
    }

    log('═══ Meta-agent cycle complete ═══\n');
}

// ── Kill switch ──
if (process.env.META_AGENT_ENABLED === 'false') {
    log('META_AGENT_ENABLED=false — exiting');
    process.exit(0);
}

// Start
log('Meta-agent starting...');
log(`Mode: ${DRY_RUN ? 'DRY RUN (no config writes)' : 'LIVE'}`);
log(`Interval: ${INTERVAL / 60000} minutes`);
log('');

// Run immediately, then on interval
runMetaCycle();
setInterval(runMetaCycle, INTERVAL);
