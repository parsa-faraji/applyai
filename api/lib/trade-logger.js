/**
 * Persistent Trade Logger — writes every trade decision to a JSONL file.
 *
 * Logs: timestamp, ticker, strategy, side, price, contracts, cost,
 * rawProb, calibratedProb, marketPrice, edge, dataSources, reasoning,
 * category, eventTicker, and eventually: resolution outcome.
 *
 * File: trades.jsonl (one JSON object per line, append-only)
 * Resolution tracking: resolution-checker can update entries with outcomes.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, '..', '..', 'data');
const TRADE_LOG = path.join(LOG_DIR, 'trades.jsonl');
const DECISION_LOG = path.join(LOG_DIR, 'decisions.jsonl');

// Detect if we're on a read-only filesystem (Vercel serverless)
let _writable = null;
function isWritable() {
    if (_writable !== null) return _writable;
    try {
        if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
        // Test write
        const testFile = path.join(LOG_DIR, '.write-test');
        fs.writeFileSync(testFile, 'ok');
        fs.unlinkSync(testFile);
        _writable = true;
    } catch {
        _writable = false;
    }
    return _writable;
}

// Ensure data directory exists
function ensureDir() {
    if (!isWritable()) return false;
    if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
    }
    return true;
}

/**
 * Log a trade execution (actual order placed)
 */
export function logTrade(trade) {
    if (!ensureDir()) return null; // read-only filesystem, skip silently
    const entry = {
        type: 'trade',
        timestamp: new Date().toISOString(),
        ...trade,
    };
    // Use append with flag 'a' — safe for sequential writes within a process.
    // Server.js forks child processes, but each endpoint runs sequentially within
    // autopilot's cycle, so concurrent writes shouldn't happen in practice.
    fs.appendFileSync(TRADE_LOG, JSON.stringify(entry) + '\n');
    return entry;
}

/**
 * Log a trading decision (including skips/holds — for calibration analysis)
 */
export function logDecision(decision) {
    if (!ensureDir()) return null;
    const entry = {
        type: 'decision',
        timestamp: new Date().toISOString(),
        ...decision,
    };
    fs.appendFileSync(DECISION_LOG, JSON.stringify(entry) + '\n');
    return entry;
}

/**
 * Read all trades from the log
 */
export function readTrades() {
    if (!fs.existsSync(TRADE_LOG)) return [];
    return fs.readFileSync(TRADE_LOG, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map(line => {
            try { return JSON.parse(line); }
            catch { return null; }
        })
        .filter(Boolean);
}

/**
 * Read all decisions from the log
 */
export function readDecisions() {
    if (!fs.existsSync(DECISION_LOG)) return [];
    return fs.readFileSync(DECISION_LOG, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map(line => {
            try { return JSON.parse(line); }
            catch { return null; }
        })
        .filter(Boolean);
}

/**
 * Derive category from ticker prefix
 */
export function categorizeMarket(ticker, title) {
    const t = (ticker || '').toUpperCase();
    const q = (title || '').toLowerCase();

    if (t.startsWith('KXNBA') || q.includes('nba')) return 'sports-nba';
    if (t.startsWith('KXNFL') || q.includes('nfl')) return 'sports-nfl';
    if (t.startsWith('KXNHL') || q.includes('nhl')) return 'sports-nhl';
    if (t.startsWith('KXMLB') || q.includes('mlb')) return 'sports-mlb';
    if (t.startsWith('KXNCAA') || q.includes('ncaa')) return 'sports-ncaa';
    if (t.startsWith('KXUFC') || q.includes('ufc') || q.includes('mma')) return 'sports-mma';
    if (t.startsWith('KXPGA') || q.includes('pga') || q.includes('golf')) return 'sports-golf';
    if (t.startsWith('KXATP') || q.includes('tennis')) return 'sports-tennis';
    if (q.includes('temperature') || q.includes('weather') || q.includes('degrees')) return 'weather';
    if (q.includes('bitcoin') || q.includes('ethereum') || q.includes('crypto') || q.includes('btc')) return 'crypto';
    if (q.includes('cpi') || q.includes('inflation') || q.includes('gdp') || q.includes('unemployment') || q.includes('fed') || q.includes('interest rate')) return 'economics';
    if (q.includes('trump') || q.includes('biden') || q.includes('election') || q.includes('congress') || q.includes('senate')) return 'politics';
    if (q.includes('box office') || q.includes('oscar') || q.includes('grammy') || q.includes('emmy')) return 'entertainment';
    return 'other';
}
