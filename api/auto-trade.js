// Vercel Serverless Function — Autonomous Trading Loop
//
// Called via Vercel Cron or manually from the frontend.
// 1. Fetches top markets from Gamma API
// 2. Filters for tradeable opportunities (good liquidity, not already positioned)
// 3. Sends each to Claude for analysis
// 4. Executes trades on recommendations that meet confidence thresholds
// 5. Tracks budget and returns a full report

import { buildMarketOrder, signOrder, submitOrder, getMidpoint } from './lib/clob.js';

export const config = {
    maxDuration: 60, // Allow up to 60s for the full loop
};

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Anthropic-Key, X-Poly-Api-Key, X-Poly-Secret, X-Poly-Passphrase, X-Poly-Private-Key');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const {
        budget = 100,           // Total USDC budget
        spent = 0,              // Already spent
        maxPerTrade = 25,       // Max per single trade
        riskLevel = 'moderate',
        marketsToScan = 10,     // How many markets to analyze
        existingPositions = [], // Token IDs we already hold
        dryRun = false,         // If true, analyze but don't execute
    } = req.body;

    const anthropicKey = req.headers['x-anthropic-key'] || process.env.ANTHROPIC_API_KEY;
    const polyApiKey = req.headers['x-poly-api-key'] || process.env.POLYMARKET_API_KEY;
    const polySecret = req.headers['x-poly-secret'] || process.env.POLYMARKET_API_SECRET;
    const polyPassphrase = req.headers['x-poly-passphrase'] || process.env.POLYMARKET_PASSPHRASE;
    const polyPrivateKey = req.headers['x-poly-private-key'] || process.env.POLYMARKET_PRIVATE_KEY;

    if (!anthropicKey) {
        return res.status(400).json({ error: 'Anthropic API key required for autonomous trading' });
    }

    const remaining = budget - spent;
    if (remaining < 1) {
        return res.status(200).json({
            message: 'Budget exhausted',
            budget, spent, remaining: 0,
            trades: [],
        });
    }

    const hasLiveCreds = !!(polyApiKey && polySecret && polyPassphrase && polyPrivateKey);
    const report = {
        startedAt: new Date().toISOString(),
        budget,
        spent,
        remaining,
        marketsScanned: 0,
        marketsAnalyzed: 0,
        tradesExecuted: 0,
        totalSpent: 0,
        trades: [],
        analyses: [],
        errors: [],
        live: hasLiveCreds && !dryRun,
    };

    try {
        // Step 1: Fetch top markets
        const markets = await fetchTopMarkets(marketsToScan);
        report.marketsScanned = markets.length;

        // Step 2: Filter — skip markets we already have positions in, low liquidity, etc.
        const candidates = markets.filter(m => {
            const tokens = parseJsonSafe(m.clobTokenIds, []);
            const hasPosition = tokens.some(t => existingPositions.includes(t));
            const liquidity = parseFloat(m.liquidity || 0);
            return !hasPosition && liquidity >= 5000; // min $5k liquidity
        });

        // Step 3: Analyze each candidate with Claude (max 5 per run to control costs)
        const toAnalyze = candidates.slice(0, Math.min(5, candidates.length));
        let budgetLeft = remaining;

        for (const market of toAnalyze) {
            if (budgetLeft < 1) break;

            try {
                const analysis = await analyzeWithClaude(market, anthropicKey, riskLevel, budgetLeft, maxPerTrade);
                report.marketsAnalyzed++;
                report.analyses.push({
                    market: market.question,
                    marketId: market.id,
                    recommendation: analysis.recommendation,
                });

                // Step 4: Execute if recommendation is actionable and meets thresholds
                const rec = analysis.recommendation;
                if (shouldExecute(rec, riskLevel)) {
                    const tradeAmount = calculateTradeSize(rec, budgetLeft, maxPerTrade);

                    if (tradeAmount >= 1) {
                        const tokens = parseJsonSafe(market.clobTokenIds, []);
                        const prices = parseJsonSafe(market.outcomePrices, []);
                        const isYes = rec.action.includes('YES');
                        const tokenIdx = isYes ? 0 : 1;
                        const tokenId = tokens[tokenIdx] || '';
                        const price = prices[tokenIdx] ? parseFloat(prices[tokenIdx]) : 0.5;

                        const trade = await executeTrade({
                            tokenId,
                            side: 'BUY',
                            amount: tradeAmount,
                            price,
                            negRisk: market.negRisk || false,
                            market,
                            outcome: isYes ? 'Yes' : 'No',
                            hasLiveCreds,
                            dryRun,
                            polyApiKey,
                            polySecret,
                            polyPassphrase,
                            polyPrivateKey,
                        });

                        report.trades.push(trade);
                        report.tradesExecuted++;
                        report.totalSpent += tradeAmount;
                        budgetLeft -= tradeAmount;
                    }
                }
            } catch (err) {
                report.errors.push({
                    market: market.question,
                    error: err.message,
                });
            }
        }

        report.remaining = budgetLeft;
        report.completedAt = new Date().toISOString();

        return res.status(200).json(report);

    } catch (error) {
        console.error('Auto-trade loop error:', error);
        report.errors.push({ error: error.message });
        return res.status(500).json(report);
    }
}

async function fetchTopMarkets(limit) {
    const resp = await fetch(
        `https://gamma-api.polymarket.com/markets?limit=${limit}&active=true&closed=false&order=volume24hr&ascending=false`
    );
    if (!resp.ok) throw new Error(`Gamma API error: ${resp.status}`);
    return resp.json();
}

