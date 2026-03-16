/**
 * Live Sports Data Module
 *
 * Fetches live scores, team info, injuries, and game context for
 * sports prediction markets. Uses ESPN's free unofficial API as the
 * primary source and API-Sports (api-sports.io) as a paid fallback.
 *
 * ESPN endpoints require no API key and cover NBA, NCAAB, NFL, MLB,
 * NHL, and top soccer leagues. API-Sports ($10/mo) adds injuries,
 * lineups, and prediction models — used only when API_SPORTS_KEY is set.
 */

// ── ESPN free-API mappings ────────────────────────────────────────
const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';

/** @type {Record<string, {sport: string, league: string}>} */
const ESPN_LEAGUES = {
    nba:    { sport: 'basketball', league: 'nba' },
    ncaab:  { sport: 'basketball', league: 'mens-college-basketball' },
    nfl:    { sport: 'football',   league: 'nfl' },
    mlb:    { sport: 'baseball',   league: 'mlb' },
    nhl:    { sport: 'hockey',     league: 'nhl' },
    soccer: { sport: 'soccer',     league: 'eng.1' },
};

// ── API-Sports base URLs per sport ───────────────────────────────
const API_SPORTS_BASES = {
    nba:    'https://v1.basketball.api-sports.io',
    ncaab:  'https://v1.basketball.api-sports.io',
    nfl:    'https://v1.american-football.api-sports.io',
    mlb:    'https://v1.baseball.api-sports.io',
    nhl:    'https://v1.hockey.api-sports.io',
    soccer: 'https://v3.football.api-sports.io',
};

// ── Simple in-memory cache (60 s TTL) ────────────────────────────
const _cache = new Map();
const CACHE_TTL = 60_000;

/**
 * Fetch with caching. Returns cached response if still fresh.
 * @param {string} url
 * @param {RequestInit} [opts]
 * @returns {Promise<any>}
 */
async function cachedFetch(url, opts) {
    const key = url + (opts?.headers ? JSON.stringify(opts.headers) : '');
    const cached = _cache.get(key);
    if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

    const resp = await fetch(url, opts);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    _cache.set(key, { data, ts: Date.now() });
    return data;
}

// ── ESPN helpers ──────────────────────────────────────────────────

/**
 * Normalise ESPN game status to one of three canonical values.
 * @param {object} status - ESPN status object
 * @returns {'scheduled'|'in_progress'|'final'}
 */
function normalizeStatus(status) {
    const id = status?.type?.id;          // ESPN status type ID
    const state = status?.type?.state;    // "pre", "in", "post"
    if (state === 'in' || id === '2') return 'in_progress';
    if (state === 'post' || id === '3') return 'final';
    return 'scheduled';
}

/**
 * Parse an ESPN scoreboard event into our canonical shape.
 * @param {object} event
 * @returns {object}
 */
function parseESPNEvent(event) {
    const comp = event.competitions?.[0] || {};
    const competitors = comp.competitors || [];
    const home = competitors.find(c => c.homeAway === 'home') || competitors[0] || {};
    const away = competitors.find(c => c.homeAway === 'away') || competitors[1] || {};

    const status = normalizeStatus(event.status);
    const period = event.status?.period ?? null;
    const clock = event.status?.displayClock ?? null;

    // Odds (ESPN sometimes includes them)
    let homeSpread = null;
    let totalLine = null;
    const oddsInfo = comp.odds?.[0];
    if (oddsInfo) {
        homeSpread = oddsInfo.spread ?? oddsInfo.details ?? null;
        totalLine = oddsInfo.overUnder ?? null;
    }

    return {
        id: event.id,
        name: event.name || `${away.team?.displayName} at ${home.team?.displayName}`,
        homeTeam: home.team?.displayName || home.team?.shortDisplayName || 'Home',
        awayTeam: away.team?.displayName || away.team?.shortDisplayName || 'Away',
        homeAbbr: home.team?.abbreviation || '',
        awayAbbr: away.team?.abbreviation || '',
        homeScore: parseInt(home.score, 10) || 0,
        awayScore: parseInt(away.score, 10) || 0,
        status,
        quarter: period,
        period,
        timeRemaining: clock,
        startTime: event.date || null,
        odds: { homeSpread, totalLine },
        records: {
            homeRecord: home.records?.[0]?.summary || null,
            awayRecord: away.records?.[0]?.summary || null,
        },
    };
}

// ── Core exports ─────────────────────────────────────────────────

/**
 * Get today's live and upcoming scores for a sport via ESPN.
 *
 * @param {string} sport - One of: 'nba', 'ncaab', 'nfl', 'mlb', 'nhl', 'soccer'
 * @returns {Promise<Array<object>>} Array of game objects
 */
export async function getLiveScores(sport) {
    try {
        const mapping = ESPN_LEAGUES[sport?.toLowerCase()];
        if (!mapping) return [];
        const url = `${ESPN_BASE}/${mapping.sport}/${mapping.league}/scoreboard`;
        const data = await cachedFetch(url);
        return (data.events || []).map(parseESPNEvent);
    } catch {
        return [];
    }
}

