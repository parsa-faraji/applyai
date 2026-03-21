/**
 * Daily Performance Report — generates a PDF summary of bot activity.
 *
 * Called nightly by autopilot. Reads all JSONL data files and meta-config,
 * produces a human-readable PDF saved to data/reports/.
 *
 * Includes: P&L summary, trades, exits, monitor decisions, meta-agent stats,
 * signal win rates, edge calibration, and strategy modes.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import PDFDocument from 'pdfkit';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const REPORTS_DIR = path.join(DATA_DIR, 'reports');

// ── Data readers ──

function readJsonl(filename) {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
}

function readMetaConfig() {
    const configPath = path.join(DATA_DIR, 'meta-config.json');
    if (!fs.existsSync(configPath)) return null;
    try { return JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch { return null; }
}

function filterToday(records) {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    return records.filter(r => new Date(r.timestamp) >= todayStart);
}

function filterLast30d(records) {
    const cutoff = new Date(Date.now() - 30 * 86400000);
    return records.filter(r => new Date(r.timestamp) >= cutoff);
}

// ── PDF helpers ──

function addTitle(doc, text) {
    doc.fontSize(18).font('Helvetica-Bold').text(text, { underline: false });
    doc.moveDown(0.3);
    doc.moveTo(doc.x, doc.y).lineTo(doc.x + 500, doc.y).stroke('#333');
    doc.moveDown(0.5);
}

function addSection(doc, text) {
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#1a1a2e').text(text);
    doc.moveDown(0.3);
}

function addText(doc, text, opts = {}) {
    doc.fontSize(9).font('Helvetica').fillColor('#333').text(text, opts);
}

function addBoldText(doc, text) {
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#333').text(text);
}

function addKV(doc, key, value) {
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#555')
        .text(`${key}: `, { continued: true })
        .font('Helvetica').fillColor('#333')
        .text(String(value));
}

function addSpacer(doc) {
    doc.moveDown(0.5);
}

function checkPage(doc) {
    if (doc.y > 700) doc.addPage();
}

// ── Main report generator ──

export function generateDailyReport() {
    // Ensure reports directory exists
    if (!fs.existsSync(REPORTS_DIR)) {
        fs.mkdirSync(REPORTS_DIR, { recursive: true });
    }

    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const filename = `report-${dateStr}.pdf`;
    const filePath = path.join(REPORTS_DIR, filename);

    // Read all data
    const allTrades = readJsonl('trades.jsonl');
    const allDecisions = readJsonl('decisions.jsonl');
    const allResolutions = readJsonl('resolutions.jsonl');
    const allMonitorDecisions = readJsonl('monitor-decisions.jsonl');
    const allCycleActions = readJsonl('cycle-actions.jsonl');
    const metaConfig = readMetaConfig();

    const todayTrades = filterToday(allTrades);
    const todayDecisions = filterToday(allDecisions);
    const todayResolutions = filterToday(allResolutions);
    const todayMonitor = filterToday(allMonitorDecisions);
    const todayCycles = filterToday(allCycleActions);

    const last30dResolutions = filterLast30d(allResolutions);

    // Create PDF
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    // ═══ HEADER ═══
    doc.fontSize(22).font('Helvetica-Bold').fillColor('#1a1a2e')
        .text('Trading Bot Daily Report', { align: 'center' });
    doc.fontSize(11).font('Helvetica').fillColor('#666')
        .text(`${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} | Generated ${now.toLocaleTimeString()}`, { align: 'center' });
    doc.moveDown(1);

    // ═══ TODAY'S SUMMARY ═══
    addTitle(doc, "Today's Summary");

    const todayBuys = todayCycles.filter(a => a.action === 'buy');
    const todayExits = todayCycles.filter(a => a.action === 'exit');
    const todayExitFails = todayCycles.filter(a => a.action === 'exit_failed');
    const todayWins = todayResolutions.filter(r => r.won);
    const todayLosses = todayResolutions.filter(r => !r.won);
    const todayPnl = todayResolutions.reduce((s, r) => s + (r.totalPnl || 0), 0);
    const todayApiCost = todayTrades.reduce((s, t) => s + (t.apiCost || 0.20), 0) + todayDecisions.length * 0.15;

    addKV(doc, 'Trades Entered', `${todayBuys.length} (${todayBuys.filter(b => b.paper).length} paper)`);
    addKV(doc, 'Exits Executed', `${todayExits.length} (${todayExitFails.length} failed)`);
    addKV(doc, 'Markets Analyzed', String(todayDecisions.length));
    addKV(doc, 'Resolutions', `${todayResolutions.length} (${todayWins.length}W / ${todayLosses.length}L)`);
    addKV(doc, 'Gross P&L', `$${todayPnl.toFixed(2)}`);
    addKV(doc, 'Est. API Cost', `$${todayApiCost.toFixed(2)}`);
    addKV(doc, 'Net P&L', `$${(todayPnl - todayApiCost).toFixed(2)}`);
    addKV(doc, 'Monitor Decisions', `${todayMonitor.length} (${todayMonitor.filter(d => d.decision === 'SELL').length} SELL, ${todayMonitor.filter(d => d.decision === 'HOLD').length} HOLD)`);
    addSpacer(doc);

    // ═══ TRADES TODAY ═══
    if (todayBuys.length > 0) {
        addSection(doc, 'Trades Entered Today');
        for (const t of todayBuys) {
            const paperTag = t.paper ? ' [PAPER]' : '';
            addText(doc, `${paperTag} ${t.strategy || '?'} | ${t.side?.toUpperCase()} ${t.market?.slice(0, 60) || t.ticker} | ${t.count} @ ${typeof t.price === 'number' ? (t.price < 1 ? (t.price * 100).toFixed(0) : t.price.toFixed(0)) : '?'}c | edge: ${t.edge ? t.edge.toFixed(1) + 'pts' : '?'}`);
        }
        addSpacer(doc);
    }

    // ═══ EXITS TODAY ═══
    if (todayExits.length > 0) {
        checkPage(doc);
        addSection(doc, 'Exits Today');
        for (const e of todayExits) {
            addText(doc, `${e.ticker} | ${e.side?.toUpperCase()} ${e.shares} contracts @ ${e.price}c | reason: ${e.reason} | P&L: ${e.pnlPct ? e.pnlPct.toFixed(1) + '%' : '?'}`);
        }
        addSpacer(doc);
    }

    // ═══ MONITOR DECISIONS ═══
    if (todayMonitor.length > 0) {
        checkPage(doc);
        addSection(doc, 'Monitor Decisions Today');
        for (const d of todayMonitor) {
            const icon = d.decision === 'SELL' ? 'SELL' : 'HOLD';
            addBoldText(doc, `[${icon}] ${d.market?.slice(0, 55) || d.ticker}`);
            addText(doc, `  P&L: ${d.pnlPct?.toFixed(1) || '?'}% | Trigger: ${d.triggerType} | ${d.reasoning || 'No reasoning'}`);
        }
        addSpacer(doc);
    }

    // ═══ RESOLUTIONS TODAY ═══
    if (todayResolutions.length > 0) {
        checkPage(doc);
        addSection(doc, 'Resolutions Today');
        for (const r of todayResolutions) {
            const status = r.won ? 'WON' : 'LOST';
            addText(doc, `${status}: ${r.market?.slice(0, 50) || r.ticker} | ${r.side?.toUpperCase()} @ ${((r.entryPrice || 0) * 100).toFixed(0)}c | P&L: $${(r.totalPnl || 0).toFixed(2)} | ${r.category || '?'} | edge: ${r.edge ? r.edge.toFixed(1) : '?'}pts`);
        }
        addSpacer(doc);
    }

    // ═══ 30-DAY PERFORMANCE ═══
    checkPage(doc);
    addTitle(doc, '30-Day Performance');

    if (last30dResolutions.length > 0) {
        const wins30 = last30dResolutions.filter(r => r.won).length;
        const total30 = last30dResolutions.length;
        const pnl30 = last30dResolutions.reduce((s, r) => s + (r.totalPnl || 0), 0);

        addKV(doc, 'Total Resolved', `${total30} trades`);
        addKV(doc, 'Win Rate', `${(wins30 / total30 * 100).toFixed(1)}% (${wins30}W / ${total30 - wins30}L)`);
        addKV(doc, 'Total P&L', `$${pnl30.toFixed(2)}`);
        addSpacer(doc);

        // By strategy
        addSection(doc, 'By Strategy');
        const byStrat = {};
        for (const r of last30dResolutions) {
            const k = r.strategy || 'unknown';
            if (!byStrat[k]) byStrat[k] = { w: 0, l: 0, pnl: 0 };
            if (r.won) byStrat[k].w++; else byStrat[k].l++;
            byStrat[k].pnl += r.totalPnl || 0;
        }
        for (const [strat, s] of Object.entries(byStrat)) {
            const wr = ((s.w / (s.w + s.l)) * 100).toFixed(0);
            addText(doc, `${strat}: ${s.w}W/${s.l}L (${wr}%) | P&L: $${s.pnl.toFixed(2)}`);
        }
        addSpacer(doc);

        // By category
        checkPage(doc);
        addSection(doc, 'By Category');
        const byCat = {};
        for (const r of last30dResolutions) {
            const k = r.category || 'other';
            if (!byCat[k]) byCat[k] = { w: 0, l: 0, pnl: 0 };
            if (r.won) byCat[k].w++; else byCat[k].l++;
            byCat[k].pnl += r.totalPnl || 0;
        }
        for (const [cat, s] of Object.entries(byCat).sort((a, b) => b[1].pnl - a[1].pnl)) {
            const wr = ((s.w / (s.w + s.l)) * 100).toFixed(0);
            const tag = s.pnl < 0 ? ' ** LOSING **' : '';
            addText(doc, `${cat}: ${s.w}W/${s.l}L (${wr}%) | P&L: $${s.pnl.toFixed(2)}${tag}`);
        }
        addSpacer(doc);
    } else {
        addText(doc, 'No resolutions in last 30 days.');
        addSpacer(doc);
    }

    // ═══ META-AGENT STATS ═══
    checkPage(doc);
    addTitle(doc, 'Meta-Agent Intelligence');

    if (metaConfig) {
        addKV(doc, 'Last Updated', metaConfig.lastUpdated || 'Never');
        addKV(doc, 'Strategy Modes', JSON.stringify(metaConfig.strategyModes || {}));
        addKV(doc, 'Blocked Categories', (metaConfig.blockedCategories || []).join(', ') || 'None');
        addKV(doc, 'Strategy Budgets', JSON.stringify(metaConfig.strategyBudgets || {}));
        addSpacer(doc);

        // Signal-level win rates
        if (metaConfig.signalStats && Object.keys(metaConfig.signalStats).length > 0) {
            addSection(doc, 'Signal Win Rates');
            for (const [key, s] of Object.entries(metaConfig.signalStats).sort((a, b) => b[1].trades - a[1].trades)) {
                if (s.trades < 2) continue;
                const wr = (s.winRate * 100).toFixed(0);
                addText(doc, `[${key}]: ${s.wins}W/${s.losses}L (${wr}%) | avg edge: ${(s.avgEdge || 0).toFixed(1)}pts | P&L: $${(s.totalPnl || 0).toFixed(2)} (${s.trades} trades)`);
            }
            addSpacer(doc);
        }

        // Edge buckets
        if (metaConfig.edgeBuckets && Object.keys(metaConfig.edgeBuckets).length > 0) {
            checkPage(doc);
            addSection(doc, 'Edge Calibration (estimated edge vs actual win rate)');
            for (const [bucket, b] of Object.entries(metaConfig.edgeBuckets).sort((a, b) => a[0].localeCompare(b[0]))) {
                if (b.trades < 2) continue;
                const wr = (b.winRate * 100).toFixed(0);
                const status = b.winRate > 0.55 ? 'PROFITABLE' : b.winRate > 0.45 ? 'BREAKEVEN' : 'LOSING';
                addText(doc, `${bucket}pts: ${b.wins}W/${b.losses}L (${wr}%) | P&L: $${(b.totalPnl || 0).toFixed(2)} [${status}]`);
            }
            addSpacer(doc);
        }

        // Empirical Kelly
        if (metaConfig.empiricalKelly && Object.keys(metaConfig.empiricalKelly).length > 0) {
            checkPage(doc);
            addSection(doc, 'Empirical Kelly Fractions (data-driven sizing)');
            for (const [key, k] of Object.entries(metaConfig.empiricalKelly)) {
                addText(doc, `[${key}]: quarter-Kelly = ${k.quarterKelly} | win rate: ${(k.winRate * 100).toFixed(0)}% (n=${k.sampleSize})`);
            }
            addSpacer(doc);
        }

        // Edge decay alerts
        if (metaConfig.edgeDecayAlerts?.length > 0) {
            checkPage(doc);
            addSection(doc, 'Edge Decay Alerts');
            for (const a of metaConfig.edgeDecayAlerts) {
                addText(doc, `${a.strategy}: 90d ${(a.winRate90d * 100).toFixed(0)}% -> 30d ${(a.winRate30d * 100).toFixed(0)}% (${(a.drop * 100).toFixed(1)}% drop)`);
            }
            addSpacer(doc);
        }

        // Performance snapshot
        if (metaConfig.performanceSnapshot) {
            const snap = metaConfig.performanceSnapshot;
            if (snap.netPnl30d != null) {
                checkPage(doc);
                addSection(doc, 'True P&L (including API costs)');
                addKV(doc, 'Gross P&L (30d)', `$${(snap.grossPnl30d || 0).toFixed(2)}`);
                addKV(doc, 'API Costs (30d)', `$${(snap.apiCost30d || 0).toFixed(2)}`);
                addKV(doc, 'Net P&L (30d)', `$${(snap.netPnl30d || 0).toFixed(2)}`);
                addSpacer(doc);
            }
        }
    } else {
        addText(doc, 'Meta-agent has not run yet (no data/meta-config.json).');
        addSpacer(doc);
    }

    // ═══ ALL-TIME STATS ═══
    checkPage(doc);
    addTitle(doc, 'All-Time Statistics');
    addKV(doc, 'Total Trades Logged', String(allTrades.length));
    addKV(doc, 'Total Decisions Logged', String(allDecisions.length));
    addKV(doc, 'Total Resolutions', String(allResolutions.length));
    addKV(doc, 'Total Monitor Decisions', String(allMonitorDecisions.length));
    addKV(doc, 'Total Cycle Actions', String(allCycleActions.length));

    if (allResolutions.length > 0) {
        const allWins = allResolutions.filter(r => r.won).length;
        const allPnl = allResolutions.reduce((s, r) => s + (r.totalPnl || 0), 0);
        addKV(doc, 'All-Time Win Rate', `${(allWins / allResolutions.length * 100).toFixed(1)}%`);
        addKV(doc, 'All-Time P&L', `$${allPnl.toFixed(2)}`);
    }

    // Footer
    doc.moveDown(2);
    doc.fontSize(8).font('Helvetica').fillColor('#999')
        .text('Generated by Meta-Agent | ApplyAI Trading Bot', { align: 'center' });

    doc.end();

    return new Promise((resolve, reject) => {
        stream.on('finish', () => resolve(filePath));
        stream.on('error', reject);
    });
}