async function analyzeWithClaude(market, apiKey, riskLevel, budgetLeft, maxPerTrade) {
    const outcomePrices = parseJsonSafe(market.outcomePrices, []);
    const outcomes = parseJsonSafe(market.outcomes, []);

    const outcomeSummary = outcomes.map((name, i) => {
        const price = outcomePrices[i] ? (parseFloat(outcomePrices[i]) * 100).toFixed(1) : '?';
        return `  - ${name}: ${price}%`;
    }).join('\n');

    const riskMap = {
        conservative: 'Only trade with >75% confidence and >10pt edge. Small positions only.',
        moderate: 'Trade with moderate-high confidence and >5pt edge.',
        aggressive: 'Trade with moderate confidence and >3pt edge. Larger positions OK.',
    };

    const prompt = `You are an autonomous prediction market trading bot managing a $${budgetLeft.toFixed(0)} remaining budget (max $${maxPerTrade} per trade). Analyze this market and decide whether to trade.

## Market
**Question:** ${market.question}
**Description:** ${market.description || 'N/A'}
**End Date:** ${market.endDate || 'Unknown'}
**Volume:** $${formatNum(market.volume)} | **Liquidity:** $${formatNum(market.liquidity)}

## Prices
${outcomeSummary}

## Rules
${riskMap[riskLevel] || riskMap.moderate}
- You MUST be selective. Only trade when you see genuine mispricing.
- Consider: Is the market pricing this correctly? What does the market NOT know?
- Think about base rates, recent news, and structural factors.

## Response (JSON only)
Respond with ONLY a JSON object, no markdown:
{
  "action": "BUY YES" | "BUY NO" | "HOLD",
  "confidence": "Low" | "Medium" | "High",
  "edgePercent": <number — your estimated edge in percentage points>,
  "reasoning": "<1-2 sentences>",
  "suggestedSize": "Small" | "Medium" | "Large",
  "myProbability": <number 0-100 — your estimated YES probability>
}`;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 500,
            messages: [{ role: 'user', content: prompt }],
        }),
    });

    if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`Claude API error: ${resp.status} - ${err}`);
    }

    const data = await resp.json();
    const text = data.content?.[0]?.text || '{}';

    // Parse JSON from response — handle markdown code blocks
    let recommendation;
    try {
        const jsonStr = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
        recommendation = JSON.parse(jsonStr);
    } catch {
        recommendation = { action: 'HOLD', confidence: 'Low', reasoning: 'Failed to parse response', edgePercent: 0 };
    }

    return { recommendation, usage: data.usage };
}

function shouldExecute(rec, riskLevel) {
    if (!rec || rec.action === 'HOLD') return false;

    const edge = Math.abs(rec.edgePercent || 0);
    const conf = (rec.confidence || '').toLowerCase();

    if (riskLevel === 'conservative') {
        return conf === 'high' && edge >= 10;
    }
    if (riskLevel === 'moderate') {
        return (conf === 'high' || conf === 'medium') && edge >= 5;
    }
    // aggressive
    return conf !== 'low' && edge >= 3;
}

function calculateTradeSize(rec, budgetLeft, maxPerTrade) {
    const sizeMap = { Small: 0.1, Medium: 0.2, Large: 0.4 };
    const fraction = sizeMap[rec.suggestedSize] || 0.1;

    // Scale by confidence
    const confMultiplier = rec.confidence === 'High' ? 1.5 : rec.confidence === 'Medium' ? 1.0 : 0.5;

    let amount = Math.round(maxPerTrade * fraction * confMultiplier);
    amount = Math.min(amount, maxPerTrade, budgetLeft);
    amount = Math.max(amount, 0);

    return amount;
}

async function executeTrade(params) {
    const {
        tokenId, side, amount, price, negRisk, market, outcome,
        hasLiveCreds, dryRun,
        polyApiKey, polySecret, polyPassphrase, polyPrivateKey,
    } = params;

    const shares = amount / price;

    const tradeRecord = {
        id: `auto_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        tokenId,
        side,
        amount,
        price,
        shares,
        market: market.question,
        marketId: market.id,
        outcome,
        timestamp: new Date().toISOString(),
        auto: true,
    };

    if (dryRun) {
        tradeRecord.status = 'dry_run';
        tradeRecord.live = false;
        return tradeRecord;
    }

    if (hasLiveCreds) {
        try {
            // Get real-time price
            let tradePrice;
            try {
                tradePrice = await getMidpoint(tokenId);
            } catch {
                tradePrice = price;
            }

            const slippagePrice = Math.min(tradePrice * 1.02, 0.99); // 2% slippage for auto

            const order = buildMarketOrder({
                tokenId, side, amount, price: slippagePrice, negRisk,
            });

            const signed = await signOrder(order, polyPrivateKey, negRisk);
            const result = await submitOrder(signed, polyApiKey, polySecret, polyPassphrase);

            tradeRecord.status = result.status || 'submitted';
            tradeRecord.live = true;
            tradeRecord.clobOrderId = result.orderID || result.id;
            tradeRecord.executedPrice = tradePrice;
            tradeRecord.shares = amount / tradePrice;

        } catch (err) {
            tradeRecord.status = 'failed';
            tradeRecord.error = err.message;
            tradeRecord.live = false;
        }
    } else {
        tradeRecord.status = 'paper';
        tradeRecord.live = false;
    }

    return tradeRecord;
}

function parseJsonSafe(val, fallback) {
    if (Array.isArray(val)) return val;
    if (typeof val === 'string') {
        try { return JSON.parse(val); }
        catch { return fallback; }
    }
    return fallback;
}

function formatNum(n) {
    const num = parseFloat(n || 0);
    if (num >= 1e6) return (num / 1e6).toFixed(1) + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(0) + 'K';
    return num.toFixed(0);
}
