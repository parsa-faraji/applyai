/**
 * FRED (Federal Reserve Economic Data) API client
 * https://fred.stlouisfed.org/docs/api/fred/
 *
 * Fetches real economic data to compare against Kalshi market prices
 * for inflation, unemployment, GDP, and interest rate markets.
 *
 * Set FRED_API_KEY in your environment for full access.
 * A demo key is used as fallback but has stricter rate limits.
 */

const BASE_URL = 'https://api.stlouisfed.org/fred/series/observations';

/** Well-known FRED series IDs for key economic indicators */
const SERIES = {
    CPI: 'CPIAUCSL',           // Consumer Price Index (all urban, seasonally adjusted)
    UNEMPLOYMENT: 'UNRATE',     // Civilian unemployment rate
    GDP: 'GDP',                 // Gross Domestic Product
    FED_FUNDS: 'FEDFUNDS',     // Effective federal funds rate
    SP500: 'SP500',            // S&P 500 index
    YIELD_CURVE: 'T10Y2Y',    // 10-Year minus 2-Year Treasury spread
};

/**
 * Internal helper — fetch the most recent observations for a FRED series.
 * @param {string} seriesId - FRED series ID (e.g. 'CPIAUCSL')
 * @param {number} [limit=12] - number of recent observations to fetch
 * @returns {Promise<Array<{date: string, value: string}>>} observations
 */
async function fetchSeries(seriesId, limit = 12) {
    const apiKey = process.env.FRED_API_KEY || 'DEMO_KEY';
    const params = new URLSearchParams({
        series_id: seriesId,
        api_key: apiKey,
        file_type: 'json',
        sort_order: 'desc',
        limit: limit.toString(),
    });

    const resp = await fetch(`${BASE_URL}?${params}`);
    if (!resp.ok) {
        throw new Error(`FRED API ${resp.status}: ${resp.statusText}`);
    }

    const data = await resp.json();
    return (data.observations || []).filter(o => o.value !== '.');
}

/**
 * Fetch the latest CPI reading and compute year-over-year inflation.
 * @returns {Promise<{latest: number, date: string, yoyChange: number|null}>}
 */
export async function getLatestCPI() {
    try {
        const obs = await fetchSeries(SERIES.CPI, 13);
        if (obs.length === 0) return null;

        const latest = parseFloat(obs[0].value);
        const latestDate = obs[0].date;

        // Year-over-year: compare to observation ~12 months ago
        let yoyChange = null;
        if (obs.length >= 13) {
            const yearAgo = parseFloat(obs[12].value);
            if (yearAgo > 0) {
                yoyChange = ((latest - yearAgo) / yearAgo) * 100;
            }
        }

        return { latest, date: latestDate, yoyChange };
    } catch (e) {
        console.error('FRED CPI error:', e.message);
        return null;
    }
}

/**
 * Fetch the latest unemployment rate.
 * @returns {Promise<{rate: number, date: string, previousRate: number|null}>}
 */
export async function getUnemploymentRate() {
    try {
        const obs = await fetchSeries(SERIES.UNEMPLOYMENT, 2);
        if (obs.length === 0) return null;

        const rate = parseFloat(obs[0].value);
        const date = obs[0].date;
        const previousRate = obs.length >= 2 ? parseFloat(obs[1].value) : null;

        return { rate, date, previousRate };
    } catch (e) {
        console.error('FRED unemployment error:', e.message);
        return null;
    }
}

/**
 * Fetch the latest GDP growth reading.
 * @returns {Promise<{value: number, date: string, previousValue: number|null}>}
 */
export async function getGDPGrowth() {
    try {
        const obs = await fetchSeries(SERIES.GDP, 2);
        if (obs.length === 0) return null;

        const value = parseFloat(obs[0].value);
        const date = obs[0].date;
        const previousValue = obs.length >= 2 ? parseFloat(obs[1].value) : null;

        // Compute quarter-over-quarter annualized growth
        let qoqGrowth = null;
        if (previousValue && previousValue > 0) {
            qoqGrowth = ((value - previousValue) / previousValue) * 100 * 4;
        }

        return { value, date, previousValue, qoqGrowth };
    } catch (e) {
        console.error('FRED GDP error:', e.message);
        return null;
    }
}

/**
 * Fetch the current effective federal funds rate.
 * @returns {Promise<{rate: number, date: string, previousRate: number|null}>}
 */
export async function getFedFundsRate() {
    try {
        const obs = await fetchSeries(SERIES.FED_FUNDS, 2);
        if (obs.length === 0) return null;

        const rate = parseFloat(obs[0].value);
        const date = obs[0].date;
        const previousRate = obs.length >= 2 ? parseFloat(obs[1].value) : null;

        return { rate, date, previousRate };
    } catch (e) {
        console.error('FRED fed funds error:', e.message);
        return null;
    }
}

/**
 * Map of keywords to the economic indicators they relate to.
 * Used by getEconomicContext to decide which data to fetch.
 */
