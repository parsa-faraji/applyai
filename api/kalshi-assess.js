// Assess all current positions — explain why each was bought and whether to keep it
// Uses news + odds + Claude to give a honest self-assessment

import { searchNews } from './lib/search.js';
import { getAllSportsOdds, findMatchingOdds, formatOddsForPrompt } from './lib/odds.js';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Anthropic-Key, X-Brave-Key, X-Odds-Key');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { positions = [] } = req.body;
    const anthropicKey = req.headers['x-anthropic-key'] || process.env.ANTHROPIC_API_KEY;
    const braveKey = req.headers['x-brave-key'] || process.env.BRAVE_API_KEY || '';
    const oddsKey = req.headers['x-odds-key'] || process.env.ODDS_API_KEY || '';

    if (!anthropicKey) return res.status(400).json({ error: 'Anthropic key required' });
    if (positions.length === 0) return res.status(200).json({ assessments: [] });

    // Fetch odds once for all positions
    let allOdds = [];
    if (oddsKey) {
        try { allOdds = await getAllSportsOdds(oddsKey); } catch {}
    }

    const assessments = [];

    for (const pos of positions) {
        try {
            // Gather context
            let context = '';
            const news = await searchNews(pos.market, { braveKey }).catch(() => null);
            if (news?.headlines?.length > 0) {
                context += '\n## Recent News\n' + news.headlines.slice(0, 3).map((h, i) =>
                    `- ${h}${news.snippets?.[i] ? ': ' + news.snippets[i] : ''}`
                ).join('\n');
            }

            const odds = allOdds.length > 0 ? findMatchingOdds(pos.market, allOdds) : null;
            if (odds) context += formatOddsForPrompt(odds);

            const pnlPct = pos.avgPrice > 0
                ? ((pos.currentPrice - pos.avgPrice) / pos.avgPrice * 100).toFixed(1)
                : '?';

            const prompt = `You are reviewing a prediction market position. Be BRUTALLY HONEST about whether this was a good trade and what to do now.

## Position
- **Market:** ${pos.market}
- **Side:** ${pos.outcome} @ ${(pos.avgPrice * 100).toFixed(0)}¢ (${pos.shares} contracts)
- **Current Price:** ${(pos.currentPrice * 100).toFixed(0)}¢
- **P&L:** ${pnlPct}%
- **Resolves:** ${pos.endDate || 'Unknown'}
${context}

## Assess honestly:
1. **Why was this likely bought?** (Based on the market, side, and entry price)
2. **Was it a good decision?** (Given what we know now)
3. **What should we do now?** (HOLD to resolution, SELL now, or ADD more)
4. **Grade: A-F** (A = great trade with clear edge, F = no edge, pure gamble)

## Response (JSON only)
{
  "whyBought": "<1-2 sentences>",
  "assessment": "<1-2 sentences - was it good?>",
  "recommendation": "HOLD" | "SELL" | "ADD",
  "reasoning": "<1 sentence - what to do now and why>",
  "grade": "A" | "B" | "C" | "D" | "F",
  "hasEdge": true | false
}`;

            const resp = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'x-api-key': anthropicKey,
                    'anthropic-version': '2023-06-01',
                    'content-type': 'application/json',
                },
                body: JSON.stringify({
                    model: 'claude-sonnet-4-20250514',
                    max_tokens: 300,
                    messages: [{ role: 'user', content: prompt }],
                }),
            });

            if (!resp.ok) throw new Error(`Claude API ${resp.status}`);
            const data = await resp.json();
            const text = data.content?.[0]?.text || '';

            const json = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{}');
            assessments.push({
                ticker: pos.ticker,
                market: pos.market,
                outcome: pos.outcome,
                shares: pos.shares,
                avgPrice: pos.avgPrice,
                currentPrice: pos.currentPrice,
                pnlPct: parseFloat(pnlPct) || 0,
                ...json,
                hasOdds: !!odds,
                hasNews: !!(news?.headlines?.length),
            });
        } catch (err) {
            assessments.push({
                ticker: pos.ticker,
                market: pos.market,
                grade: '?',
                assessment: `Error: ${err.message}`,
                recommendation: 'HOLD',
            });
        }
    }

    // Overall summary
    const grades = assessments.filter(a => a.grade && a.grade !== '?');
    const avgGrade = grades.length > 0
        ? String.fromCharCode(Math.round(grades.reduce((sum, a) => sum + a.grade.charCodeAt(0), 0) / grades.length))
        : '?';
    const sells = assessments.filter(a => a.recommendation === 'SELL').length;
    const noEdge = assessments.filter(a => a.hasEdge === false).length;

    return res.status(200).json({
        assessments,
        summary: {
            totalPositions: assessments.length,
            avgGrade,
            sellRecommendations: sells,
            noEdgePositions: noEdge,
        },
    });
}
