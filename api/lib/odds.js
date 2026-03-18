/**
 * The Odds API integration — real-time bookmaker odds
 * https://the-odds-api.com/
 *
 * Provides Vegas/bookmaker lines to compare against Kalshi prices.
 * Free tier: 500 requests/month
 */

const BASE_URL = 'https://api.the-odds-api.com/v4';

// Sports we care about (Kalshi has markets for these)
const SPORT_KEYS = [
    'basketball_nba',
    'basketball_ncaab',
    'americanfootball_nfl',
    'americanfootball_ncaaf',
    'baseball_mlb',
    'icehockey_nhl',
    'soccer_epl',
    'soccer_usa_mls',
    'soccer_uefa_champs_league',
    'mma_mixed_martial_arts',
    'basketball_euroleague',
];

/**
 * Fetch odds for a specific sport
 * @param {string} sportKey - e.g. 'basketball_nba'
 * @param {string} apiKey - The Odds API key
 * @param {string} markets - 'h2h' (moneyline), 'spreads', 'totals'
 * @returns {Array} events with odds from multiple bookmakers
 */
export async function getOdds(sportKey, apiKey, markets = 'h2h,spreads,totals') {
    const params = new URLSearchParams({
        apiKey,
        regions: 'us,us2',
        markets,
        oddsFormat: 'american',
    });

    const resp = await fetch(`${BASE_URL}/sports/${sportKey}/odds?${params}`);
    if (!resp.ok) {
        if (resp.status === 401) throw new Error('Invalid Odds API key');
        if (resp.status === 429) throw new Error('Odds API rate limit');
        throw new Error(`Odds API ${resp.status}`);
    }
    return resp.json();
}

/**
 * Fetch odds across all supported sports
 * @returns {Array} all events with odds
 */
export async function getAllSportsOdds(apiKey) {
    const allOdds = [];
    let successes = 0;
    let failures = 0;
    // Fetch top sports in parallel (uses ~11 API calls)
    const results = await Promise.allSettled(
        SPORT_KEYS.map(async sport => {
            try {
                const events = await getOdds(sport, apiKey);
                return { sport, events: Array.isArray(events) ? events : [] };
            } catch (err) {
                console.error(`  Odds API error [${sport}]: ${err.message}`);
                return { sport, events: [], error: err.message };
            }
        })
    );
    for (const r of results) {
        if (r.status === 'fulfilled') {
            if (r.value.error) {
                failures++;
            } else {
                successes++;
                allOdds.push(...r.value.events);
            }
        } else {
            failures++;
            console.error(`  Odds API rejected: ${r.reason}`);
        }
    }
    if (failures > 0 && allOdds.length === 0) {
        console.error(`  ⚠ Odds API: ALL ${failures} sport fetches failed — check API key and quota`);
    }
    return allOdds;
}

/**
 * Find matching bookmaker odds for a Kalshi market question
 * @param {string} question - Kalshi market question (e.g. "Arkansas wins by over 15.5 Points?")
 * @param {Array} allOdds - odds data from getAllSportsOdds
 * @returns {object|null} matching odds with consensus probability
 */
