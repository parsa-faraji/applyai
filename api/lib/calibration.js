/**
 * Platt Scaling Calibration for LLM probability estimates.
 *
 * Based on KalshiBench research:
 * - Claude ECE = 0.12 (overconfident by ~12pts on average)
 * - At 90%+ confidence, actual accuracy is only 70%
 * - Uses log-odds compression with k=0.65 as starting point
 *
 * Formula: calibrated = sigmoid(k * logit(raw) + b)
 * where k < 1 compresses toward 50% (reduces overconfidence)
 *
 * Supports online learning: as trades resolve, updates k and b
 * via stochastic gradient descent on cross-entropy loss.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'calibration.json');

// ─── Numeric helpers ───

const EPSILON = 1e-7;

/** Clamp probability to (0, 1) exclusive to avoid log(0) */
function clampProb(p) {
    return Math.max(EPSILON, Math.min(1 - EPSILON, p));
}

/** logit(p) = log(p / (1-p)) */
function logit(p) {
    const c = clampProb(p);
    return Math.log(c / (1 - c));
}

/** sigmoid(x) = 1 / (1 + exp(-x)) */
function sigmoid(x) {
    // Numerically stable: avoid overflow for large negative x
    if (x >= 0) {
        return 1 / (1 + Math.exp(-x));
    }
    const ex = Math.exp(x);
    return ex / (1 + ex);
}

// ─── Default parameters (from KalshiBench) ───

const DEFAULTS = {
    k: 0.65,       // compress log-odds by 35%
    b: 0.0,        // no directional bias
    updates: 0,    // number of SGD updates applied
    totalLoss: 0,  // cumulative cross-entropy loss (for monitoring)
};

// Context-specific k values
const CONTEXT_K = {
    withOdds: 0.85,       // bookmaker odds anchor — more trust
    withEnsemble: 0.75,   // multi-model agreement
    withNews: null,        // uses base k (slight bump handled below)
    claudeAlone: 0.50,    // no external data — least trust
};

// SGD hyperparameters
const LEARNING_RATE = 0.01;
const MIN_K = 0.20;   // never compress more than 80%
const MAX_K = 1.00;   // never amplify (k > 1 means overconfident scaling)

// ─── State management ───

let state = { ...DEFAULTS };

/** Load persisted state from disk. Silent on failure. */
function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const raw = fs.readFileSync(STATE_FILE, 'utf-8');
            const parsed = JSON.parse(raw);
            // Validate loaded values
            if (typeof parsed.k === 'number' && parsed.k >= MIN_K && parsed.k <= MAX_K) {
                state.k = parsed.k;
            }
            if (typeof parsed.b === 'number' && Math.abs(parsed.b) < 5) {
                state.b = parsed.b;
            }
            if (typeof parsed.updates === 'number' && parsed.updates >= 0) {
                state.updates = parsed.updates;
            }
            if (typeof parsed.totalLoss === 'number') {
                state.totalLoss = parsed.totalLoss;
            }
        }
    } catch {
        // Disk read failed — proceed with defaults. Trading must not break.
    }
}

/** Persist state to disk. Silent on failure. */
function saveState() {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
    } catch {
        // Disk write failed — state lives in memory for this process.
    }
}

// Load on module initialization
loadState();

// ─── Public API ───

/**
 * Apply Platt scaling with the current learned parameters.
 *
 * Formula: calibrated = sigmoid(k * logit(raw) + b)
 *
 * @param {number} rawProb — Claude's raw probability estimate (0-1)
 * @returns {number} calibrated probability (0-1)
 */
export function calibrate(rawProb) {
    const p = clampProb(rawProb);
    const logOdds = logit(p);
    return sigmoid(state.k * logOdds + state.b);
}

/**
 * Domain-specific calibration using context about available data sources.
 *
 * Selects an appropriate k based on what information Claude had access to:
 * - With bookmaker odds: k = 0.85 (odds provide a strong anchor)
 * - With ensemble agreement: k = 0.75 (multi-model reduces single-model bias)
 * - Claude alone, no data: k = 0.50 (least trustworthy)
 * - Default: learned k (starts at 0.65)
 *
 * The bias term b always comes from the learned state.
 *
 * @param {number} rawProb — Claude's raw probability estimate (0-1)
 * @param {object} context — { hasOdds, hasEnsemble, hasNews, category }
 * @returns {number} calibrated probability (0-1)
 */
export function calibrateWithContext(rawProb, context = {}) {
    const { hasOdds, hasEnsemble, hasNews, category } = context;
    const p = clampProb(rawProb);
    const logOdds = logit(p);

    // Select k based on context (ordered by trust level)
    let k;
    if (hasOdds) {
        k = CONTEXT_K.withOdds;
    } else if (hasEnsemble) {
        k = CONTEXT_K.withEnsemble;
    } else if (hasNews) {
        // News gives some grounding — use learned k (starts at 0.65)
        k = state.k;
    } else {
        // Claude alone — minimum trust
        k = CONTEXT_K.claudeAlone;
    }

    // If we have many SGD updates, blend toward the learned k
    // (as we gather data, trust the empirical calibration more)
    if (state.updates >= 30) {
        // After 30+ resolved trades, give 50% weight to learned k
        const blendWeight = Math.min(0.5, state.updates / 200);
        k = k * (1 - blendWeight) + state.k * blendWeight;
    }

    return sigmoid(k * logOdds + state.b);
}

/**
 * Online SGD update after a trade resolves.
 *
 * Minimizes cross-entropy loss:
 *   L = -(y * log(σ(z)) + (1-y) * log(1 - σ(z)))
 * where z = k * logit(rawProb) + b
 *
 * Gradients:
 *   dL/dk = (σ(z) - y) * logit(rawProb)
 *   dL/db = (σ(z) - y)
 *
 * @param {number} rawProb — the Claude probability estimate at time of trade
 * @param {number} actualOutcome — 0 or 1 (did the event happen?)
 */
export function updateCalibration(rawProb, actualOutcome) {
    const y = actualOutcome === 1 ? 1 : 0;
    const p = clampProb(rawProb);
    const logOdds = logit(p);

    // Forward pass
    const z = state.k * logOdds + state.b;
    const predicted = sigmoid(z);

    // Cross-entropy loss for monitoring
    const loss = -(y * Math.log(clampProb(predicted)) + (1 - y) * Math.log(clampProb(1 - predicted)));
    state.totalLoss += loss;

    // Gradients
    const error = predicted - y;   // (σ(z) - y)
    const dL_dk = error * logOdds;
    const dL_db = error;

    // SGD update
    state.k -= LEARNING_RATE * dL_dk;
    state.b -= LEARNING_RATE * dL_db;

    // Clamp k to valid range
    state.k = Math.max(MIN_K, Math.min(MAX_K, state.k));

    // Clamp b to prevent extreme directional bias
    state.b = Math.max(-2.0, Math.min(2.0, state.b));

    state.updates++;

    // Persist after each update
    saveState();
}

/**
 * Return current calibration state for monitoring / debugging.
 *
 * @returns {object} { k, b, updates, avgLoss, contextKValues }
 */
export function getCalibrationStats() {
    return {
        k: state.k,
        b: state.b,
        updates: state.updates,
        avgLoss: state.updates > 0 ? state.totalLoss / state.updates : null,
        totalLoss: state.totalLoss,
        contextKValues: { ...CONTEXT_K },
        stateFile: STATE_FILE,
    };
}