const KEYWORD_MAP = [
    {
        keywords: ['cpi', 'inflation', 'consumer price', 'price index', 'cost of living'],
        fetcher: getLatestCPI,
        formatter: (data) => {
            if (!data) return '';
            let text = `**CPI (Consumer Price Index):** ${data.latest.toFixed(1)} as of ${data.date}`;
            if (data.yoyChange != null) {
                text += `\n- Year-over-year inflation: ${data.yoyChange.toFixed(2)}%`;
                if (data.yoyChange > 3.5) {
                    text += ' (elevated — above Fed target)';
                } else if (data.yoyChange <= 2.5 && data.yoyChange >= 1.5) {
                    text += ' (near Fed\'s 2% target)';
                } else if (data.yoyChange < 1.5) {
                    text += ' (below target — possible deflationary concern)';
                }
            }
            return text;
        },
    },
    {
        keywords: ['unemployment', 'jobless', 'jobs report', 'labor market', 'nonfarm', 'payroll'],
        fetcher: getUnemploymentRate,
        formatter: (data) => {
            if (!data) return '';
            let text = `**Unemployment Rate:** ${data.rate.toFixed(1)}% as of ${data.date}`;
            if (data.previousRate != null) {
                const diff = data.rate - data.previousRate;
                const direction = diff > 0 ? 'up' : diff < 0 ? 'down' : 'unchanged';
                text += `\n- Previous month: ${data.previousRate.toFixed(1)}% (${direction} ${Math.abs(diff).toFixed(1)}pp)`;
                if (data.rate < 4.0) {
                    text += '\n- Labor market remains tight';
                } else if (data.rate >= 5.0) {
                    text += '\n- Elevated unemployment — possible recession signal';
                }
            }
            return text;
        },
    },
    {
        keywords: ['gdp', 'gross domestic', 'economic growth', 'recession', 'economic output'],
        fetcher: getGDPGrowth,
        formatter: (data) => {
            if (!data) return '';
            let text = `**GDP:** $${(data.value / 1000).toFixed(2)} trillion (annualized) as of ${data.date}`;
            if (data.qoqGrowth != null) {
                text += `\n- Quarter-over-quarter annualized growth: ${data.qoqGrowth.toFixed(1)}%`;
                if (data.qoqGrowth < 0) {
                    text += ' (contraction — negative growth)';
                } else if (data.qoqGrowth < 1.0) {
                    text += ' (sluggish growth)';
                } else if (data.qoqGrowth > 3.0) {
                    text += ' (strong growth)';
                }
            }
            return text;
        },
    },
    {
        keywords: ['fed fund', 'federal fund', 'interest rate', 'rate hike', 'rate cut', 'fomc', 'monetary policy', 'fed rate'],
        fetcher: getFedFundsRate,
        formatter: (data) => {
            if (!data) return '';
            let text = `**Federal Funds Rate:** ${data.rate.toFixed(2)}% as of ${data.date}`;
            if (data.previousRate != null) {
                const diff = data.rate - data.previousRate;
                if (Math.abs(diff) > 0.001) {
                    const direction = diff > 0 ? 'raised' : 'lowered';
                    text += `\n- Previous: ${data.previousRate.toFixed(2)}% (${direction} by ${Math.abs(diff).toFixed(2)}pp)`;
                } else {
                    text += `\n- Unchanged from previous period (${data.previousRate.toFixed(2)}%)`;
                }
            }
            return text;
        },
    },
];

/**
 * Given a market question, figure out which economic indicator is relevant,
 * fetch it, and return formatted text describing the data and what it implies.
 *
 * @param {string} query - the market question (e.g. "Will CPI exceed 4% in March?")
 * @returns {Promise<string>} formatted text for inclusion in a Claude prompt, or '' on failure
 */
export async function getEconomicContext(query) {
    try {
        const q = query.toLowerCase();

        // Find all matching indicators
        const matches = KEYWORD_MAP.filter(entry =>
            entry.keywords.some(kw => q.includes(kw))
        );

        if (matches.length === 0) {
            // No specific match — try fetching fed funds rate and CPI as general context
            // if the question mentions "economy" or "market" broadly
            if (q.includes('econom') || q.includes('market') || q.includes('recession')) {
                const [gdp, fedFunds] = await Promise.all([
                    getGDPGrowth(),
                    getFedFundsRate(),
                ]);

                const parts = [];
                const gdpEntry = KEYWORD_MAP.find(e => e.keywords.includes('gdp'));
                const fedEntry = KEYWORD_MAP.find(e => e.keywords.includes('fed fund'));

                if (gdpEntry) {
                    const text = gdpEntry.formatter(gdp);
                    if (text) parts.push(text);
                }
                if (fedEntry) {
                    const text = fedEntry.formatter(fedFunds);
                    if (text) parts.push(text);
                }

                if (parts.length === 0) return '';
                return `\n## Economic Data (FRED)\n${parts.join('\n\n')}\n`;
            }
            return '';
        }

        // Fetch all matched indicators in parallel
        const results = await Promise.all(
            matches.map(async (entry) => {
                const data = await entry.fetcher();
                return entry.formatter(data);
            })
        );

        const formatted = results.filter(r => r.length > 0);
        if (formatted.length === 0) return '';

        return `\n## Economic Data (FRED)\n${formatted.join('\n\n')}\n`;
    } catch (e) {
        console.error('FRED getEconomicContext error:', e.message);
        return '';
    }
}
