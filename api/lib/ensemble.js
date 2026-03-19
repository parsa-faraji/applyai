/**
 * Multi-LLM Ensemble — query multiple AI models and aggregate their predictions.
 * Uses OpenRouter to access GPT-4o, Gemini, and DeepSeek alongside Claude.
 *
 * The ensemble reduces bias from any single model. When models agree,
 * conviction is high. When they disagree, position size is reduced or trade is skipped.
 *
 * Requires: OPENROUTER_API_KEY (env var or header) for non-Claude models.
 * Claude is called directly via Anthropic API.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Available models with weights and costs
 * Weights from the top Kalshi bot: Grok 30%, Claude 20%, GPT 20%, Gemini 15%, DeepSeek 15%
 * We skip Grok (requires separate xAI account) and reweight.
 */
// Claude is excluded — it already runs in the research stage. Including it here
// would double-count Claude's opinion and create a feedback loop (ensemble result
// gets fed back to Claude in the research context).
const MODELS = [
    { id: 'gpt4o', provider: 'openrouter', model: 'openai/gpt-4o', weight: 0.35, label: 'GPT-4o' },
    { id: 'gemini', provider: 'openrouter', model: 'google/gemini-2.5-flash', weight: 0.35, label: 'Gemini' },
    { id: 'deepseek', provider: 'openrouter', model: 'deepseek/deepseek-r1', weight: 0.30, label: 'DeepSeek' },
];

/**
 * Query a single model for a probability estimate
 * @param {object} model - model config from MODELS
 * @param {string} prompt - the analysis prompt
 * @param {object} keys - { anthropicKey, openrouterKey }
 * @returns {object} { probability, confidence, reasoning, model }
 */
