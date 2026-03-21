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
            pollInterval = setInterval(fetchDashboard, 30000);
        } else if (!nowActive && isActive) {
            isActive = false;
            if (pollInterval) clearInterval(pollInterval);
        }
    });

    // Also trigger on nav clicks
    document.addEventListener('DOMContentLoaded', () => {
        const el = document.getElementById('dashboardView');
        if (el) observer.observe(el, { attributes: true, attributeFilter: ['class'] });
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
        // Summary cards
        setText('dTodayTrades', `${d.today.buys}${d.today.paperBuys ? ` (${d.today.paperBuys} paper)` : ''}`);
        setText('dTodayPnl', formatPnl(d.today.pnl));
        setText('dWinRate', d.allTime.resolutions > 0 ? `${(d.allTime.winRate * 100).toFixed(0)}%` : 'N/A');
        setText('dAllPnl', formatPnl(d.allTime.pnl));
        setText('dResolutions', `${d.allTime.resolutions} (${d.allTime.wins}W/${d.allTime.resolutions - d.allTime.wins}L)`);
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
    function trunc(s, n) { return s && s.length > n ? s.slice(0, n) + '...' : (s || ''); }
})();
