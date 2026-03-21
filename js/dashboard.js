// Dashboard — live autopilot activity view
// Polls /api/dashboard every 30s and renders bot status, trades, performance.

(function () {
    let pollInterval = null;
    let isActive = false;

    // Start polling when dashboard tab is visible
    const observer = new MutationObserver(() => {
        const el = document.getElementById('dashboardView');
        if (!el) return;
        const nowActive = el.classList.contains('active');
        if (nowActive && !isActive) {
            isActive = true;
            fetchDashboard();
            if (pollInterval) clearInterval(pollInterval);
            pollInterval = setInterval(fetchDashboard, 30000);
        } else if (!nowActive && isActive) {
            isActive = false;
            if (pollInterval) clearInterval(pollInterval);
        }
    });

    document.addEventListener('DOMContentLoaded', () => {
        const el = document.getElementById('dashboardView');
        if (el) {
            observer.observe(el, { attributes: true, attributeFilter: ['class'] });
            // Auto-start if dashboard is the default active tab
            if (el.classList.contains('active')) {
                isActive = true;
                fetchDashboard();
                pollInterval = setInterval(fetchDashboard, 30000);
            }
        }
    });

    async function fetchDashboard() {
        try {
            const resp = await fetch('/api/dashboard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            if (!resp.ok) return;
            const data = await resp.json();
            render(data);
        } catch (err) {
            console.error('Dashboard fetch failed:', err);
        }
    }

    function render(d) {
        lastData = d;

        // Status
        const statusEl = document.getElementById('dashStatus');
        if (statusEl) {
            const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            statusEl.textContent = `Last updated ${now} \u2022 ${d.allTime.cycleActions} actions logged`;
        }

        // Summary cards
        setText('dTodayTrades', `${d.today.buys}${d.today.paperBuys ? ` (${d.today.paperBuys} paper)` : ''}`);
        setText('dTodayPnl', formatPnl(d.today.pnl));
        setText('dWinRate', d.allTime.resolutions > 0 ? `${(d.allTime.winRate * 100).toFixed(0)}%` : '—');
        setText('dAllPnl', d.allTime.resolutions > 0 ? formatPnl(d.allTime.pnl) : '—');
        setText('dResolutions', d.allTime.resolutions > 0 ? `${d.allTime.resolutions} (${d.allTime.wins}W/${d.allTime.resolutions - d.allTime.wins}L)` : '0');
        setText('dCalibration', `${d.calibration.k?.toFixed(3) || '0.650'} (${d.calibration.updates || 0} updates)`);

        colorPnl('dTodayPnl', d.today.pnl);
        colorPnl('dAllPnl', d.allTime.pnl);

        // Activity feed
        const actEl = document.getElementById('dashActivity');
        if (d.recentActivity.length === 0) {
            actEl.innerHTML = '<div class="empty-state small"><p>No activity yet. Waiting for first cycle...</p></div>';
        } else {
            actEl.innerHTML = d.recentActivity.map(a => {
                const time = fmtTime(a.time);
                const paper = a.paper ? '<span class="dash-tag tag-paper">PAPER</span>' : '';
                if (a.action === 'buy') {
                    return `<div class="dash-row dash-row-buy">
                        <span class="dash-time">${time}</span>
                        <span class="dash-badge badge-buy">BUY</span>
                        ${paper}
                        <span class="dash-tag tag-strat">${a.strategy}</span>
                        <span class="dash-detail">${a.side.toUpperCase()} ${trunc(a.market || a.ticker, 45)} &mdash; ${a.count} @ ${fmtPrice(a.price)}</span>
                        ${a.edge ? `<span class="dash-edge">${a.edge.toFixed(1)}pts</span>` : ''}
                    </div>`;
                } else if (a.action === 'exit') {
                    return `<div class="dash-row dash-row-sell">
                        <span class="dash-time">${time}</span>
                        <span class="dash-badge badge-sell">EXIT</span>
                        <span class="dash-detail">${a.side.toUpperCase()} ${trunc(a.market || a.ticker, 45)} &mdash; ${a.count} @ ${fmtPrice(a.price)}</span>
                        <span class="dash-reason">${a.reason}</span>
                    </div>`;
                } else if (a.action === 'exit_failed') {
                    return `<div class="dash-row dash-row-err">
                        <span class="dash-time">${time}</span>
                        <span class="dash-badge badge-err">FAIL</span>
                        <span class="dash-detail">${a.ticker} &mdash; ${a.error}</span>
                    </div>`;
                }
                return '';
            }).join('');
        }

        // Trades tracker
        renderTrades(d);

        // Strategy performance table
        const stratEl = document.getElementById('dashStrategies');
        const strats = Object.entries(d.strategies);
        if (strats.length === 0) {
            stratEl.innerHTML = '<div class="empty-state small"><p>No resolved trades yet</p></div>';
        } else {
            const modes = d.meta?.strategyModes || {};
            stratEl.innerHTML = `<table class="dash-table">
                <thead><tr><th>Strategy</th><th>Mode</th><th>W/L</th><th>Win%</th><th>P&L</th></tr></thead>
                <tbody>${strats.map(([name, s]) => {
                    const wr = s.trades > 0 ? ((s.wins / s.trades) * 100).toFixed(0) : '0';
                    const mode = modes[name] || 'live';
                    const modeClass = mode === 'paper' ? 'tag-paper' : 'tag-live';
                    return `<tr>
                        <td>${name}</td>
                        <td><span class="dash-tag ${modeClass}">${mode.toUpperCase()}</span></td>
                        <td>${s.wins}W / ${s.losses}L</td>
                        <td>${wr}%</td>
                        <td class="${s.pnl >= 0 ? 'clr-green' : 'clr-red'}">${formatPnl(s.pnl)}</td>
                    </tr>`;
                }).join('')}</tbody>
            </table>`;

            // Category breakdown below
            const cats = Object.entries(d.categories);
            if (cats.length > 0) {
                stratEl.innerHTML += `<h3 style="margin:12px 0 6px;font-size:13px;color:var(--text-secondary)">By Category</h3>
                <table class="dash-table">
                    <thead><tr><th>Category</th><th>W/L</th><th>Win%</th><th>P&L</th></tr></thead>
                    <tbody>${cats.sort((a, b) => b[1].pnl - a[1].pnl).map(([name, s]) => {
                        const wr = s.trades > 0 ? ((s.wins / s.trades) * 100).toFixed(0) : '0';
                        const blocked = (d.meta?.blockedCategories || []).includes(name);
                        return `<tr>
                            <td>${name}${blocked ? ' <span class="dash-tag tag-err">BLOCKED</span>' : ''}</td>
                            <td>${s.wins}W / ${s.losses}L</td>
                            <td>${wr}%</td>
                            <td class="${s.pnl >= 0 ? 'clr-green' : 'clr-red'}">${formatPnl(s.pnl)}</td>
                        </tr>`;
                    }).join('')}</tbody>
                </table>`;
            }
        }

        // Meta-agent status
        const metaEl = document.getElementById('dashMeta');
        if (!d.meta) {
            metaEl.innerHTML = '<div class="empty-state small"><p>Meta-agent has not run yet</p></div>';
        } else {
            const modes = Object.entries(d.meta.strategyModes || {});
            const blocked = d.meta.blockedCategories || [];
            const budgets = Object.entries(d.meta.strategyBudgets || {});
            metaEl.innerHTML = `
                <div class="dash-meta-grid">
                    <div class="dash-meta-item">
                        <span class="dash-meta-label">Last Updated</span>
                        <span class="dash-meta-val">${d.meta.lastUpdated ? fmtTime(d.meta.lastUpdated) : 'Never'}</span>
                    </div>
                    <div class="dash-meta-item">
                        <span class="dash-meta-label">Strategy Modes</span>
                        <span class="dash-meta-val">${modes.map(([k, v]) => `${k}: <span class="dash-tag ${v === 'paper' ? 'tag-paper' : 'tag-live'}">${v}</span>`).join(', ') || 'Default'}</span>
                    </div>
                    <div class="dash-meta-item">
                        <span class="dash-meta-label">Blocked Categories</span>
                        <span class="dash-meta-val">${blocked.length > 0 ? blocked.map(c => `<span class="dash-tag tag-err">${c}</span>`).join(' ') : 'None'}</span>
                    </div>
                    <div class="dash-meta-item">
                        <span class="dash-meta-label">Budgets</span>
                        <span class="dash-meta-val">${budgets.map(([k, v]) => `${k}: $${v}`).join(', ') || 'Default ($50 each)'}</span>
                    </div>
                    <div class="dash-meta-item">
                        <span class="dash-meta-label">Calibration</span>
                        <span class="dash-meta-val">k=${d.calibration.k?.toFixed(3) || '?'}, b=${d.calibration.b?.toFixed(3) || '?'}, ${d.calibration.updates || 0} updates</span>
                    </div>
                </div>`;
        }

        // Monitor decisions
        const monEl = document.getElementById('dashMonitor');
        if (d.recentMonitor.length === 0) {
            monEl.innerHTML = '<div class="empty-state small"><p>No monitor decisions yet</p></div>';
        } else {
            monEl.innerHTML = d.recentMonitor.map(m => {
                const icon = m.decision === 'SELL' ? 'badge-sell' : 'badge-hold';
                const label = m.decision === 'SELL' ? 'SELL' : 'HOLD';
                return `<div class="dash-row">
                    <span class="dash-time">${fmtTime(m.time)}</span>
                    <span class="dash-badge ${icon}">${label}</span>
                    <span class="dash-detail">${trunc(m.market || m.ticker, 40)}</span>
                    <span class="dash-pnl ${m.pnlPct >= 0 ? 'clr-green' : 'clr-red'}">${m.pnlPct >= 0 ? '+' : ''}${m.pnlPct?.toFixed(1) || '0'}%</span>
                    <div class="dash-reasoning">${trunc(m.reasoning, 120)}</div>
                </div>`;
            }).join('');
        }
    }

    // ── Trades tracker ──

    let currentTradesFilter = 'all';

    // Tab switching for trades
    document.addEventListener('click', (e) => {
        if (!e.target.matches('[data-trades-tab]')) return;
        document.querySelectorAll('[data-trades-tab]').forEach(t => t.classList.remove('active'));
        e.target.classList.add('active');
        currentTradesFilter = e.target.dataset.tradesTab;
        if (lastData) renderTrades(lastData);
    });

    let lastData = null;

    function renderTrades(d) {
        const el = document.getElementById('dashTrades');
        if (!el) return;

        // Merge paper + live trades, sort newest first
        const all = [
            ...(d.paperTrades || []),
            ...(d.liveTrades || []),
        ].sort((a, b) => new Date(b.time) - new Date(a.time));

        // Apply filter
        let filtered = all;
        if (currentTradesFilter === 'open') filtered = all.filter(t => t.status === 'open');
        else if (currentTradesFilter === 'resolved') filtered = all.filter(t => t.status === 'resolved');
        else if (currentTradesFilter === 'paper') filtered = all.filter(t => !t.live);

        if (filtered.length === 0) {
            el.innerHTML = `<div class="dash-empty">
                <p>${currentTradesFilter === 'all' ? 'No trades yet' : `No ${currentTradesFilter} trades`}</p>
                <p class="dash-empty-hint">Trades appear as the bot executes cycles</p>
            </div>`;
            return;
        }

        el.innerHTML = `<table class="dash-table dash-trades-table">
            <thead><tr>
                <th>Time</th>
                <th>Type</th>
                <th>Strategy</th>
                <th>Market</th>
                <th>Side</th>
                <th>Entry</th>
                <th>Qty</th>
                <th>Edge</th>
                <th>Status</th>
                <th>Result</th>
            </tr></thead>
            <tbody>${filtered.slice(0, 50).map(t => {
                const typeTag = t.live
                    ? '<span class="dash-tag tag-live">LIVE</span>'
                    : '<span class="dash-tag tag-paper">PAPER</span>';

                let statusHtml;
                if (t.status === 'resolved') {
                    const wonClass = t.won ? 'tag-live' : 'tag-err';
                    const wonText = t.won ? 'WON' : 'LOST';
                    statusHtml = `<span class="dash-tag ${wonClass}">${wonText}</span>`;
                } else {
                    statusHtml = '<span class="dash-tag tag-open">OPEN</span>';
                }

                let resultHtml;
                if (t.status === 'resolved') {
                    resultHtml = `<span class="${t.pnl >= 0 ? 'clr-green' : 'clr-red'}">${formatPnl(t.pnl)}</span>`;
                } else {
                    resultHtml = '<span class="dash-pending">Pending</span>';
                }

                return `<tr>
                    <td class="dash-time">${fmtDateTime(t.time)}</td>
                    <td>${typeTag}</td>
                    <td>${t.strategy}</td>
                    <td class="dash-market-cell" title="${t.market}">${trunc(t.market, 35)}</td>
                    <td><span class="dash-side-${t.side}">${t.side.toUpperCase()}</span></td>
                    <td class="mono">${fmtPrice(t.entryPrice)}</td>
                    <td class="mono">${t.count}</td>
                    <td class="mono">${t.edge ? t.edge.toFixed(1) + 'pts' : '--'}</td>
                    <td>${statusHtml}</td>
                    <td class="mono">${resultHtml}</td>
                </tr>`;
            }).join('')}</tbody>
        </table>`;
    }

    // Helpers
    function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
    function colorPnl(id, val) {
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.remove('clr-green', 'clr-red');
        if (val > 0) el.classList.add('clr-green');
        else if (val < 0) el.classList.add('clr-red');
    }
    function formatPnl(v) { return v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`; }
    function fmtPrice(p) { return typeof p === 'number' ? (p < 1 ? `${(p * 100).toFixed(0)}c` : `${p.toFixed(0)}c`) : '?'; }
    function fmtTime(ts) {
        try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
        catch { return ''; }
    }
    function fmtDateTime(ts) {
        try {
            const d = new Date(ts);
            const month = (d.getMonth() + 1).toString().padStart(2, '0');
            const day = d.getDate().toString().padStart(2, '0');
            const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            return `${month}/${day} ${time}`;
        } catch { return ''; }
    }
    function trunc(s, n) { return s && s.length > n ? s.slice(0, n) + '...' : (s || ''); }
})();
