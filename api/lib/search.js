/**
 * Web search for real-time news context
 *
 * Tries multiple free/cheap sources to find recent news about a prediction
 * market topic. Used to give Claude real-time context before analysis.
 *
 * Priority:
 * 1. Brave Search API (if BRAVE_API_KEY set)
 * 2. Google Custom Search (if GOOGLE_SEARCH_KEY + GOOGLE_CX set)
 * 3. Polymarket community search (always available, no key needed)
 * 4. Fallback: empty results (Claude analyzes without news)
 */

const MAX_RESULTS = 5;

/**
 * Search for recent news about a market topic
 * @param {string} query - search query (usually the market question)
 * @param {object} keys - { braveKey, googleKey, googleCx }
 * @returns {object} { headlines: string[], sources: string[], raw: object[] }
 */
export async function searchNews(query, keys = {}) {
    // Clean the query: remove "Will", question marks, etc. for better results
    const cleanQuery = query
        .replace(/^(Will|Does|Is|Are|Has|Have|Did|Can|Should)\s+/i, '')
        .replace(/\?/g, '')
        .replace(/before\s+\w+\s+\d+,?\s*\d*/i, '') // remove date constraints
        .trim();

    const results = { headlines: [], sources: [], snippets: [], timestamp: new Date().toISOString() };

    // Try Brave Search first
    if (keys.braveKey) {
        try {
            const braveResults = await searchBrave(cleanQuery, keys.braveKey);
            if (braveResults.length > 0) {
                results.headlines = braveResults.map(r => r.title);
                results.sources = braveResults.map(r => r.source);
                results.snippets = braveResults.map(r => r.snippet);
                results.provider = 'brave';
                return results;
            }
        } catch (e) {
            console.error('Brave search error:', e.message);
        }
    }

    // Try Google Custom Search
    if (keys.googleKey && keys.googleCx) {
        try {
            const googleResults = await searchGoogle(cleanQuery, keys.googleKey, keys.googleCx);
            if (googleResults.length > 0) {
                results.headlines = googleResults.map(r => r.title);
                results.sources = googleResults.map(r => r.source);
                results.snippets = googleResults.map(r => r.snippet);
                results.provider = 'google';
                return results;
            }
        } catch (e) {
            console.error('Google search error:', e.message);
        }
    }

    // Fallback: Polymarket's own search for related context
    try {
        const polyResults = await searchPolymarket(cleanQuery);
        if (polyResults.length > 0) {
            results.headlines = polyResults.map(r => r.title);
            results.snippets = polyResults.map(r => r.snippet);
            results.provider = 'polymarket_related';
            return results;
        }
    } catch (e) {
        console.error('Polymarket search error:', e.message);
    }

    results.provider = 'none';
    return results;
}

async function searchBrave(query, apiKey) {
    // Use the query as-is — appending "prediction odds preview" pollutes
    // non-sports markets with market commentary instead of actual news
    const enrichedQuery = query;
    const params = new URLSearchParams({
        q: enrichedQuery,
        count: MAX_RESULTS.toString(),
        freshness: 'pw', // past week — previews come days before events
        text_decorations: 'false',
    });

    const resp = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
        headers: { 'X-Subscription-Token': apiKey, 'Accept': 'application/json' },
    });

    if (!resp.ok) throw new Error(`Brave API ${resp.status}`);
    const data = await resp.json();

    const webResults = (data.web?.results || []).slice(0, MAX_RESULTS).map(r => ({
        title: r.title || '',
        snippet: r.description || '',
        source: r.url ? new URL(r.url).hostname : '',
        age: r.page_age || r.age || '',
    }));

    // Also pull from news results if available
    const newsResults = (data.news?.results || []).slice(0, 3).map(r => ({
        title: r.title || '',
        snippet: r.description || '',
        source: r.meta_url?.hostname || '',
        age: r.age || '',
    }));

    // Combine news first (more timely), then web
    return [...newsResults, ...webResults].slice(0, MAX_RESULTS);
}

async function searchGoogle(query, apiKey, cx) {
    const params = new URLSearchParams({
        key: apiKey,
        cx: cx,
        q: query,
        num: MAX_RESULTS.toString(),
        dateRestrict: 'd2', // last 2 days
        sort: 'date',
    });

    const resp = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`);
    if (!resp.ok) throw new Error(`Google API ${resp.status}`);
    const data = await resp.json();

    return (data.items || []).slice(0, MAX_RESULTS).map(r => ({
        title: r.title || '',
        snippet: r.snippet || '',
        source: r.displayLink || '',
    }));
}

async function searchPolymarket(query) {
    // Use Polymarket's public search to find related markets
    const resp = await fetch(
        `https://gamma-api.polymarket.com/markets?limit=5&active=true&closed=false&order=volume24hr&ascending=false&_q=${encodeURIComponent(query)}`
    );

    if (!resp.ok) return [];
    const markets = await resp.json();

    return markets.slice(0, MAX_RESULTS).map(m => {
        const prices = (() => {
            try {
                const p = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
                return p || [];
            } catch { return []; }
        })();
        const yesPrice = prices[0] ? (parseFloat(prices[0]) * 100).toFixed(0) : '?';

        return {
            title: m.question,
            snippet: `Market: Yes ${yesPrice}¢ | Vol: $${formatNum(m.volume24hr)} | Liq: $${formatNum(m.liquidity)}`,
        };
    });
}

function formatNum(n) {
    const num = parseFloat(n || 0);
    if (num >= 1e6) return (num / 1e6).toFixed(1) + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(0) + 'K';
    return num.toFixed(0);
}
