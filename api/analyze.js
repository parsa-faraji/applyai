// Vercel Serverless Function — Claude market analysis
// Sends market data to Claude and returns trading recommendation

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Anthropic-Key');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { market, riskLevel = 'moderate' } = req.body;

    if (!market) {
        return res.status(400).json({ error: 'Missing market data' });
    }

    // Accept API key from header (client-provided) or env var
    const apiKey = req.headers['x-anthropic-key'] || process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
        return res.status(400).json({ error: 'No Anthropic API key provided. Set it in Settings or configure ANTHROPIC_API_KEY env var.' });
    }

    try {
        const outcomePrices = market.outcomePrices
            ? (typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices)
            : [];
        const outcomes = market.outcomes
            ? (typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : market.outcomes)
            : [];

        const outcomeSummary = outcomes.map((name, i) => {
            const price = outcomePrices[i] ? (parseFloat(outcomePrices[i]) * 100).toFixed(1) : '?';
            return `  - ${name}: ${price}% (price: $${outcomePrices[i] || '?'})`;
        }).join('\n');

        const riskInstructions = {
            conservative: 'Only recommend trades where you have HIGH confidence (>75%) that the market is mispriced by at least 10 percentage points. Prefer smaller positions.',
            moderate: 'Recommend trades where you have moderate-to-high confidence the market is mispriced by at least 5-10 percentage points.',
            aggressive: 'Recommend trades even with moderate confidence of 3-5+ percentage point mispricings. Be more willing to take contrarian positions.',
        };

        const prompt = `You are an expert prediction market trader and analyst. Analyze the following Polymarket market and provide a trading recommendation.

## Market Information
**Question:** ${market.question}
**Description:** ${market.description || 'No description provided'}
**Category:** ${market.groupItemTitle || market.category || 'Unknown'}
**End Date:** ${market.endDate || 'Unknown'}
**Volume:** $${market.volume ? Number(market.volume).toLocaleString() : 'Unknown'}
**Liquidity:** $${market.liquidity ? Number(market.liquidity).toLocaleString() : 'Unknown'}

## Current Prices (Market-Implied Probabilities)
${outcomeSummary}

## Risk Tolerance
${riskInstructions[riskLevel] || riskInstructions.moderate}

## Your Task
1. **Analyze** the question — what are the key factors and evidence for each outcome?
2. **Estimate** your own probability for each outcome based on current knowledge
3. **Compare** your estimate vs the market price — is there an edge?
4. **Recommend** a specific action

## Response Format
Respond with this exact structure:

### Key Factors
[2-4 bullet points on what drives this outcome]

### Probability Estimate
[Your estimated probability for each outcome, with brief reasoning]

### Market Edge
[Where you see mispricing, if any]

### Recommendation
**Action:** [BUY YES / BUY NO / HOLD — no trade]
**Confidence:** [Low / Medium / High]
**Reasoning:** [1-2 sentences on why]
**Suggested Size:** [Small (5-10%) / Medium (15-25%) / Large (30-50%) of max position]`;

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 1500,
                messages: [
                    {
                        role: 'user',
                        content: prompt,
                    },
                ],
            }),
        });

        if (!response.ok) {
            const errBody = await response.text();
            console.error('Anthropic API error:', response.status, errBody);
            return res.status(502).json({ error: `Claude API error: ${response.status}` });
        }

        const data = await response.json();
        const content = data.content?.[0]?.text || 'No analysis generated';

        // Parse recommendation from the response
        const recommendation = parseRecommendation(content);

        return res.status(200).json({
            analysis: content,
            recommendation,
            usage: data.usage,
        });

    } catch (error) {
        console.error('Analysis error:', error);
        return res.status(500).json({ error: error.message || 'Analysis failed' });
    }
}

function parseRecommendation(text) {
    const rec = { action: 'HOLD', confidence: 'Low', reasoning: '', suggestedSize: 'Small' };

    const actionMatch = text.match(/\*\*Action:\*\*\s*(BUY YES|BUY NO|HOLD[^*]*)/i);
    if (actionMatch) rec.action = actionMatch[1].trim().toUpperCase();

    const confMatch = text.match(/\*\*Confidence:\*\*\s*(Low|Medium|High)/i);
    if (confMatch) rec.confidence = confMatch[1];

    const reasonMatch = text.match(/\*\*Reasoning:\*\*\s*(.+?)(?:\n|$)/i);
    if (reasonMatch) rec.reasoning = reasonMatch[1].trim();

    const sizeMatch = text.match(/\*\*Suggested Size:\*\*\s*(Small|Medium|Large)/i);
    if (sizeMatch) rec.suggestedSize = sizeMatch[1];

    return rec;
}
