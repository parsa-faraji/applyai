/**
 * Meta-Config — Shared read/write for data/meta-config.json
 *
 * Used by meta-agent.js (writer) and autopilot.js / trading endpoints (readers).
 * Atomic file writes (write temp → rename) to prevent corruption.
 * Graceful degradation if config is missing or corrupt.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'meta-config.json');

const DEFAULT_CONFIG = {
    lastUpdated: null,
    blockedCategories: [],
    strategyBudgets: { 'safe-compounder': 50, 'auto-trade': 50 },
    edgeDecayAlerts: [],
    selfReflectionContext: '',
    performanceSnapshot: {},
};

/**
 * Read meta-config. Returns default config if file missing or corrupt.
 */
export function readMetaConfig() {
    try {
        if (!fs.existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
        const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
        const config = JSON.parse(raw);
        return { ...DEFAULT_CONFIG, ...config };
    } catch {
        return { ...DEFAULT_CONFIG };
    }
}

/**
 * Write meta-config atomically (write temp → rename).
 */
export function writeMetaConfig(config) {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const tmpPath = CONFIG_PATH + '.tmp.' + Date.now();
    const data = JSON.stringify({ ...config, lastUpdated: new Date().toISOString() }, null, 2);
    fs.writeFileSync(tmpPath, data);
    fs.renameSync(tmpPath, CONFIG_PATH);
}

/**
 * Check if a category is currently blocked.
 */
export function isCategoryBlocked(category) {
    const config = readMetaConfig();
    return config.blockedCategories.includes(category);
}

/**
 * Get strategy budget from meta-config.
 */
export function getStrategyBudget(strategy) {
    const config = readMetaConfig();
    return config.strategyBudgets[strategy] ?? null;
}