/**
 * Get team info: record, recent results, injuries, and standing.
 *
 * This first checks the ESPN scoreboard (cheap, cached) to pull the
 * team record. If API_SPORTS_KEY is available it supplements with
 * injury data from the paid API.
 *
 * @param {string} teamName - Full or partial team name, e.g. "Arkansas"
 * @param {string} sport    - One of the supported sport keys
 * @param {string} [apiSportsKey] - Optional API-Sports key
 * @returns {Promise<object>} { record, recentResults, injuries, standing }
 */
export async function getTeamInfo(teamName, sport, apiSportsKey) {
    const result = { record: null, recentResults: [], injuries: [], standing: null };
    try {
        const scores = await getLiveScores(sport);
        const game = findTeamInScores(teamName, scores);
        if (game) {
            const isHome = fuzzyMatch(teamName, game.homeTeam);
            result.record = isHome ? game.records.homeRecord : game.records.awayRecord;
        }

        // Supplement with API-Sports injuries if key is available
        if (apiSportsKey) {
            const injuries = await fetchAPISportsInjuries(sport, teamName, apiSportsKey);
            result.injuries = injuries;
        }
    } catch {
        // swallow — we never throw
    }
    return result;
}

/**
 * Given a market question (e.g. "Will Arkansas win by over 15.5 points?"),
 * find the relevant game on today's scoreboard and return a formatted
 * context string the bot can feed to Claude.
 *
 * This is the primary function the prediction bot should call.
 *
 * @param {string} query         - The market question text
 * @param {string} [apiSportsKey] - Optional API-Sports key for extra data
 * @returns {Promise<string>} Human-readable context block, or '' on failure
 */