export function findMatchingOdds(question, allOdds) {
    const q = question.toLowerCase();

    // Extract team names and numbers from the question
    const teams = extractTeams(q);
    const spreadNum = extractSpread(q);
    const isSpread = q.includes('wins by') || q.includes('spread') || q.includes('over') || q.includes('under');
    const isTotal = q.includes('total points') || q.includes('total score');
    const isMoneyline = q.includes('winner') || q.includes('win the') || q.includes('win map');

    let bestMatch = null;
    let bestScore = 0;

    for (const event of allOdds) {
        const homeTeam = (event.home_team || '').toLowerCase();
        const awayTeam = (event.away_team || '').toLowerCase();
        const eventTeams = [homeTeam, awayTeam];

        // Score how well this event matches the question
        let score = 0;
        for (const team of teams) {
            for (const eventTeam of eventTeams) {
                if (eventTeam.includes(team) || team.includes(eventTeam)) {
                    score += 3;
                } else {
                    // Check individual words
                    const teamWords = team.split(/\s+/);
                    const eventWords = eventTeam.split(/\s+/);
                    for (const tw of teamWords) {
                        if (tw.length > 3 && eventWords.some(ew => ew.includes(tw) || tw.includes(ew))) {
                            score += 1;
                        }
                    }
                }
            }
        }

        if (score > bestScore) {
            bestScore = score;
            bestMatch = event;
        }
    }

    if (!bestMatch || bestScore < 2) return null;

    // Extract the relevant odds
    const result = {
        event: `${bestMatch.home_team} vs ${bestMatch.away_team}`,
        sport: bestMatch.sport_title,
        startTime: bestMatch.commence_time,
        matchScore: bestScore,
        bookmakers: [],
        consensus: null,
    };

    // Get odds from each bookmaker
    for (const bm of (bestMatch.bookmakers || [])) {
        for (const market of (bm.markets || [])) {
            // Match market type to question
            if (isSpread && market.key === 'spreads') {
                for (const outcome of market.outcomes) {
                    const impliedProb = americanToProb(outcome.price);
                    result.bookmakers.push({
                        bookmaker: bm.title,
                        type: 'spread',
                        team: outcome.name,
                        line: outcome.point,
                        odds: outcome.price,
                        impliedProb,
                    });
                }
            } else if (isTotal && market.key === 'totals') {
                for (const outcome of market.outcomes) {
                    const impliedProb = americanToProb(outcome.price);
                    result.bookmakers.push({
                        bookmaker: bm.title,
                        type: 'total',
                        side: outcome.name, // Over/Under
                        line: outcome.point,
                        odds: outcome.price,
                        impliedProb,
                    });
                }
            } else if ((isMoneyline || !isSpread) && market.key === 'h2h') {
                for (const outcome of market.outcomes) {
                    const impliedProb = americanToProb(outcome.price);
                    result.bookmakers.push({
                        bookmaker: bm.title,
                        type: 'moneyline',
                        team: outcome.name,
                        odds: outcome.price,
                        impliedProb,
                    });
                }
            }
        }
    }

    // Calculate consensus probability with vig removal
    // Bookmaker implied probs sum to >100% due to vig (overround).
    // We normalize per-bookmaker so each bookmaker's probs sum to 1.0 before averaging.
    if (result.bookmakers.length > 0) {
        // Group by bookmaker first for vig removal
        const byBookmaker = {};
        for (const bm of result.bookmakers) {
            const bmKey = `${bm.bookmaker}_${bm.type}`;
            if (!byBookmaker[bmKey]) byBookmaker[bmKey] = [];
            byBookmaker[bmKey].push(bm);
        }

        // Normalize each bookmaker's probs to sum to 1.0 (remove vig)
        const vigRemovedEntries = [];
        for (const [, bms] of Object.entries(byBookmaker)) {
            const totalImplied = bms.reduce((sum, bm) => sum + bm.impliedProb, 0);
            for (const bm of bms) {
                vigRemovedEntries.push({
                    ...bm,
                    vigFreeProb: totalImplied > 0 ? bm.impliedProb / totalImplied : bm.impliedProb,
                });
            }
        }

        // Now group by team/side and average the vig-free probs
        const groups = {};
        for (const bm of vigRemovedEntries) {
            const key = bm.team || bm.side || 'unknown';
            if (!groups[key]) groups[key] = [];
            groups[key].push(bm.vigFreeProb);
        }
        result.consensus = {};
        for (const [key, probs] of Object.entries(groups)) {
            result.consensus[key] = {
                avgProb: probs.reduce((a, b) => a + b, 0) / probs.length,
                numBookmakers: probs.length,
                range: [Math.min(...probs), Math.max(...probs)],
            };
        }
    }

    return result;
}

/**
 * Format odds data as a string for Claude's prompt
 */
export function formatOddsForPrompt(oddsData) {
    if (!oddsData) return '';

    let text = `\n## Bookmaker Odds (${oddsData.sport})\n`;
    text += `**Event:** ${oddsData.event}\n`;

    if (oddsData.consensus) {
        for (const [team, data] of Object.entries(oddsData.consensus)) {
            const pct = (data.avgProb * 100).toFixed(1);
            const range = `${(data.range[0] * 100).toFixed(0)}-${(data.range[1] * 100).toFixed(0)}%`;
            text += `- **${team}**: ${pct}% consensus (${data.numBookmakers} bookmakers, range: ${range})\n`;
        }
    }

    // Show a few individual bookmaker lines
    const seen = new Set();
    for (const bm of oddsData.bookmakers.slice(0, 6)) {
        const key = `${bm.bookmaker}-${bm.team || bm.side}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const prob = (bm.impliedProb * 100).toFixed(0);
        const line = bm.line != null ? ` (${bm.line > 0 ? '+' : ''}${bm.line})` : '';
        text += `- ${bm.bookmaker}: ${bm.team || bm.side}${line} at ${formatAmerican(bm.odds)} (${prob}%)\n`;
    }

    return text;
}

// Convert American odds to implied probability
function americanToProb(odds) {
    if (odds > 0) return 100 / (odds + 100);
    return Math.abs(odds) / (Math.abs(odds) + 100);
}

function formatAmerican(odds) {
    return odds > 0 ? `+${odds}` : `${odds}`;
}

function extractTeams(question) {
    const teams = [];
    // Common patterns: "X vs Y", "X wins", "X at Y"
    const vsMatch = question.match(/(.+?)\s+(?:vs\.?|versus|at)\s+(.+?)(?:\s*[:?]|\s+winner|\s+wins)/i);
    if (vsMatch) {
        teams.push(vsMatch[1].trim(), vsMatch[2].trim());
    }
    // "X wins by" pattern
    const winsMatch = question.match(/(.+?)\s+wins\s+by/i);
    if (winsMatch) teams.push(winsMatch[1].trim());
    // Clean up
    return teams.map(t => t.replace(/^(will\s+)/i, '').trim()).filter(t => t.length > 2);
}

function extractSpread(question) {
    const match = question.match(/(?:over|by|under)\s+([\d.]+)\s*(?:points?|pts)?/i);
    return match ? parseFloat(match[1]) : null;
}
