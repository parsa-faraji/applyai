// Debug endpoint — returns raw JSONL data for verification.
// Hit GET /api/debug-data to see what's actually on disk.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

function readJsonl(filename) {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

function readJson(filename) {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { return null; }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const resolutions = readJsonl('resolutions.jsonl');
    const trades = readJsonl('trades.jsonl');
    const cycles = readJsonl('cycle-actions.jsonl');
    const monitor = readJsonl('monitor-decisions.jsonl');
    const meta = readJson('meta-config.json');
    const cal = readJson('calibration.json');

    // Check for duplicate tickers in resolutions
    const resTickers = resolutions.map(r => r.ticker);
    const dupTickers = resTickers.filter((t, i) => resTickers.indexOf(t) !== i);

    return res.status(200).json({
        files: {
            'resolutions.jsonl': resolutions.length,
            'trades.jsonl': trades.length,
            'cycle-actions.jsonl': cycles.length,
            'monitor-decisions.jsonl': monitor.length,
        },
        duplicateResolutions: dupTickers,
        resolutions,
        trades: trades.slice(-20),
        calibration: cal,
        meta,
    });
}