async function queryModel(model, prompt, keys) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout per model
    try {
        let text;

        if (model.provider === 'anthropic') {
            if (!keys.anthropicKey) { clearTimeout(timeoutId); return null; }
            const resp = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                signal: controller.signal,
                headers: {
                    'x-api-key': keys.anthropicKey,
                    'anthropic-version': '2023-06-01',
                    'content-type': 'application/json',
                },
                body: JSON.stringify({
                    model: model.model,
                    max_tokens: 300,
                    messages: [{ role: 'user', content: prompt }],
                }),
            });
            if (!resp.ok) {
                console.error(`  Ensemble [${model.label}]: Anthropic API ${resp.status}`);
                clearTimeout(timeoutId);
                return null;
            }
            const data = await resp.json();
            text = data.content?.[0]?.text || '';

        } else if (model.provider === 'openrouter') {
            if (!keys.openrouterKey) { clearTimeout(timeoutId); return null; }
            const resp = await fetch(OPENROUTER_URL, {
                method: 'POST',
                signal: controller.signal,
                headers: {
                    'Authorization': `Bearer ${keys.openrouterKey}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'https://predictbot.app',
                },
                body: JSON.stringify({
                    model: model.model,
                    max_tokens: 300,
                    messages: [{ role: 'user', content: prompt }],
                }),
            });
            if (!resp.ok) {
                const errText = await resp.text().catch(() => '');
                console.error(`  Ensemble [${model.label}]: OpenRouter ${resp.status} — ${errText.slice(0, 100)}`);
                clearTimeout(timeoutId);
                return null;
            }
            const data = await resp.json();
            text = data.choices?.[0]?.message?.content || '';
        }

        clearTimeout(timeoutId);
        if (!text) return null;

        // Parse JSON response
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        const parsed = JSON.parse(jsonMatch[0]);

        return {
            model: model.label,
            probability: Math.max(0, Math.min(1, parsed.probability || 0.5)),
            confidence: parsed.confidence || 'medium',
            reasoning: parsed.reasoning || '',
        };
    } catch (err) {
        clearTimeout(timeoutId);
        const msg = err.name === 'AbortError' ? 'timeout (10s)' : err.message;
        console.error(`  Ensemble [${model.label}]: ${msg}`);
        return null;
    }
}

/**
 * Run the ensemble — query all available models in parallel
 * @param {string} question - market question
 * @param {string} description - market description
 * @param {string} context - news, odds, economic data
 * @param {object} keys - { anthropicKey, openrouterKey }
 * @returns {object} { consensusProbability, disagreement, confidence, models[], shouldTrade }
 */
export async function runEnsemble(question, description, context, keys) {
    const prompt = `You are estimating the probability of an event for a prediction market. Give your INDEPENDENT estimate based on the evidence. Do not anchor to any market price.

## Event
**Question:** ${question}
**Description:** ${description || 'N/A'}
${context}

## Instructions
- Estimate the probability this event resolves YES (0.0 to 1.0)
- Be calibrated — 70% means it happens 7 out of 10 times
- Consider base rates, recent evidence, and any data provided
- State your confidence level

## Response (JSON only)
{"probability": 0.0-1.0, "confidence": "low"|"medium"|"high", "reasoning": "1 sentence"}`;

    // Query all models in parallel
    const results = await Promise.all(
        MODELS.map(model => queryModel(model, prompt, keys))
    );

    // Filter out failed models
    const successful = [];
    for (let i = 0; i < MODELS.length; i++) {
        if (results[i]) {
            successful.push({ ...results[i], weight: MODELS[i].weight });
        }
    }

    if (successful.length === 0) {
        return { consensusProbability: 0.5, disagreement: 1, confidence: 'none', models: [], shouldTrade: false };
    }

    // Geometric mean of odds (proven best aggregation — Brier 0.116 vs 0.122 for arithmetic mean)
    // Converts probabilities to log-odds, takes weighted average, converts back.
    // Then extremize with a=2.0 (push away from 50% — models tend to underweight strong signals)
    const EXTREMIZE_A = 2.0;
    let totalWeight = 0;
    let weightedLogOdds = 0;

    for (const m of successful) {
        const p = Math.max(0.01, Math.min(0.99, m.probability));
        const logOdds = Math.log(p / (1 - p));
        weightedLogOdds += m.weight * logOdds;
        totalWeight += m.weight;
    }

    let rawConsensus = totalWeight > 0
        ? 1 / (1 + Math.exp(-(weightedLogOdds / totalWeight)))
        : 0.5;

    // Extremize: push probabilities away from 50% (aggregated forecasts are too moderate)
    // Formula: odds^a where a > 1
    const consensusOdds = rawConsensus / (1 - rawConsensus);
    const extremizedOdds = Math.pow(consensusOdds, EXTREMIZE_A);
    const consensusProbability = Math.max(0.01, Math.min(0.99, extremizedOdds / (1 + extremizedOdds)));

    // Disagreement = standard deviation across model probabilities
    const probs = successful.map(m => m.probability);
    const mean = probs.reduce((a, b) => a + b, 0) / probs.length;
    const variance = probs.reduce((sum, p) => sum + (p - mean) ** 2, 0) / probs.length;
    const disagreement = Math.sqrt(variance);

    // Disagreement penalty: if std_dev > 0.15, reduce confidence
    const disagreementPenalty = disagreement > 0.15 ? Math.min(1, disagreement / 0.25) * 0.3 : 0;

    // Overall confidence
    const avgConfidence = successful.reduce((sum, m) => {
        return sum + ({ low: 0.33, medium: 0.66, high: 1.0 }[m.confidence] || 0.5);
    }, 0) / successful.length;
    const adjustedConfidence = avgConfidence * (1 - disagreementPenalty);
    const confidence = adjustedConfidence > 0.7 ? 'high' : adjustedConfidence > 0.4 ? 'medium' : 'low';

    // Should trade: need at least 2 models to agree (low disagreement)
    const shouldTrade = successful.length >= 2 && disagreement < 0.25;

    return {
        consensusProbability,
        disagreement: parseFloat(disagreement.toFixed(3)),
        confidence,
        adjustedConfidence: parseFloat(adjustedConfidence.toFixed(3)),
        shouldTrade,
        modelsUsed: successful.length,
        models: successful.map(m => ({
            model: m.model,
            probability: m.probability,
            confidence: m.confidence,
            reasoning: m.reasoning,
        })),
    };
}

/**
 * Format ensemble results for Claude's prompt
 */
export function formatEnsembleForPrompt(ensemble) {
    if (!ensemble || ensemble.models.length === 0) return '';

    let text = `\n## AI Ensemble Forecast (${ensemble.modelsUsed} models)\n`;
    text += `- **Consensus:** ${(ensemble.consensusProbability * 100).toFixed(1)}% YES\n`;
    text += `- **Disagreement:** ${(ensemble.disagreement * 100).toFixed(1)}pp (${ensemble.disagreement < 0.1 ? 'strong agreement' : ensemble.disagreement < 0.2 ? 'moderate agreement' : 'significant disagreement'})\n`;
    text += `- **Confidence:** ${ensemble.confidence}\n`;

    for (const m of ensemble.models) {
        text += `- ${m.model}: ${(m.probability * 100).toFixed(0)}% (${m.confidence}) — ${m.reasoning}\n`;
    }

    return text;
}
