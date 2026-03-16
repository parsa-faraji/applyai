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

async function callEndpoint(name, path, body = {}) {
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
        const cash = sync.balance?.toFixed(2) || '?';
        const total = ((sync.balance || 0) + (sync.portfolioValue || 0)).toFixed(2);
        log(`  Kalshi: $${cash} cash, $${total} total, ${sync.positions?.length || 0} positions, ${sync.openOrders || 0} resting`);
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

    // 4. Trading Bot (Bull vs Bear)
    log('  Running Trading Bot...');
    const bot = await callEndpoint('Trading Bot', '/api/kalshi-auto-trade', {
        budget: 50, maxPerTrade: 10, riskLevel: 'moderate', dryRun: false, marketLimit: 5,
    });
    if (bot) {
        log(`  Bot: scanned ${bot.marketsScanned || '?'}, analyzed ${bot.marketsAnalyzed || '?'}, ${bot.tradesExecuted || 0} trades`);
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
