/**
 * PredictBot — AI-Powered Prediction Market Trading
 * Frontend with live price streaming, real-time P&L, and mini charts
 */

(function () {
    'use strict';

    // ── State ──────────────────────────────────────────────
    const state = {
        markets: [],
        selectedMarket: null,
        analysis: null,
        tradeSide: null,
        trades: JSON.parse(localStorage.getItem('pb_trades') || '[]'),
        positions: JSON.parse(localStorage.getItem('pb_positions') || '[]'),
        settings: JSON.parse(localStorage.getItem('pb_settings') || '{}'),
        budget: JSON.parse(localStorage.getItem('pb_budget') || '{"total":100,"spent":0}'),
        marketsOffset: 0,
        marketsLoading: false,
        botRunning: false,
        // Live data
        livePrices: {},       // tokenId -> { mid, bestBid, bestAsk, updated }
        pricePollingId: null,  // interval ID for market price polling
        positionPollingId: null, // interval ID for position P&L refresh
        liveContext: null,     // current market's live order book + history
        // Monitor
        monitorId: null,       // interval ID for position monitor
        monitorRunning: false,
        rescanId: null,        // interval ID for auto re-scan
    };

    const DEFAULTS = {
        maxPositionSize: 25,
        tradingBudget: 100,
        riskLevel: 'moderate',
        autoTrade: false,
        stopLossPct: 30,
        takeProfitPct: 50,
        monitorInterval: 5,
        autoRescan: 0,
    };

    const PRICE_POLL_INTERVAL = 10000;  // 10s for market prices
    const POSITION_POLL_INTERVAL = 30000; // 30s for position P&L

    // ── Init ───────────────────────────────────────────────
    function init() {
        setupNavigation();
        loadSettings();
        loadMarkets();
        checkApiStatus();
        updateBudgetDisplay();
        startPositionPolling();
    }

    // ── Navigation ─────────────────────────────────────────
    function setupNavigation() {
        document.querySelectorAll('.nav-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const view = link.dataset.view;
                document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
                link.classList.add('active');
                document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
                const viewEl = document.getElementById(view + 'View');
                if (viewEl) viewEl.classList.add('active');
                if (view === 'portfolio') renderPortfolio();
            });
        });

        document.getElementById('saveSettings')?.addEventListener('click', saveSettings);
        document.getElementById('clearData')?.addEventListener('click', clearAllData);
        document.getElementById('analyzeBtn')?.addEventListener('click', analyzeMarket);
        document.getElementById('loadMoreBtn')?.addEventListener('click', loadMoreMarkets);
        document.getElementById('deriveKeysBtn')?.addEventListener('click', deriveApiKeys);
        document.getElementById('runBotBtn')?.addEventListener('click', () => runBot(false));
        document.getElementById('dryRunBtn')?.addEventListener('click', () => runBot(true));
        document.getElementById('startMonitorBtn')?.addEventListener('click', startMonitor);
        document.getElementById('stopMonitorBtn')?.addEventListener('click', stopMonitor);

        const searchInput = document.getElementById('marketSearch');
        if (searchInput) {
            let debounce;
            searchInput.addEventListener('input', () => {
                clearTimeout(debounce);
                debounce = setTimeout(() => filterMarkets(searchInput.value), 300);
            });
        }

        const sortSelect = document.getElementById('marketSort');
        if (sortSelect) {
            sortSelect.addEventListener('change', () => {
                state.marketsOffset = 0;
                loadMarkets();
            });
        }
    }

    // ── Settings ───────────────────────────────────────────
    function loadSettings() {
        const s = state.settings;
        const fields = {
            anthropicKey: s.anthropicKey,
            polyApiKey: s.polyApiKey,
            polySecret: s.polySecret,
            polyPassphrase: s.polyPassphrase,
            polyPrivateKey: s.polyPrivateKey,
        };
        for (const [id, val] of Object.entries(fields)) {
            const el = document.getElementById(id);
            if (el && val) el.value = val;
        }

        const maxPosition = document.getElementById('maxPositionSize');
        const tradingBudget = document.getElementById('tradingBudget');
        const riskLevel = document.getElementById('riskLevel');
        const autoTrade = document.getElementById('autoTrade');

        if (maxPosition) maxPosition.value = s.maxPositionSize || DEFAULTS.maxPositionSize;
        if (tradingBudget) tradingBudget.value = s.tradingBudget || DEFAULTS.tradingBudget;
        if (riskLevel) riskLevel.value = s.riskLevel || DEFAULTS.riskLevel;
        if (autoTrade) autoTrade.checked = s.autoTrade || DEFAULTS.autoTrade;

        const stopLoss = document.getElementById('stopLossPct');
        const takeProfit = document.getElementById('takeProfitPct');
        const monitorInt = document.getElementById('monitorInterval');
        const autoRescan = document.getElementById('autoRescan');
        if (stopLoss) stopLoss.value = s.stopLossPct || DEFAULTS.stopLossPct;
        if (takeProfit) takeProfit.value = s.takeProfitPct || DEFAULTS.takeProfitPct;
        if (monitorInt) monitorInt.value = s.monitorInterval ?? DEFAULTS.monitorInterval;
        if (autoRescan) autoRescan.value = s.autoRescan ?? DEFAULTS.autoRescan;
    }

    function saveSettings() {
        const newBudget = parseInt(document.getElementById('tradingBudget')?.value) || DEFAULTS.tradingBudget;
        const oldBudget = state.settings.tradingBudget || DEFAULTS.tradingBudget;

        state.settings = {
            anthropicKey: document.getElementById('anthropicKey')?.value || '',
            polyApiKey: document.getElementById('polyApiKey')?.value || '',
            polySecret: document.getElementById('polySecret')?.value || '',
            polyPassphrase: document.getElementById('polyPassphrase')?.value || '',
            polyPrivateKey: document.getElementById('polyPrivateKey')?.value || '',
            maxPositionSize: parseInt(document.getElementById('maxPositionSize')?.value) || DEFAULTS.maxPositionSize,
            tradingBudget: newBudget,
            riskLevel: document.getElementById('riskLevel')?.value || DEFAULTS.riskLevel,
            autoTrade: document.getElementById('autoTrade')?.checked || false,
            stopLossPct: parseInt(document.getElementById('stopLossPct')?.value) || DEFAULTS.stopLossPct,
            takeProfitPct: parseInt(document.getElementById('takeProfitPct')?.value) || DEFAULTS.takeProfitPct,
            monitorInterval: parseInt(document.getElementById('monitorInterval')?.value ?? DEFAULTS.monitorInterval),
            autoRescan: parseInt(document.getElementById('autoRescan')?.value ?? DEFAULTS.autoRescan),
        };
        localStorage.setItem('pb_settings', JSON.stringify(state.settings));

        if (newBudget !== oldBudget) {
            state.budget.total = newBudget;
            localStorage.setItem('pb_budget', JSON.stringify(state.budget));
            updateBudgetDisplay();
        }

        showToast('Settings saved', 'success');
        checkApiStatus();
    }

    async function deriveApiKeys() {
        const privateKey = document.getElementById('polyPrivateKey')?.value;
        if (!privateKey || privateKey.length < 10) {
            showToast('Enter your wallet private key first', 'error');
            return;
        }

        const btn = document.getElementById('deriveKeysBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Deriving...'; }

        try {
            const resp = await fetch('/api/derive-keys', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Poly-Private-Key': privateKey },
            });
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.error || 'Failed to derive keys');

            const creds = data.credentials;
            if (creds) {
                if (creds.apiKey) document.getElementById('polyApiKey').value = creds.apiKey;
                if (creds.secret) document.getElementById('polySecret').value = creds.secret;
                if (creds.passphrase) document.getElementById('polyPassphrase').value = creds.passphrase;
                showToast('API credentials derived! Click Save Settings.', 'success');
            }
        } catch (error) {
            showToast('Derive failed: ' + error.message, 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'Derive Keys'; }
        }
    }

    function clearAllData() {
        if (!confirm('This will clear all trades, positions, and settings. Continue?')) return;
        localStorage.removeItem('pb_trades');
        localStorage.removeItem('pb_positions');
        localStorage.removeItem('pb_settings');
        localStorage.removeItem('pb_budget');
        state.trades = [];
        state.positions = [];
        state.settings = {};
        state.budget = { total: 100, spent: 0 };
        loadSettings();
        updateBudgetDisplay();
        showToast('All data cleared', 'info');
    }

    // ── API Status ─────────────────────────────────────────
    function checkApiStatus() {
        const dot = document.getElementById('apiStatus');
        const text = document.getElementById('apiStatusText');
        const hasAnthropic = !!(state.settings.anthropicKey || '').trim();
        const hasPoly = !!(state.settings.polyApiKey || '').trim();
        const hasWallet = !!(state.settings.polyPrivateKey || '').trim();

        if (hasAnthropic && hasPoly && hasWallet) {
            dot.className = 'status-dot connected';
            text.textContent = 'Live trading ready';
        } else if (hasAnthropic && hasPoly) {
            dot.className = 'status-dot connected';
            text.textContent = 'Paper trading (no wallet)';
        } else if (hasAnthropic) {
            dot.className = 'status-dot';
            text.textContent = 'Claude ready (paper mode)';
        } else {
            dot.className = 'status-dot error';
            text.textContent = 'Configure API keys';
        }
    }

    // ── Live Price Polling ──────────────────────────────────
    // Poll CLOB midpoint for the selected market every 10s
    function startPricePolling(tokenIds) {
        stopPricePolling();
        if (!tokenIds || tokenIds.length === 0) return;

        const poll = async () => {
            for (const tokenId of tokenIds) {
                try {
                    const resp = await fetch(`https://clob.polymarket.com/midpoint?token_id=${tokenId}`);
                    if (resp.ok) {
                        const data = await resp.json();
                        state.livePrices[tokenId] = {
                            mid: parseFloat(data.mid),
                            updated: Date.now(),
                        };
                    }
                } catch { /* ignore */ }
            }
            updateLivePriceDisplay();
        };

        poll(); // immediate
        state.pricePollingId = setInterval(poll, PRICE_POLL_INTERVAL);
    }

    function stopPricePolling() {
        if (state.pricePollingId) {
            clearInterval(state.pricePollingId);
            state.pricePollingId = null;
        }
    }

    function updateLivePriceDisplay() {
        const market = state.selectedMarket;
        if (!market) return;

        const tokens = parseJsonSafe(market.clobTokenIds, []);
        const yesToken = tokens[0];
        const noToken = tokens[1];

        // Update price badges on the selected market card
        const yesLive = yesToken ? state.livePrices[yesToken] : null;
        const noLive = noToken ? state.livePrices[noToken] : null;

        // Update detail panel prices
        const outcomes = document.querySelectorAll('.outcome-price');
        if (yesLive && outcomes[0]) {
            outcomes[0].textContent = (yesLive.mid * 100).toFixed(1) + '%';
        }
        if (noLive && outcomes[1]) {
            outcomes[1].textContent = (noLive.mid * 100).toFixed(1) + '%';
        } else if (yesLive && outcomes[1]) {
            outcomes[1].textContent = ((1 - yesLive.mid) * 100).toFixed(1) + '%';
        }

        // Update the live indicator
        const liveIndicator = document.getElementById('liveIndicator');
        if (liveIndicator && yesLive) {
            const age = Math.floor((Date.now() - yesLive.updated) / 1000);
            liveIndicator.textContent = age < 5 ? 'LIVE' : `${age}s ago`;
            liveIndicator.className = age < 15 ? 'live-indicator live' : 'live-indicator stale';
        }

        // Update trade summary if active
        updateTradeSummary();
    }

    // ── Position P&L Polling ───────────────────────────────
    // Refresh position currentPrice every 30s from CLOB
    function startPositionPolling() {
        if (state.positionPollingId) return;

        const poll = async () => {
            if (state.positions.length === 0) return;

            let updated = false;
            for (const pos of state.positions) {
                if (!pos.tokenId) continue;
                try {
                    const resp = await fetch(`https://clob.polymarket.com/midpoint?token_id=${pos.tokenId}`);
                    if (resp.ok) {
                        const data = await resp.json();
                        const newPrice = parseFloat(data.mid);
                        if (newPrice && newPrice !== pos.currentPrice) {
                            pos.currentPrice = newPrice;
                            updated = true;
                        }
                    }
                } catch { /* ignore */ }
            }

            if (updated) {
                localStorage.setItem('pb_positions', JSON.stringify(state.positions));
                // Re-render if portfolio view is active
                if (document.getElementById('portfolioView')?.classList.contains('active')) {
                    renderPortfolio();
                }
            }
        };

        poll(); // immediate
        state.positionPollingId = setInterval(poll, POSITION_POLL_INTERVAL);
    }

    // ── Markets ────────────────────────────────────────────
    async function loadMarkets() {
        if (state.marketsLoading) return;
        state.marketsLoading = true;

        const list = document.getElementById('marketsList');
        if (state.marketsOffset === 0) {
            list.innerHTML = '<div class="loading-state"><span class="loading-spinner"></span> Loading markets...</div>';
        }

        try {
            const sortSelect = document.getElementById('marketSort');
            const orderMap = { volume: 'volume24hr', newest: 'startDate', ending: 'endDate', liquidity: 'liquidity' };
            const order = orderMap[sortSelect?.value || 'volume'] || 'volume24hr';
            const ascending = sortSelect?.value === 'ending' ? 'true' : 'false';

            const resp = await fetch(`/api/markets?limit=20&offset=${state.marketsOffset}&order=${order}&ascending=${ascending}`);
            if (!resp.ok) throw new Error('Failed to load markets');

            const markets = await resp.json();

            if (state.marketsOffset === 0) {
                state.markets = markets;
                list.innerHTML = '';
            } else {
                state.markets = [...state.markets, ...markets];
            }

            renderMarketCards(markets, state.marketsOffset === 0);

            const loadMoreBtn = document.getElementById('loadMoreBtn');
            if (loadMoreBtn) loadMoreBtn.style.display = markets.length >= 20 ? 'inline-flex' : 'none';
        } catch (error) {
            console.error('Failed to load markets:', error);
            if (state.marketsOffset === 0) {
                list.innerHTML = '<div class="empty-state"><p>Failed to load markets. Check your connection.</p></div>';
            }
            showToast('Failed to load markets', 'error');
        } finally {
            state.marketsLoading = false;
        }
    }

    function loadMoreMarkets() {
        state.marketsOffset += 20;
        loadMarkets();
    }

    function renderMarketCards(markets, clear) {
        const list = document.getElementById('marketsList');
        if (clear) list.innerHTML = '';

        markets.forEach(market => {
            const card = document.createElement('div');
            card.className = 'market-card';
            card.dataset.id = market.id;

            const outcomes = parseJsonSafe(market.outcomes, []);
            const prices = parseJsonSafe(market.outcomePrices, []);
            const volume = market.volume24hr
                ? `$${formatNumber(market.volume24hr)}`
                : (market.volume ? `$${formatNumber(market.volume)}` : '');

            const pricesHtml = outcomes.slice(0, 2).map((name, i) => {
                const pct = prices[i] ? (parseFloat(prices[i]) * 100).toFixed(0) : '?';
                const cls = name.toLowerCase() === 'yes' ? 'price-yes' : (name.toLowerCase() === 'no' ? 'price-no' : (i === 0 ? 'price-yes' : 'price-no'));
                return `<span class="price-badge ${cls}">${name} ${pct}¢</span>`;
            }).join('');

            const endStr = market.endDate ? formatDate(market.endDate) : '';

            card.innerHTML = `
                <div class="market-question">${escapeHtml(market.question)}</div>
                <div class="market-meta">
                    ${volume ? `<span>Vol: ${volume}</span>` : ''}
                    ${endStr ? `<span>Ends: ${endStr}</span>` : ''}
                </div>
                <div class="market-prices">${pricesHtml}</div>
            `;

            card.addEventListener('click', () => selectMarket(market));
            list.appendChild(card);
        });
    }

    function filterMarkets(query) {
        const q = query.toLowerCase().trim();
        document.querySelectorAll('.market-card').forEach(card => {
            card.style.display = !q || card.textContent.toLowerCase().includes(q) ? '' : 'none';
        });
    }

    // ── Market Selection ───────────────────────────────────
    function selectMarket(market) {
        state.selectedMarket = market;
        state.analysis = null;
        state.tradeSide = null;
        state.liveContext = null;

        document.querySelectorAll('.market-card').forEach(c => c.classList.remove('selected'));
        const card = document.querySelector(`.market-card[data-id="${market.id}"]`);
        if (card) card.classList.add('selected');

        renderMarketDetail(market);
        renderTradingForm(market);
        resetAnalysis();

        document.getElementById('analyzeBtn').disabled = false;

        // Start polling live prices for this market
        const tokens = parseJsonSafe(market.clobTokenIds, []);
        startPricePolling(tokens.filter(Boolean));

        // Fetch live context (order book + price history) for the detail panel
        if (tokens[0]) fetchAndShowLiveContext(tokens[0]);
    }

    async function fetchAndShowLiveContext(tokenId) {
        try {
            const resp = await fetch(`/api/market-context?tokenId=${tokenId}`);
            if (!resp.ok) return;
            state.liveContext = await resp.json();
            renderLiveContextPanel();
        } catch { /* silent */ }
    }

    function renderLiveContextPanel() {
        const ctx = state.liveContext;
        if (!ctx) return;

        const container = document.getElementById('liveContextSection');
        if (!container) return;

        let html = '';

        // Order book summary
        const ob = ctx.orderBook;
        if (ob) {
            const depthLabel = ob.depthRatio > 1.5 ? 'Buying pressure' : ob.depthRatio < 0.67 ? 'Selling pressure' : 'Balanced';
            html += `
                <div class="live-section">
                    <div class="live-section-title">Order Book</div>
                    <div class="live-stats-row">
                        <div class="live-stat">
                            <span class="live-stat-label">Bid</span>
                            <span class="live-stat-value price-yes">${ob.bestBid ? (ob.bestBid * 100).toFixed(1) + '¢' : '—'}</span>
                        </div>
                        <div class="live-stat">
                            <span class="live-stat-label">Ask</span>
                            <span class="live-stat-value price-no">${ob.bestAsk ? (ob.bestAsk * 100).toFixed(1) + '¢' : '—'}</span>
                        </div>
                        <div class="live-stat">
                            <span class="live-stat-label">Spread</span>
                            <span class="live-stat-value">${ob.spreadPct != null ? ob.spreadPct.toFixed(1) + '%' : '—'}</span>
                        </div>
                        <div class="live-stat">
                            <span class="live-stat-label">Flow</span>
                            <span class="live-stat-value">${depthLabel}</span>
                        </div>
                    </div>
                </div>
            `;
        }

        // Price history
        const ph = ctx.priceHistory;
        if (ph) {
            const changeColor = ph.change24h >= 0 ? 'var(--green)' : 'var(--red)';
            const changeSign = ph.change24h >= 0 ? '+' : '';
            const volLabel = ph.volatility24h < 0.02 ? 'Low' : ph.volatility24h < 0.05 ? 'Moderate' : 'High';

            html += `
                <div class="live-section">
                    <div class="live-section-title">24h Price Action</div>
                    <div class="live-stats-row">
                        <div class="live-stat">
                            <span class="live-stat-label">24h Change</span>
                            <span class="live-stat-value" style="color:${changeColor}">${changeSign}${(ph.change24h * 100).toFixed(1)}¢</span>
                        </div>
                        <div class="live-stat">
                            <span class="live-stat-label">High</span>
                            <span class="live-stat-value">${(ph.high24h * 100).toFixed(1)}¢</span>
                        </div>
                        <div class="live-stat">
                            <span class="live-stat-label">Low</span>
                            <span class="live-stat-value">${(ph.low24h * 100).toFixed(1)}¢</span>
                        </div>
                        <div class="live-stat">
                            <span class="live-stat-label">Momentum</span>
                            <span class="live-stat-value">${ph.momentum === 'rising' ? 'Rising' : ph.momentum === 'falling' ? 'Falling' : 'Flat'}</span>
                        </div>
                    </div>
                </div>
            `;

            // Mini sparkline chart using canvas
            if (ph.candles24h && ph.candles24h.length > 2) {
                html += `<canvas id="priceChart" class="price-chart" height="80"></canvas>`;
            }
        }

        container.innerHTML = html;

        // Draw sparkline
        if (ph?.candles24h?.length > 2) {
            requestAnimationFrame(() => drawSparkline('priceChart', ph.candles24h));
        }
    }

    function drawSparkline(canvasId, candles) {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);

        const w = rect.width;
        const h = rect.height;
        const prices = candles.map(c => c.p);
        const min = Math.min(...prices);
        const max = Math.max(...prices);
        const range = max - min || 0.01;
        const pad = 4;

        // Determine color: green if up, red if down
        const isUp = prices[prices.length - 1] >= prices[0];
        const color = isUp ? '#22c55e' : '#ef4444';
        const bgColor = isUp ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)';

        // Draw filled area
        ctx.beginPath();
        prices.forEach((p, i) => {
            const x = (i / (prices.length - 1)) * w;
            const y = h - pad - ((p - min) / range) * (h - pad * 2);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.lineTo(w, h);
        ctx.lineTo(0, h);
        ctx.closePath();
        ctx.fillStyle = bgColor;
        ctx.fill();

        // Draw line
        ctx.beginPath();
        prices.forEach((p, i) => {
            const x = (i / (prices.length - 1)) * w;
            const y = h - pad - ((p - min) / range) * (h - pad * 2);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }

    function renderMarketDetail(market) {
        const panel = document.getElementById('marketDetail');
        const outcomes = parseJsonSafe(market.outcomes, []);
        const prices = parseJsonSafe(market.outcomePrices, []);

        const outcomesHtml = outcomes.map((name, i) => {
            const price = prices[i] ? parseFloat(prices[i]) : 0;
            const pct = (price * 100).toFixed(1);
            const color = name.toLowerCase() === 'yes' ? 'var(--green)' :
                          name.toLowerCase() === 'no' ? 'var(--red)' :
                          (i === 0 ? 'var(--green)' : 'var(--red)');
            return `
                <div class="outcome-row">
                    <span class="outcome-name">${escapeHtml(name)}</span>
                    <span class="outcome-price" style="color: ${color}">${pct}%</span>
                </div>
            `;
        }).join('');

        panel.innerHTML = `
            <div class="market-detail-content">
                <div class="detail-header-row">
                    <div class="detail-title">${escapeHtml(market.question)}</div>
                    <span class="live-indicator" id="liveIndicator">LIVE</span>
                </div>
                ${market.description ? `<div class="detail-description">${escapeHtml(truncate(market.description, 300))}</div>` : ''}
                <div class="detail-stats">
                    <div class="detail-stat">
                        <div class="detail-stat-label">Volume</div>
                        <div class="detail-stat-value">$${formatNumber(market.volume || 0)}</div>
                    </div>
                    <div class="detail-stat">
                        <div class="detail-stat-label">Liquidity</div>
                        <div class="detail-stat-value">$${formatNumber(market.liquidity || 0)}</div>
                    </div>
                    <div class="detail-stat">
                        <div class="detail-stat-label">24h Volume</div>
                        <div class="detail-stat-value">$${formatNumber(market.volume24hr || 0)}</div>
                    </div>
                    <div class="detail-stat">
                        <div class="detail-stat-label">End Date</div>
                        <div class="detail-stat-value">${market.endDate ? formatDate(market.endDate) : '—'}</div>
                    </div>
                </div>
                <div class="detail-outcomes">${outcomesHtml}</div>
                <div id="liveContextSection" class="live-context-section"></div>
            </div>
        `;
    }

    // ── Claude Analysis ────────────────────────────────────
    function resetAnalysis() {
        document.getElementById('analysisContent').innerHTML =
            '<div class="empty-state small"><p>Click "Analyze Market" for Claude\'s trading recommendation</p></div>';
    }

    async function analyzeMarket() {
        const market = state.selectedMarket;
        if (!market) return;

        const content = document.getElementById('analysisContent');
        const analyzeBtn = document.getElementById('analyzeBtn');

        content.innerHTML = '<div class="analysis-loading"><span class="loading-spinner"></span> Claude is analyzing with live market data...</div>';
        analyzeBtn.disabled = true;

        try {
            const headers = { 'Content-Type': 'application/json' };
            if (state.settings.anthropicKey) headers['X-Anthropic-Key'] = state.settings.anthropicKey;

            const resp = await fetch('/api/analyze', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    market,
                    riskLevel: state.settings.riskLevel || DEFAULTS.riskLevel,
                }),
            });

            if (!resp.ok) {
                const err = await resp.json();
                throw new Error(err.error || 'Analysis failed');
            }

            const data = await resp.json();
            state.analysis = data;
            renderAnalysis(data);

            if (state.settings.autoTrade && data.recommendation?.action !== 'HOLD') {
                autoExecuteTrade(data.recommendation);
            }
        } catch (error) {
            console.error('Analysis error:', error);
            content.innerHTML = `<div class="empty-state small"><p style="color: var(--red);">${escapeHtml(error.message)}</p></div>`;
            showToast('Analysis failed: ' + error.message, 'error');
        } finally {
            analyzeBtn.disabled = false;
        }
    }

    function renderAnalysis(data) {
        const content = document.getElementById('analysisContent');
        const rec = data.recommendation || {};

        let html = data.analysis
            .replace(/^### (.+)$/gm, '<h3>$1</h3>')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/^\- (.+)$/gm, '<li>$1</li>')
            .replace(/(<li>.+<\/li>(\n)?)+/g, '<ul>$&</ul>')
            .replace(/\n\n/g, '</p><p>')
            .replace(/\n/g, '<br>');

        let recClass = 'hold';
        if (rec.action?.includes('YES')) recClass = 'buy-yes';
        else if (rec.action?.includes('NO')) recClass = 'buy-no';

        const recHtml = `
            <div class="recommendation-box ${recClass}">
                <div class="recommendation-label">Recommendation</div>
                <div class="recommendation-action">${escapeHtml(rec.action || 'HOLD')}</div>
                <div class="recommendation-confidence">Confidence: ${escapeHtml(rec.confidence || 'N/A')} | Size: ${escapeHtml(rec.suggestedSize || 'N/A')}</div>
                ${rec.reasoning ? `<div style="margin-top:8px;font-size:13px;color:var(--text-secondary)">${escapeHtml(rec.reasoning)}</div>` : ''}
            </div>
        `;

        content.innerHTML = `<div class="analysis-result"><p>${html}</p>${recHtml}</div>`;

        if (rec.action?.includes('YES')) setTradeSide('yes');
        else if (rec.action?.includes('NO')) setTradeSide('no');
    }

    // ── Trading ────────────────────────────────────────────
    function renderTradingForm(market) {
        const container = document.getElementById('tradingContent');
        const outcomes = parseJsonSafe(market.outcomes, []);
        const prices = parseJsonSafe(market.outcomePrices, []);
        const maxSize = state.settings.maxPositionSize || DEFAULTS.maxPositionSize;

        const yesPrice = prices[0] ? parseFloat(prices[0]) : 0.5;
        const noPrice = prices[1] ? parseFloat(prices[1]) : 0.5;

        container.innerHTML = `
            <div class="trade-form">
                <div class="trade-side-buttons">
                    <button class="side-btn" id="sideYes" onclick="window._setTradeSide('yes')">
                        Buy ${escapeHtml(outcomes[0] || 'Yes')} — ${(yesPrice * 100).toFixed(0)}¢
                    </button>
                    <button class="side-btn" id="sideNo" onclick="window._setTradeSide('no')">
                        Buy ${escapeHtml(outcomes[1] || 'No')} — ${(noPrice * 100).toFixed(0)}¢
                    </button>
                </div>
                <div class="trade-input-group">
                    <label>Amount (USDC)</label>
                    <div class="trade-input-row">
                        <input type="number" id="tradeAmount" class="trade-input" value="10" min="1" max="${maxSize}" step="1">
                        <span class="trade-suffix">USDC</span>
                    </div>
                </div>
                <div class="trade-summary" id="tradeSummary">
                    <div class="trade-summary-row"><span>Select a side to see trade details</span></div>
                </div>
                <button class="trade-submit" id="tradeSubmit" disabled onclick="window._executeTrade()">
                    Select a side to trade
                </button>
            </div>
        `;

        document.getElementById('tradeAmount')?.addEventListener('input', updateTradeSummary);
    }

    window._setTradeSide = setTradeSide;
    window._executeTrade = executeTrade;

    function setTradeSide(side) {
        state.tradeSide = side;
        const yesBtn = document.getElementById('sideYes');
        const noBtn = document.getElementById('sideNo');
        if (yesBtn) yesBtn.className = side === 'yes' ? 'side-btn active-yes' : 'side-btn';
        if (noBtn) noBtn.className = side === 'no' ? 'side-btn active-no' : 'side-btn';
        updateTradeSummary();

        const submitBtn = document.getElementById('tradeSubmit');
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.className = side === 'yes' ? 'trade-submit buy-yes' : 'trade-submit buy-no';
            submitBtn.textContent = side === 'yes' ? 'Buy Yes' : 'Buy No';
        }
    }

    function updateTradeSummary() {
        const summary = document.getElementById('tradeSummary');
        if (!summary || !state.selectedMarket || !state.tradeSide) return;

        const prices = parseJsonSafe(state.selectedMarket.outcomePrices, []);
        const tokens = parseJsonSafe(state.selectedMarket.clobTokenIds, []);
        const priceIdx = state.tradeSide === 'yes' ? 0 : 1;
        const tokenId = tokens[priceIdx];

        // Use live price if available
        let price = prices[priceIdx] ? parseFloat(prices[priceIdx]) : 0.5;
        const livePrice = tokenId ? state.livePrices[tokenId] : null;
        if (livePrice) price = livePrice.mid;

        const amount = parseFloat(document.getElementById('tradeAmount')?.value) || 0;
        const shares = amount / price;
        const potentialPayout = shares;
        const potentialProfit = potentialPayout - amount;

        summary.innerHTML = `
            <div class="trade-summary-row">
                <span>Price ${livePrice ? '<span class="live-badge">LIVE</span>' : ''}</span>
                <span class="value">${(price * 100).toFixed(1)}¢</span>
            </div>
            <div class="trade-summary-row">
                <span>Shares</span>
                <span class="value">${shares.toFixed(2)}</span>
            </div>
            <div class="trade-summary-row">
                <span>Cost</span>
                <span class="value">$${amount.toFixed(2)}</span>
            </div>
            <div class="trade-summary-row">
                <span>Potential payout (if correct)</span>
                <span class="value" style="color: var(--green)">$${potentialPayout.toFixed(2)}</span>
            </div>
            <div class="trade-summary-row">
                <span>Potential profit</span>
                <span class="value" style="color: var(--green)">+$${potentialProfit.toFixed(2)}</span>
            </div>
        `;
    }

    async function executeTrade() {
        const market = state.selectedMarket;
        if (!market || !state.tradeSide) return;

        const amount = parseFloat(document.getElementById('tradeAmount')?.value);
        const maxSize = state.settings.maxPositionSize || DEFAULTS.maxPositionSize;

        if (!amount || amount <= 0) { showToast('Enter a valid amount', 'error'); return; }
        if (amount > maxSize) { showToast(`Amount exceeds max position size ($${maxSize})`, 'error'); return; }

        const prices = parseJsonSafe(market.outcomePrices, []);
        const tokens = parseJsonSafe(market.clobTokenIds, []);
        const priceIdx = state.tradeSide === 'yes' ? 0 : 1;
        const tokenId = tokens[priceIdx] || market.id;
        const price = prices[priceIdx] ? parseFloat(prices[priceIdx]) : 0.5;

        const submitBtn = document.getElementById('tradeSubmit');
        submitBtn.disabled = true;
        submitBtn.textContent = 'Executing...';

        try {
            const headers = { 'Content-Type': 'application/json' };
            if (state.settings.polyApiKey) headers['X-Poly-Api-Key'] = state.settings.polyApiKey;
            if (state.settings.polySecret) headers['X-Poly-Secret'] = state.settings.polySecret;
            if (state.settings.polyPassphrase) headers['X-Poly-Passphrase'] = state.settings.polyPassphrase;
            if (state.settings.polyPrivateKey) headers['X-Poly-Private-Key'] = state.settings.polyPrivateKey;

            const resp = await fetch('/api/trade', {
                method: 'POST',
                headers,
                body: JSON.stringify({ tokenId, side: 'BUY', amount, price }),
            });

            const data = await resp.json();
            if (!resp.ok) throw new Error(data.error || 'Trade failed');

            const trade = {
                ...data.trade,
                market: market.question,
                marketId: market.id,
                outcome: state.tradeSide === 'yes' ? 'Yes' : 'No',
                entryPrice: price,
                shares: amount / price,
            };

            state.trades.unshift(trade);
            localStorage.setItem('pb_trades', JSON.stringify(state.trades));

            // Update positions
            const existingPos = state.positions.find(p => p.marketId === market.id && p.outcome === trade.outcome);
            if (existingPos) {
                existingPos.shares += trade.shares;
                existingPos.cost += amount;
                existingPos.avgPrice = existingPos.cost / existingPos.shares;
            } else {
                state.positions.unshift({
                    marketId: market.id, market: market.question, outcome: trade.outcome,
                    shares: trade.shares, cost: amount, avgPrice: price, currentPrice: price,
                    tokenId, timestamp: trade.timestamp,
                });
            }
            localStorage.setItem('pb_positions', JSON.stringify(state.positions));

            state.budget.spent += amount;
            localStorage.setItem('pb_budget', JSON.stringify(state.budget));
            updateBudgetDisplay();

            const liveTag = data.trade?.live ? '[LIVE]' : '[PAPER]';
            showToast(`${liveTag} Bought ${trade.shares.toFixed(2)} ${trade.outcome} shares for $${amount}`, 'success');
        } catch (error) {
            console.error('Trade error:', error);
            showToast('Trade failed: ' + error.message, 'error');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = state.tradeSide === 'yes' ? 'Buy Yes' : 'Buy No';
        }
    }

    function autoExecuteTrade(recommendation) {
        if (!recommendation || recommendation.action === 'HOLD') return;

        const side = recommendation.action.includes('YES') ? 'yes' : 'no';
        setTradeSide(side);

        const maxSize = state.settings.maxPositionSize || DEFAULTS.maxPositionSize;
        const sizeMap = { Small: 0.1, Medium: 0.2, Large: 0.4 };
        const fraction = sizeMap[recommendation.suggestedSize] || 0.1;
        const amount = Math.round(maxSize * fraction);

        const amountInput = document.getElementById('tradeAmount');
        if (amountInput) amountInput.value = amount;

        updateTradeSummary();
        showToast(`Auto-trade: ${recommendation.action} — $${amount}`, 'info');
        setTimeout(() => executeTrade(), 1500);
    }

    // ── Portfolio ──────────────────────────────────────────
    function renderPortfolio() {
        renderPortfolioSummary();
        renderPositions();
        renderTradeHistory();
    }

    function renderPortfolioSummary() {
        let totalInvested = 0;
        let currentValue = 0;

        state.positions.forEach(pos => {
            totalInvested += pos.cost;
            currentValue += pos.shares * (pos.currentPrice || pos.avgPrice);
        });

        const pnl = currentValue - totalInvested;
        const resolved = state.trades.filter(t => t.resolved);
        const wins = resolved.filter(t => t.profit > 0).length;
        const winRate = resolved.length > 0 ? ((wins / resolved.length) * 100).toFixed(0) + '%' : '—';

        const setVal = (id, val, cls) => {
            const el = document.getElementById(id);
            if (el) {
                el.textContent = val;
                if (cls) el.className = 'stat-value ' + cls;
            }
        };

        setVal('totalInvested', '$' + totalInvested.toFixed(2));
        setVal('currentValue', '$' + currentValue.toFixed(2));
        setVal('totalPnl', (pnl >= 0 ? '+$' : '-$') + Math.abs(pnl).toFixed(2), pnl >= 0 ? 'positive' : 'negative');
        setVal('winRate', winRate);
    }

    function renderPositions() {
        const container = document.getElementById('activePositions');
        if (!container) return;

        if (state.positions.length === 0) {
            container.innerHTML = '<div class="empty-state small"><p>No active positions.</p></div>';
            return;
        }

        let html = `
            <div class="position-row positions-header">
                <span>Market</span>
                <span>Side</span>
                <span>Shares</span>
                <span>P&L</span>
                <span></span>
            </div>
        `;

        state.positions.forEach((pos, i) => {
            const pnl = (pos.currentPrice - pos.avgPrice) * pos.shares;
            const pnlPct = pos.avgPrice > 0 ? ((pos.currentPrice - pos.avgPrice) / pos.avgPrice * 100).toFixed(1) : '0';
            const pnlStr = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2);
            const pnlClass = pnl >= 0 ? 'positive' : 'negative';
            const priceAge = pos.currentPrice !== pos.avgPrice ? ' (live)' : '';

            html += `
                <div class="position-row">
                    <span class="position-market">${escapeHtml(truncate(pos.market, 60))}</span>
                    <span class="position-side ${pos.outcome.toLowerCase()}">${pos.outcome} @ ${(pos.avgPrice * 100).toFixed(0)}¢</span>
                    <span>${pos.shares.toFixed(2)} <span class="text-muted">(now ${pos.currentPrice ? (pos.currentPrice * 100).toFixed(0) + '¢' : '—'}${priceAge})</span></span>
                    <span class="position-pnl ${pnlClass}">${pnlStr} (${pnlPct}%)</span>
                    <button class="btn btn-sm btn-secondary" onclick="window._closePosition(${i})">Close</button>
                </div>
            `;
        });

        container.innerHTML = html;
    }

    window._closePosition = function (index) {
        const pos = state.positions[index];
        if (!pos) return;
        if (!confirm(`Close position: ${pos.shares.toFixed(2)} ${pos.outcome} shares of "${truncate(pos.market, 50)}"?`)) return;

        state.positions.splice(index, 1);
        localStorage.setItem('pb_positions', JSON.stringify(state.positions));
        renderPortfolio();
        showToast('Position closed', 'info');
    };

    function renderTradeHistory() {
        const container = document.getElementById('tradeHistory');
        if (!container) return;

        if (state.trades.length === 0) {
            container.innerHTML = '<div class="empty-state small"><p>No trades yet.</p></div>';
            return;
        }

        let html = `
            <div class="history-row history-header">
                <span>Market</span>
                <span>Side</span>
                <span>Amount</span>
                <span>Price</span>
                <span>Time</span>
            </div>
        `;

        state.trades.slice(0, 50).forEach(trade => {
            const liveTag = trade.live ? '<span class="live-badge">LIVE</span>' : (trade.paper ? '<span class="paper-badge">PAPER</span>' : '');
            html += `
                <div class="history-row">
                    <span>${escapeHtml(truncate(trade.market || '', 50))} ${liveTag}</span>
                    <span class="position-side ${(trade.outcome || '').toLowerCase()}">${trade.outcome || trade.side}</span>
                    <span>$${(trade.amount || 0).toFixed(2)}</span>
                    <span>${((trade.entryPrice || 0) * 100).toFixed(1)}¢</span>
                    <span>${trade.timestamp ? formatDate(trade.timestamp) : '—'}</span>
                </div>
            `;
        });

        container.innerHTML = html;
    }

    // ── Budget ─────────────────────────────────────────────
    function updateBudgetDisplay() {
        const total = state.budget.total || state.settings.tradingBudget || DEFAULTS.tradingBudget;
        const spent = state.budget.spent || 0;
        const remaining = Math.max(total - spent, 0);
        const pct = total > 0 ? ((remaining / total) * 100) : 0;

        const bar = document.getElementById('budgetBar');
        const spentEl = document.getElementById('budgetSpent');
        const remainEl = document.getElementById('budgetRemaining');
        const totalEl = document.getElementById('budgetTotal');

        if (bar) {
            bar.style.width = pct + '%';
            bar.className = pct < 20 ? 'budget-bar low' : 'budget-bar';
        }
        if (spentEl) spentEl.textContent = '$' + spent.toFixed(0);
        if (remainEl) remainEl.textContent = '$' + remaining.toFixed(0);
        if (totalEl) totalEl.textContent = '$' + total.toFixed(0);
    }

    // ── Bot ────────────────────────────────────────────────
    async function runBot(dryRun) {
        if (state.botRunning) { showToast('Bot is already running', 'error'); return; }
        if (!state.settings.anthropicKey) { showToast('Set your Anthropic API key in Settings first', 'error'); return; }

        const total = state.budget.total || state.settings.tradingBudget || DEFAULTS.tradingBudget;
        const spent = state.budget.spent || 0;
        const remaining = total - spent;

        if (remaining < 1 && !dryRun) { showToast('Budget exhausted!', 'error'); return; }

        state.botRunning = true;
        const runBtn = document.getElementById('runBotBtn');
        const dryBtn = document.getElementById('dryRunBtn');
        const statusDot = document.getElementById('botStatusDot');
        const statusText = document.getElementById('botStatusText');
        const logEl = document.getElementById('botLog');

        if (runBtn) runBtn.disabled = true;
        if (dryBtn) dryBtn.disabled = true;
        if (statusDot) statusDot.className = 'status-dot connected';
        if (statusText) statusText.textContent = dryRun ? 'Dry run...' : 'Trading...';
        if (logEl) { logEl.style.display = 'block'; logEl.innerHTML = ''; }

        addBotLog('info', `Bot started ${dryRun ? '(DRY RUN)' : '(LIVE)'} — $${remaining.toFixed(0)} remaining`);

        try {
            const headers = { 'Content-Type': 'application/json' };
            if (state.settings.anthropicKey) headers['X-Anthropic-Key'] = state.settings.anthropicKey;
            if (state.settings.polyApiKey) headers['X-Poly-Api-Key'] = state.settings.polyApiKey;
            if (state.settings.polySecret) headers['X-Poly-Secret'] = state.settings.polySecret;
            if (state.settings.polyPassphrase) headers['X-Poly-Passphrase'] = state.settings.polyPassphrase;
            if (state.settings.polyPrivateKey) headers['X-Poly-Private-Key'] = state.settings.polyPrivateKey;

            const existingTokens = state.positions.map(p => p.tokenId).filter(Boolean);

            const resp = await fetch('/api/auto-trade', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    budget: total, spent,
                    maxPerTrade: state.settings.maxPositionSize || DEFAULTS.maxPositionSize,
                    riskLevel: state.settings.riskLevel || DEFAULTS.riskLevel,
                    marketsToScan: 10,
                    existingPositions: existingTokens,
                    dryRun,
                }),
            });

            const report = await resp.json();

            addBotLog('info', `Scanned ${report.marketsScanned} markets, analyzed ${report.marketsAnalyzed}`);

            for (const analysis of (report.analyses || [])) {
                const rec = analysis.recommendation;
                if (rec.action === 'HOLD') {
                    addBotLog('skip', `HOLD: ${truncate(analysis.market, 60)} — ${rec.reasoning || 'no edge'}`);
                } else {
                    const liveInfo = analysis.liveData ? ` [${analysis.liveData}]` : '';
                    addBotLog('info', `${rec.action}: ${truncate(analysis.market, 50)} (${rec.confidence}, ${rec.edgePercent || '?'}pt edge)${liveInfo}`);
                }
            }

            for (const trade of (report.trades || [])) {
                const tag = trade.live ? 'LIVE' : (trade.status === 'dry_run' ? 'DRY' : 'PAPER');
                addBotLog('trade', `[${tag}] ${trade.outcome} ${truncate(trade.market, 50)} — $${trade.amount} @ ${(trade.price * 100).toFixed(0)}¢`);

                state.trades.unshift(trade);

                if (!dryRun) {
                    const existing = state.positions.find(p => p.marketId === trade.marketId && p.outcome === trade.outcome);
                    if (existing) {
                        existing.shares += trade.shares;
                        existing.cost += trade.amount;
                        existing.avgPrice = existing.cost / existing.shares;
                    } else {
                        state.positions.unshift({
                            marketId: trade.marketId, market: trade.market, outcome: trade.outcome,
                            shares: trade.shares, cost: trade.amount, avgPrice: trade.price,
                            currentPrice: trade.price, tokenId: trade.tokenId, timestamp: trade.timestamp,
                        });
                    }
                }
            }

            for (const err of (report.errors || [])) {
                addBotLog('error', `Error: ${err.market ? truncate(err.market, 40) + ' — ' : ''}${err.error}`);
            }

            if (!dryRun && report.totalSpent > 0) {
                state.budget.spent += report.totalSpent;
                localStorage.setItem('pb_budget', JSON.stringify(state.budget));
                addBotLog('info', `Spent $${report.totalSpent.toFixed(2)} — $${(total - state.budget.spent).toFixed(0)} remaining`);
            }

            localStorage.setItem('pb_trades', JSON.stringify(state.trades));
            localStorage.setItem('pb_positions', JSON.stringify(state.positions));

            addBotLog('info', `Done — ${report.tradesExecuted} trades executed`);
            showToast(`Bot finished: ${report.tradesExecuted} trades`, report.tradesExecuted > 0 ? 'success' : 'info');

        } catch (error) {
            console.error('Bot error:', error);
            addBotLog('error', `Bot failed: ${error.message}`);
            showToast('Bot error: ' + error.message, 'error');
        } finally {
            state.botRunning = false;
            if (runBtn) runBtn.disabled = false;
            if (dryBtn) dryBtn.disabled = false;
            if (statusDot) statusDot.className = 'status-dot';
            if (statusText) statusText.textContent = 'Idle';
            updateBudgetDisplay();
            renderPortfolio();
        }
    }

    function addBotLog(type, message) {
        const logEl = document.getElementById('botLog');
        if (!logEl) return;
        const time = new Date().toLocaleTimeString();
        const entry = document.createElement('div');
        entry.className = `bot-log-entry ${type}`;
        entry.innerHTML = `<span class="time">${time}</span>${escapeHtml(message)}`;
        logEl.appendChild(entry);
        logEl.scrollTop = logEl.scrollHeight;
    }

    // ── Position Monitor ────────────────────────────────────
    // Continuously checks positions for stop-loss, take-profit, price spikes

    function startMonitor() {
        if (state.monitorRunning) return;

        const intervalMin = state.settings.monitorInterval ?? DEFAULTS.monitorInterval;
        if (intervalMin === 0) {
            showToast('Monitor interval set to Off — change it in Settings', 'error');
            return;
        }

        state.monitorRunning = true;
        document.getElementById('startMonitorBtn').style.display = 'none';
        document.getElementById('stopMonitorBtn').style.display = '';

        addBotLog('info', `Monitor started — checking every ${intervalMin}min (SL: ${state.settings.stopLossPct || DEFAULTS.stopLossPct}%, TP: ${state.settings.takeProfitPct || DEFAULTS.takeProfitPct}%)`);

        runMonitorCheck(); // immediate first check
        state.monitorId = setInterval(runMonitorCheck, intervalMin * 60 * 1000);

        // Also start auto re-scan if configured
        const rescanMin = state.settings.autoRescan ?? DEFAULTS.autoRescan;
        if (rescanMin > 0) {
            addBotLog('info', `Auto re-scan enabled — scanning for new trades every ${rescanMin}min`);
            state.rescanId = setInterval(() => {
                if (!state.botRunning) runBot(false);
            }, rescanMin * 60 * 1000);
        }

        showToast('Monitor started', 'success');
    }

    function stopMonitor() {
        state.monitorRunning = false;
        if (state.monitorId) { clearInterval(state.monitorId); state.monitorId = null; }
        if (state.rescanId) { clearInterval(state.rescanId); state.rescanId = null; }

        document.getElementById('startMonitorBtn').style.display = '';
        document.getElementById('stopMonitorBtn').style.display = 'none';

        addBotLog('info', 'Monitor stopped');
        showToast('Monitor stopped', 'info');
    }

    async function runMonitorCheck() {
        if (state.positions.length === 0) return;

        const alertsEl = document.getElementById('monitorAlerts');
        const logEl = document.getElementById('botLog');
        if (logEl) logEl.style.display = 'block';

        try {
            const resp = await fetch('/api/monitor', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    positions: state.positions,
                    stopLossPct: state.settings.stopLossPct || DEFAULTS.stopLossPct,
                    takeProfitPct: state.settings.takeProfitPct || DEFAULTS.takeProfitPct,
                    spikeThreshold: 15,
                }),
            });

            if (!resp.ok) return;

            const data = await resp.json();

            // Update position prices from monitor
            if (data.updatedPositions?.length > 0) {
                data.updatedPositions.forEach((updated, i) => {
                    if (state.positions[i] && updated.currentPrice != null) {
                        state.positions[i].currentPrice = updated.currentPrice;
                        if (updated.spikeAlerted) state.positions[i].spikeAlerted = true;
                    }
                });
                localStorage.setItem('pb_positions', JSON.stringify(state.positions));

                // Refresh portfolio if visible
                if (document.getElementById('portfolioView')?.classList.contains('active')) {
                    renderPortfolio();
                }
            }

            // Display alerts
            if (data.alerts?.length > 0) {
                if (alertsEl) {
                    alertsEl.style.display = 'block';
                    alertsEl.innerHTML = data.alerts.map(a => `
                        <div class="monitor-alert ${a.severity}">
                            <span class="alert-type">${a.type.replace('_', ' ').toUpperCase()}</span>
                            ${escapeHtml(a.message)}
                        </div>
                    `).join('');
                }

                data.alerts.forEach(a => {
                    const logType = a.severity === 'critical' ? 'error' : a.severity === 'positive' ? 'trade' : 'info';
                    addBotLog(logType, a.message);
                });
            }

            // Auto-execute exit actions
            if (data.actions?.length > 0) {
                for (const action of data.actions) {
                    if (action.type === 'exit') {
                        addBotLog('trade', `AUTO-EXIT: Selling ${action.outcome} position in "${truncate(action.market, 40)}" (${action.reason.replace('_', ' ')})`);
                        await executeAutoExit(action);
                    }
                }
            }

        } catch (err) {
            console.error('Monitor check failed:', err);
        }
    }

    async function executeAutoExit(action) {
        try {
            const headers = { 'Content-Type': 'application/json' };
            if (state.settings.polyApiKey) headers['X-Poly-Api-Key'] = state.settings.polyApiKey;
            if (state.settings.polySecret) headers['X-Poly-Secret'] = state.settings.polySecret;
            if (state.settings.polyPassphrase) headers['X-Poly-Passphrase'] = state.settings.polyPassphrase;
            if (state.settings.polyPrivateKey) headers['X-Poly-Private-Key'] = state.settings.polyPrivateKey;

            const resp = await fetch('/api/trade', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    tokenId: action.tokenId,
                    side: 'SELL',
                    shares: action.shares,
                    price: action.currentPrice,
                }),
            });

            const data = await resp.json();
            if (!resp.ok) {
                addBotLog('error', `Exit failed: ${data.error || 'unknown error'}`);
                return;
            }

            // Record exit trade
            const exitTrade = {
                ...data.trade,
                market: action.market,
                outcome: action.outcome,
                exitReason: action.reason,
                auto: true,
            };
            state.trades.unshift(exitTrade);
            localStorage.setItem('pb_trades', JSON.stringify(state.trades));

            // Remove position
            const posIdx = state.positions.findIndex(
                p => p.tokenId === action.tokenId && p.outcome === action.outcome
            );
            if (posIdx >= 0) {
                const pos = state.positions[posIdx];
                const pnl = (action.currentPrice - pos.avgPrice) * pos.shares;

                // Return proceeds to budget
                const proceeds = action.shares * action.currentPrice;
                state.budget.spent = Math.max(0, state.budget.spent - pos.cost);
                localStorage.setItem('pb_budget', JSON.stringify(state.budget));

                state.positions.splice(posIdx, 1);
                localStorage.setItem('pb_positions', JSON.stringify(state.positions));

                const liveTag = data.trade?.live ? '[LIVE]' : '[PAPER]';
                const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
                addBotLog('trade', `${liveTag} Sold ${action.shares.toFixed(2)} ${action.outcome} shares for $${proceeds.toFixed(2)} (P&L: ${pnlStr})`);
                showToast(`Auto-exit: ${action.reason.replace('_', ' ')} — ${pnlStr}`, pnl >= 0 ? 'success' : 'error');
            }

            updateBudgetDisplay();
            if (document.getElementById('portfolioView')?.classList.contains('active')) {
                renderPortfolio();
            }

        } catch (err) {
            addBotLog('error', `Auto-exit error: ${err.message}`);
        }
    }

    // ── Utilities ──────────────────────────────────────────
    function parseJsonSafe(val, fallback) {
        if (Array.isArray(val)) return val;
        if (typeof val === 'string') {
            try { return JSON.parse(val); } catch { return fallback; }
        }
        return fallback;
    }

    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function truncate(str, len) {
        if (!str) return '';
        return str.length > len ? str.slice(0, len) + '...' : str;
    }

    function formatNumber(num) {
        const n = parseFloat(num);
        if (isNaN(n)) return '0';
        if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
        return n.toFixed(0);
    }

    function formatDate(dateStr) {
        try {
            const d = new Date(dateStr);
            return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        } catch {
            return dateStr;
        }
    }

    function showToast(message, type = 'info') {
        const container = document.getElementById('toastContainer');
        if (!container) return;

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        container.appendChild(toast);

        requestAnimationFrame(() => toast.classList.add('show'));
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    }

    // ── Boot ───────────────────────────────────────────────
    init();
})();