export async function getSportsContext(query, apiSportsKey) {
    try {
        const teams = extractTeamCandidates(query);
        if (teams.length === 0) return '';

        // Search across all sports in parallel for a match
        const allSports = Object.keys(ESPN_LEAGUES);
        const scoresByLeague = await Promise.all(allSports.map(s => getLiveScores(s)));

        let bestGame = null;
        let bestSport = null;
        let bestScore = 0;

        for (let i = 0; i < allSports.length; i++) {
            for (const game of scoresByLeague[i]) {
                const score = matchScore(teams, game);
                if (score > bestScore) {
                    bestScore = score;
                    bestGame = game;
                    bestSport = allSports[i];
                }
            }
        }

        if (!bestGame || bestScore < 1) return '';

        // Build the context string
        let ctx = `\n## Live Sports Data (${bestSport.toUpperCase()})\n`;
        ctx += `**Game:** ${bestGame.awayTeam} at ${bestGame.homeTeam}\n`;

        if (bestGame.status === 'in_progress') {
            ctx += `**Score:** ${bestGame.awayTeam} ${bestGame.awayScore} — ${bestGame.homeTeam} ${bestGame.homeScore}`;
            if (bestGame.quarter) ctx += ` (Q${bestGame.quarter}`;
            if (bestGame.timeRemaining) ctx += ` ${bestGame.timeRemaining}`;
            if (bestGame.quarter) ctx += ')';
            ctx += '\n';
        } else if (bestGame.status === 'final') {
            ctx += `**Final Score:** ${bestGame.awayTeam} ${bestGame.awayScore} — ${bestGame.homeTeam} ${bestGame.homeScore}\n`;
        } else {
            ctx += `**Status:** Scheduled`;
            if (bestGame.startTime) {
                const d = new Date(bestGame.startTime);
                ctx += ` — ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
            }
            ctx += '\n';
        }

        if (bestGame.records.homeRecord) {
            ctx += `**Records:** ${bestGame.homeTeam} (${bestGame.records.homeRecord})`;
            if (bestGame.records.awayRecord) {
                ctx += ` vs ${bestGame.awayTeam} (${bestGame.records.awayRecord})`;
            }
            ctx += '\n';
        }

        if (bestGame.odds.homeSpread) ctx += `**Spread:** ${bestGame.odds.homeSpread}\n`;
        if (bestGame.odds.totalLine) ctx += `**O/U:** ${bestGame.odds.totalLine}\n`;

        // Fetch injuries from API-Sports if available
        if (apiSportsKey) {
            const homeInjuries = await fetchAPISportsInjuries(bestSport, bestGame.homeTeam, apiSportsKey);
            const awayInjuries = await fetchAPISportsInjuries(bestSport, bestGame.awayTeam, apiSportsKey);
            const allInjuries = [...homeInjuries, ...awayInjuries];
            if (allInjuries.length > 0) {
                ctx += '**Injuries:**\n';
                for (const inj of allInjuries.slice(0, 10)) {
                    ctx += `- ${inj.player}: ${inj.status}\n`;
                }
            }
        }

        return ctx;
    } catch {
        return '';
    }
}

// ── API-Sports fallback helpers ──────────────────────────────────

/**
 * Fetch injuries from API-Sports for a given team and sport.
 * @param {string} sport
 * @param {string} teamName
 * @param {string} apiKey
 * @returns {Promise<Array<{player: string, status: string}>>}
 */
async function fetchAPISportsInjuries(sport, teamName, apiKey) {
    try {
        const base = API_SPORTS_BASES[sport];
        if (!base) return [];

        // API-Sports uses different endpoints per sport family
        const isSoccer = sport === 'soccer';
        const endpoint = isSoccer ? '/injuries' : '/injuries';

        const url = `${base}${endpoint}`;
        const data = await cachedFetch(url, {
            headers: {
                'x-apisports-key': apiKey,
            },
        });

        const injuries = [];
        const results = data?.response || [];
        for (const entry of results) {
            const player = isSoccer
                ? entry?.player?.name
                : entry?.player?.name || entry?.player;
            const team = isSoccer
                ? entry?.team?.name
                : entry?.team?.name || entry?.team;
            const status = entry?.player?.reason || entry?.status || entry?.type || 'Unknown';

            if (player && team && fuzzyMatch(teamName, team)) {
                injuries.push({ player, status });
            }
        }
        return injuries;
    } catch {
        return [];
    }
}

// ── Team name matching utilities ─────────────────────────────────

/**
 * Extract candidate team names from a market question.
 * Handles patterns like "Will Arkansas win?", "Lakers vs Celtics",
 * "Duke at North Carolina", etc.
 *
 * @param {string} query
 * @returns {string[]}
 */
function extractTeamCandidates(query) {
    const candidates = [];
    const q = query.replace(/[?!.]/g, '').trim();

    // "X vs Y", "X vs. Y", "X versus Y", "X at Y"
    const vsMatch = q.match(/(.+?)\s+(?:vs\.?|versus|at|@)\s+(.+?)(?:\s+(?:win|score|total|over|under|spread|by)|\s*$)/i);
    if (vsMatch) {
        candidates.push(cleanTeamName(vsMatch[1]));
        candidates.push(cleanTeamName(vsMatch[2]));
    }

    // "Will X win / beat Y"
    const willMatch = q.match(/(?:will|can|does)\s+(.+?)\s+(?:win|beat|defeat|cover)/i);
    if (willMatch) candidates.push(cleanTeamName(willMatch[1]));

    // "X wins by"
    const winsMatch = q.match(/(.+?)\s+wins?\s+(?:by|against|over)/i);
    if (winsMatch) candidates.push(cleanTeamName(winsMatch[1]));

    // "X to win"
    const toWinMatch = q.match(/(.+?)\s+to\s+win/i);
    if (toWinMatch) candidates.push(cleanTeamName(toWinMatch[1]));

    // Deduplicate
    const seen = new Set();
    return candidates.filter(c => {
        if (c.length < 3 || seen.has(c.toLowerCase())) return false;
        seen.add(c.toLowerCase());
        return true;
    });
}

/**
 * Strip common filler words from a team name candidate.
 * @param {string} name
 * @returns {string}
 */
function cleanTeamName(name) {
    return name
        .replace(/^(the|will|do|does|can)\s+/i, '')
        .replace(/\s+(game|match|contest)$/i, '')
        .trim();
}

/**
 * Fuzzy-match a search term against a full team name.
 * "Arkansas" matches "Arkansas Razorbacks", "Celtics" matches
 * "Boston Celtics", etc.
 *
 * @param {string} query - Partial name to search for
 * @param {string} fullName - Full team name from ESPN
 * @returns {boolean}
 */
function fuzzyMatch(query, fullName) {
    if (!query || !fullName) return false;
    const q = query.toLowerCase().trim();
    const f = fullName.toLowerCase().trim();
    if (f.includes(q) || q.includes(f)) return true;

    // Check individual words — "North Carolina" should match even
    // if query is just "Carolina"
    const qWords = q.split(/\s+/).filter(w => w.length > 2);
    const fWords = f.split(/\s+/);
    let matched = 0;
    for (const qw of qWords) {
        if (fWords.some(fw => fw.includes(qw) || qw.includes(fw))) {
            matched++;
        }
    }
    return matched > 0 && matched >= qWords.length * 0.5;
}

/**
 * Find a team in the scores array by fuzzy name match.
 * @param {string} teamName
 * @param {Array} scores
 * @returns {object|null}
 */
function findTeamInScores(teamName, scores) {
    for (const game of scores) {
        if (fuzzyMatch(teamName, game.homeTeam) || fuzzyMatch(teamName, game.awayTeam)) {
            return game;
        }
    }
    return null;
}

/**
 * Score how well a set of team-name candidates matches a given game.
 * Higher is better; 0 means no match.
 *
 * @param {string[]} candidates
 * @param {object} game
 * @returns {number}
 */
function matchScore(candidates, game) {
    let score = 0;
    for (const c of candidates) {
        if (fuzzyMatch(c, game.homeTeam)) score += 2;
        if (fuzzyMatch(c, game.awayTeam)) score += 2;
        if (fuzzyMatch(c, game.homeAbbr)) score += 1;
        if (fuzzyMatch(c, game.awayAbbr)) score += 1;
    }
    return score;
}
