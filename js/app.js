/**
 * PredictBot — AI-Powered Prediction Market Trading
 * Frontend application for Polymarket + Claude integration
 */

(function () {
    'use strict';

    // ── State ──────────────────────────────────────────────
    const state = {
        markets: [],
        selectedMarket: null,
        analysis: null,
        tradeSide: null, // 'yes' or 'no'
        trades: JSON.parse(localStorage.getItem('pb_trades') || '[]'),
        positions: JSON.parse(localStorage.getItem('pb_positions') || '[]'),
        settings: JSON.parse(localStorage.getItem('pb_settings') || '{}'),
        budget: JSON.parse(localStorage.getItem('pb_budget') || '{"total":100,"spent":0}'),
        marketsOffset: 0,
        marketsLoading: false,
        botRunning: false,
    };

    const DEFAULTS = {
        maxPositionSize: 25,
        tradingBudget: 100,
        riskLevel: 'moderate',
        autoTrade: false,
    };

    // ── Init ───────────────────────────────────────────────
    function init() {
        setupNavigation();
        loadSettings();
        loadMarkets();
        checkApiStatus();
        updateBudgetDisplay();
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

        // Settings buttons
        const saveBtn = document.getElementById('saveSettings');
        if (saveBtn) saveBtn.addEventListener('click', saveSettings);

        const clearBtn = document.getElementById('clearData');
        if (clearBtn) clearBtn.addEventListener('click', clearAllData);

        // Analyze button
        const analyzeBtn = document.getElementById('analyzeBtn');
        if (analyzeBtn) analyzeBtn.addEventListener('click', analyzeMarket);

        // Search / filter
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

        // Load more
        const loadMoreBtn = document.getElementById('loadMoreBtn');
        if (loadMoreBtn) loadMoreBtn.addEventListener('click', loadMoreMarkets);

        // Bot controls
        const runBotBtn = document.getElementById('runBotBtn');
        if (runBotBtn) runBotBtn.addEventListener('click', () => runBot(false));

        const dryRunBtn = document.getElementById('dryRunBtn');
        if (dryRunBtn) dryRunBtn.addEventListener('click', () => runBot(true));
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
        };
        localStorage.setItem('pb_settings', JSON.stringify(state.settings));

        // Update budget if changed
        if (newBudget !== oldBudget) {
            state.budget.total = newBudget;
            localStorage.setItem('pb_budget', JSON.stringify(state.budget));
            updateBudgetDisplay();
        }

        showToast('Settings saved', 'success');
        checkApiStatus();
    }

    function clearAllData() {
        if (!confirm('This will clear all trades, positions, and settings. Continue?')) return;
        localStorage.removeItem('pb_trades');
        localStorage.removeItem('pb_positions');
        localStorage.removeItem('pb_settings');
        state.trades = [];
        state.positions = [];
        state.settings = {};
        loadSettings();
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
            const orderMap = {
                volume: 'volume24hr',
                newest: 'startDate',
                ending: 'endDate',
                liquidity: 'liquidity',
            };
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
            if (loadMoreBtn) {
                loadMoreBtn.style.display = markets.length >= 20 ? 'inline-flex' : 'none';
            }
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
        const cards = document.querySelectorAll('.market-card');
        cards.forEach(card => {
            const text = card.textContent.toLowerCase();
            card.style.display = !q || text.includes(q) ? '' : 'none';
        });
    }

    // ── Market Selection ───────────────────────────────────
    function selectMarket(market) {
        state.selectedMarket = market;
        state.analysis = null;
        state.tradeSide = null;

        // Highlight selected card
        document.querySelectorAll('.market-card').forEach(c => c.classList.remove('selected'));
        const card = document.querySelector(`.market-card[data-id="${market.id}"]`);
        if (card) card.classList.add('selected');

        renderMarketDetail(market);
        renderTradingForm(market);
        resetAnalysis();

        // Enable analyze button
        const analyzeBtn = document.getElementById('analyzeBtn');
        if (analyzeBtn) analyzeBtn.disabled = false;
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
                <div class="detail-title">${escapeHtml(market.question)}</div>
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
            </div>
        `;
    }

    // ── Claude Analysis ────────────────────────────────────
    function resetAnalysis() {
        const content = document.getElementById('analysisContent');
        content.innerHTML = '<div class="empty-state small"><p>Click "Analyze Market" for Claude\'s trading recommendation</p></div>';
    }

    async function analyzeMarket() {
        const market = state.selectedMarket;
        if (!market) return;

        const content = document.getElementById('analysisContent');
        const analyzeBtn = document.getElementById('analyzeBtn');

        content.innerHTML = '<div class="analysis-loading"><span class="loading-spinner"></span> Claude is analyzing this market...</div>';
        analyzeBtn.disabled = true;

        try {
            const headers = { 'Content-Type': 'application/json' };
            if (state.settings.anthropicKey) {
                headers['X-Anthropic-Key'] = state.settings.anthropicKey;
            }

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

            // Auto-trade if enabled
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

        // Convert markdown to HTML
        let html = data.analysis
            .replace(/^### (.+)$/gm, '<h3>$1</h3>')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/^\- (.+)$/gm, '<li>$1</li>')
            .replace(/(<li>.+<\/li>(\n)?)+/g, '<ul>$&</ul>')
            .replace(/\n\n/g, '</p><p>')
            .replace(/\n/g, '<br>');

        // Recommendation box
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

        // Pre-select trade side based on recommendation
        if (rec.action?.includes('YES')) {
            setTradeSide('yes');
        } else if (rec.action?.includes('NO')) {
            setTradeSide('no');
        }
    }

    // ── Trading ────────────────────────────────────────────
    function renderTradingForm(market) {
        const container = document.getElementById('tradingContent');
        const outcomes = parseJsonSafe(market.outcomes, []);
        const prices = parseJsonSafe(market.outcomePrices, []);
        const tokens = parseJsonSafe(market.clobTokenIds, []);

        const yesPrice = prices[0] ? parseFloat(prices[0]) : 0.5;
        const noPrice = prices[1] ? parseFloat(prices[1]) : 0.5;
        const maxSize = state.settings.maxPositionSize || DEFAULTS.maxPositionSize;

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
                    <div class="trade-summary-row">
                        <span>Select a side to see trade details</span>
                    </div>
                </div>

                <button class="trade-submit" id="tradeSubmit" disabled onclick="window._executeTrade()">
                    Select a side to trade
                </button>
            </div>
        `;

        // Update summary on amount change
        const amountInput = document.getElementById('tradeAmount');
        if (amountInput) {
            amountInput.addEventListener('input', updateTradeSummary);
        }
    }

    // Expose to global scope for onclick handlers
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
        const priceIdx = state.tradeSide === 'yes' ? 0 : 1;
        const price = prices[priceIdx] ? parseFloat(prices[priceIdx]) : 0.5;
        const amount = parseFloat(document.getElementById('tradeAmount')?.value) || 0;
        const shares = amount / price;
        const potentialPayout = shares;
        const potentialProfit = potentialPayout - amount;

        summary.innerHTML = `
            <div class="trade-summary-row">
                <span>Price</span>
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

        if (!amount || amount <= 0) {
            showToast('Enter a valid amount', 'error');
            return;
        }

        if (amount > maxSize) {
            showToast(`Amount exceeds max position size ($${maxSize})`, 'error');
            return;
        }

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
                body: JSON.stringify({
                    tokenId,
                    side: 'BUY',
                    amount,
                    price,
                }),
            });

            const data = await resp.json();
            if (!resp.ok) throw new Error(data.error || 'Trade failed');

            // Record the trade
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

            // Add position
            const existingPos = state.positions.find(
                p => p.marketId === market.id && p.outcome === trade.outcome
            );
            if (existingPos) {
                existingPos.shares += trade.shares;
                existingPos.cost += amount;
                existingPos.avgPrice = existingPos.cost / existingPos.shares;
            } else {
                state.positions.unshift({
                    marketId: market.id,
                    market: market.question,
                    outcome: trade.outcome,
                    shares: trade.shares,
                    cost: amount,
                    avgPrice: price,
                    currentPrice: price,
                    timestamp: trade.timestamp,
                });
            }
            localStorage.setItem('pb_positions', JSON.stringify(state.positions));

            // Update budget
            state.budget.spent += amount;
            localStorage.setItem('pb_budget', JSON.stringify(state.budget));
            updateBudgetDisplay();

            const liveTag = data.trade?.live ? '[LIVE]' : '[PAPER]';
            showToast(`${liveTag} Bought ${trade.shares.toFixed(2)} ${trade.outcome} shares for $${amount}`, 'success');

        } catch (error) {
            console.error('Trade error:', error);
            showToast('Trade failed: ' + error.message, 'error');
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = state.tradeSide === 'yes' ? 'Buy Yes' : 'Buy No';
            }
        }
    }

    function autoExecuteTrade(recommendation) {
        if (!recommendation || recommendation.action === 'HOLD') return;

        const side = recommendation.action.includes('YES') ? 'yes' : 'no';
        setTradeSide(side);

        // Calculate amount based on suggested size
        const maxSize = state.settings.maxPositionSize || DEFAULTS.maxPositionSize;
        const sizeMap = { Small: 0.1, Medium: 0.2, Large: 0.4 };
        const fraction = sizeMap[recommendation.suggestedSize] || 0.1;
        const amount = Math.round(maxSize * fraction);

        const amountInput = document.getElementById('tradeAmount');
        if (amountInput) amountInput.value = amount;

        updateTradeSummary();
        showToast(`Auto-trade: ${recommendation.action} — $${amount}`, 'info');

        // Execute after a short delay so user can see what's happening
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
            const pnlStr = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2);
            const pnlClass = pnl >= 0 ? 'positive' : 'negative';

            html += `
                <div class="position-row">
                    <span class="position-market">${escapeHtml(truncate(pos.market, 60))}</span>
                    <span class="position-side ${pos.outcome.toLowerCase()}">${pos.outcome}</span>
                    <span>${pos.shares.toFixed(2)}</span>
                    <span class="position-pnl ${pnlClass}">${pnlStr}</span>
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
            html += `
                <div class="history-row">
                    <span>${escapeHtml(truncate(trade.market || '', 50))}</span>
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
        if (state.botRunning) {
            showToast('Bot is already running', 'error');
            return;
        }

        if (!state.settings.anthropicKey) {
            showToast('Set your Anthropic API key in Settings first', 'error');
            return;
        }

        const total = state.budget.total || state.settings.tradingBudget || DEFAULTS.tradingBudget;
        const spent = state.budget.spent || 0;
        const remaining = total - spent;

        if (remaining < 1 && !dryRun) {
            showToast('Budget exhausted! Increase your budget in Settings.', 'error');
            return;
        }

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
        if (logEl) {
            logEl.style.display = 'block';
            logEl.innerHTML = '';
        }

        addBotLog('info', `Bot started ${dryRun ? '(DRY RUN)' : '(LIVE)'} — budget $${remaining.toFixed(0)} remaining`);

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
                    budget: total,
                    spent,
                    maxPerTrade: state.settings.maxPositionSize || DEFAULTS.maxPositionSize,
                    riskLevel: state.settings.riskLevel || DEFAULTS.riskLevel,
                    marketsToScan: 10,
                    existingPositions: existingTokens,
                    dryRun,
                }),
            });

            const report = await resp.json();

            // Log results
            addBotLog('info', `Scanned ${report.marketsScanned} markets, analyzed ${report.marketsAnalyzed}`);

            for (const analysis of (report.analyses || [])) {
                const rec = analysis.recommendation;
                if (rec.action === 'HOLD') {
                    addBotLog('skip', `HOLD: ${truncate(analysis.market, 60)} — ${rec.reasoning || 'no edge'}`);
                } else {
                    addBotLog('info', `${rec.action}: ${truncate(analysis.market, 60)} (${rec.confidence} conf, ${rec.edgePercent || '?'}pt edge)`);
                }
            }

            for (const trade of (report.trades || [])) {
                const tag = trade.live ? 'LIVE' : (trade.status === 'dry_run' ? 'DRY' : 'PAPER');
                addBotLog('trade', `[${tag}] ${trade.outcome} ${truncate(trade.market, 50)} — $${trade.amount} @ ${(trade.price * 100).toFixed(0)}¢`);

                // Record trade in local state
                state.trades.unshift(trade);

                // Update positions
                if (!dryRun) {
                    const existing = state.positions.find(
                        p => p.marketId === trade.marketId && p.outcome === trade.outcome
                    );
                    if (existing) {
                        existing.shares += trade.shares;
                        existing.cost += trade.amount;
                        existing.avgPrice = existing.cost / existing.shares;
                    } else {
                        state.positions.unshift({
                            marketId: trade.marketId,
                            market: trade.market,
                            outcome: trade.outcome,
                            shares: trade.shares,
                            cost: trade.amount,
                            avgPrice: trade.price,
                            currentPrice: trade.price,
                            tokenId: trade.tokenId,
                            timestamp: trade.timestamp,
                        });
                    }
                }
            }

            for (const err of (report.errors || [])) {
                addBotLog('error', `Error: ${err.market ? truncate(err.market, 40) + ' — ' : ''}${err.error}`);
            }

            // Update budget
            if (!dryRun && report.totalSpent > 0) {
                state.budget.spent += report.totalSpent;
                localStorage.setItem('pb_budget', JSON.stringify(state.budget));
                addBotLog('info', `Spent $${report.totalSpent.toFixed(2)} this run — $${(total - state.budget.spent).toFixed(0)} remaining`);
            }

            // Save
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

    // ── Utilities ──────────────────────────────────────────
    function parseJsonSafe(val, fallback) {
        if (Array.isArray(val)) return val;
        if (typeof val === 'string') {
            try { return JSON.parse(val); }
            catch { return fallback; }
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
