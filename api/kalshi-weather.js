// Vercel Serverless Function — Kalshi Weather Trading Strategy
// Uses GFS 31-member ensemble + NBM deterministic forecasts from Open-Meteo (free, no auth)
// to find mispriced temperature markets on Kalshi.
// Trades when |model_prob - market_price| > 8%, uses quarter-Kelly sizing with maker orders.

import { getMarkets, getOrderBook, summarizeOrderBook, placeOrder, normalizeMarket } from './lib/kalshi.js';
import { logTrade, logDecision, categorizeMarket } from './lib/trade-logger.js';

export const config = { maxDuration: 60 };

// ─── Weather Station Coordinates ───

const WEATHER_STATIONS = {
    'NYC': { lat: 40.7831, lon: -73.9712, name: 'New York Central Park' },
    'CHI': { lat: 41.7868, lon: -87.7522, name: 'Chicago Midway' },
    'MIA': { lat: 25.7959, lon: -80.2870, name: 'Miami' },
    'LAX': { lat: 33.9425, lon: -118.4081, name: 'Los Angeles' },
    'DEN': { lat: 39.8561, lon: -104.6737, name: 'Denver' },
    'AUS': { lat: 30.1975, lon: -97.6664, name: 'Austin' },
    'ATL': { lat: 33.6407, lon: -84.4277, name: 'Atlanta' },
    'BOS': { lat: 42.3656, lon: -71.0096, name: 'Boston' },
    'PHL': { lat: 39.8721, lon: -75.2411, name: 'Philadelphia' },
    'DCA': { lat: 38.8512, lon: -77.0402, name: 'Washington DC' },
    'DFW': { lat: 32.8998, lon: -97.0403, name: 'Dallas' },
    'MSP': { lat: 44.8848, lon: -93.2223, name: 'Minneapolis' },
    'SEA': { lat: 47.4502, lon: -122.3088, name: 'Seattle' },
    'PHX': { lat: 33.4373, lon: -112.0078, name: 'Phoenix' },
    'SFO': { lat: 37.6213, lon: -122.3790, name: 'San Francisco' },
    'BNA': { lat: 36.1245, lon: -86.6782, name: 'Nashville' },
    'DTW': { lat: 42.2124, lon: -83.3534, name: 'Detroit' },
    'TPA': { lat: 27.9756, lon: -82.5333, name: 'Tampa' },
    'LAS': { lat: 36.0840, lon: -115.1537, name: 'Las Vegas' },
};

// Map ticker suffix → station code
// Kalshi tickers look like KXHIGHNY, KXHIGHCHI, KXHIGHMIA, KXLOWNY, etc.
// The suffix after KXHIGH/KXLOW is a shortened city code.
const TICKER_SUFFIX_TO_STATION = {
    'NY':  'NYC',
    'CHI': 'CHI',
    'MIA': 'MIA',
    'LA':  'LAX',
    'LAX': 'LAX',
    'DEN': 'DEN',
    'AUS': 'AUS',
    'ATL': 'ATL',
    'BOS': 'BOS',
    'PHL': 'PHL',
    'DCA': 'DCA',
    'DC':  'DCA',
    'DFW': 'DFW',
    'DAL': 'DFW',
    'MSP': 'MSP',
    'MIN': 'MSP',
    'SEA': 'SEA',
    'PHX': 'PHX',
    'SFO': 'SFO',
    'SF':  'SFO',
    'BNA': 'BNA',
    'NAS': 'BNA',
    'DTW': 'DTW',
    'DET': 'DTW',
    'TPA': 'TPA',
    'TAM': 'TPA',
    'LAS': 'LAS',
    'LV':  'LAS',
    'VEG': 'LAS',
};

// ─── Ticker Parsing ───

/**
 * Extract the series prefix (KXHIGH or KXLOW) and city suffix from a series ticker.
 * Returns { type: 'high'|'low', citySuffix: string } or null.
 */
function parseSeriesTicker(seriesTicker) {
    if (!seriesTicker) return null;
    const upper = seriesTicker.toUpperCase();
    let type, citySuffix;
    if (upper.startsWith('KXHIGH')) {
        type = 'high';
        citySuffix = upper.slice('KXHIGH'.length);
    } else if (upper.startsWith('KXLOW')) {
        type = 'low';
        citySuffix = upper.slice('KXLOW'.length);
    } else {
        return null;
    }
    if (!citySuffix) return null;
    return { type, citySuffix };
}

/**
 * Resolve a ticker city suffix to a weather station.
 */
function resolveStation(citySuffix) {
    const key = citySuffix.toUpperCase();
    const stationCode = TICKER_SUFFIX_TO_STATION[key];
    if (stationCode && WEATHER_STATIONS[stationCode]) {
        return { code: stationCode, ...WEATHER_STATIONS[stationCode] };
    }
    // Fuzzy fallback: try matching against station codes directly
    if (WEATHER_STATIONS[key]) {
        return { code: key, ...WEATHER_STATIONS[key] };
    }
    return null;
}

/**
 * Extract the temperature threshold from a market title.
 * e.g. "Will the high temperature in New York City be 58°F or above?" → 58
 * e.g. "Will the low temperature in Chicago be 22°F or below?" → 22
 */
function extractThreshold(title) {
    if (!title) return null;
    // Match patterns like "58°F", "58 °F", "58°", "58 degrees"
    const match = title.match(/(\d+)\s*°\s*F/i) || title.match(/(\d+)\s*degrees/i);
    if (match) return parseInt(match[1], 10);
    return null;
}

/**
 * Determine the direction: "above" means YES if temp >= threshold, "below" means YES if temp <= threshold.
 */
function extractDirection(title) {
    if (!title) return 'above'; // default for KXHIGH
    const lower = title.toLowerCase();
    if (lower.includes('or above') || lower.includes('above') || lower.includes('at least') || lower.includes('or higher') || lower.includes('or more')) {
        return 'above';
    }
    if (lower.includes('or below') || lower.includes('below') || lower.includes('at most') || lower.includes('or lower') || lower.includes('or less')) {
        return 'below';
    }
    return 'above'; // default for high temp markets
}

/**
 * Extract the target date from the market close time or title.
 * Markets resolve based on the date in their title or their close time.
 */
function extractTargetDate(market) {
    // Try close_time / expiration_time first
    const closeTime = market.close_time || market.expiration_time || market.expected_expiration_time;
    if (closeTime) {
        const d = new Date(closeTime);
        // The market resolves on this date — format as YYYY-MM-DD
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
    return null;
}

// ─── Forecast Fetching ───

/**
 * Fetch GFS 31-member ensemble forecast from Open-Meteo.
 * Returns an array of 31 temperature values (°F) for the given date, or null on error.
 */
async function fetchEnsembleForecast(lat, lon, date, tempField) {
    const url = `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${lat}&longitude=${lon}&daily=${tempField}&models=gfs_025_ensemble&temperature_unit=fahrenheit&timezone=auto&start_date=${date}&end_date=${date}`;
    try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        const data = await resp.json();
        // Ensemble response: data.daily[tempField] is an array of arrays
        // or data.daily[tempField] is a flat array with one value per member.
        // Open-Meteo ensemble returns: daily.temperature_2m_max = [val1, val2, ..., val31]
        // when there's a single date, it may be nested under models.
        // The actual format: data.daily has keys like "temperature_2m_max_member01", etc.
        // OR for the ensemble endpoint: data.daily.temperature_2m_max is an array of 31 values.

        const daily = data.daily;
        if (!daily) return null;

        // The ensemble endpoint returns one key per member: temperature_2m_max_member01, etc.
        // OR it returns the field directly as an array when all members share the same key.
        // Let's handle both patterns.
        const memberValues = [];

        // Pattern 1: direct array (all members in one key)
        if (Array.isArray(daily[tempField]) && daily[tempField].length > 1) {
            return daily[tempField].filter(v => v !== null && v !== undefined);
        }

        // Pattern 2: separate member keys (temperature_2m_max_member01, etc.)
        for (const key of Object.keys(daily)) {
            if (key.startsWith(tempField) && key.includes('member')) {
                const vals = daily[key];
                if (Array.isArray(vals) && vals.length > 0 && vals[0] !== null) {
                    memberValues.push(vals[0]);
                }
            }
        }

        if (memberValues.length > 0) return memberValues;

        // Pattern 3: single value array (fallback — only 1 member found)
        if (Array.isArray(daily[tempField]) && daily[tempField].length === 1) {
            return daily[tempField];
        }

        return null;
    } catch {
        return null;
    }
}

/**
 * Fetch NBM deterministic forecast from Open-Meteo.
 * Returns a single temperature value (°F) or null on error.
 */
async function fetchNBMForecast(lat, lon, date, tempField) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=${tempField}&models=nbm_conus&temperature_unit=fahrenheit&timezone=auto&start_date=${date}&end_date=${date}`;
    try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        const data = await resp.json();
        const daily = data.daily;
        if (!daily || !Array.isArray(daily[tempField]) || daily[tempField].length === 0) return null;
        return daily[tempField][0];
    } catch {
        return null;
    }
}

// ─── Probability Calculation ───

/**
 * Calculate the probability that the temperature will meet the threshold condition.
 * @param {number[]} ensembleTemps - Array of ensemble member temperatures
 * @param {number|null} nbmTemp - NBM deterministic forecast temperature
 * @param {number} threshold - Temperature threshold
 * @param {string} direction - 'above' or 'below'
 * @returns {number} probability between 0 and 1
 */
function calculateProbability(ensembleTemps, nbmTemp, threshold, direction) {
    if (!ensembleTemps || ensembleTemps.length === 0) return null;

    // Count ensemble members that satisfy the condition
    let count;
    if (direction === 'above') {
        count = ensembleTemps.filter(t => t >= threshold).length;
    } else {
        count = ensembleTemps.filter(t => t <= threshold).length;
    }
    const ensembleProb = count / ensembleTemps.length;

    // If NBM is available, blend: 60% ensemble, 40% NBM (NBM is often more accurate short-range)
    if (nbmTemp !== null && nbmTemp !== undefined) {
        let nbmProb;
        // NBM is a point forecast — convert to probability using a simple Gaussian spread
        // Typical forecast error std dev is ~3°F for day 1-3, ~5°F for day 4-7
        const stdDev = 3.5; // reasonable default
        const diff = direction === 'above' ? (nbmTemp - threshold) : (threshold - nbmTemp);
        // Approximate Gaussian CDF using logistic approximation
        nbmProb = 1 / (1 + Math.exp(-1.7 * diff / stdDev));

        // Blend ensemble and NBM
        return 0.6 * ensembleProb + 0.4 * nbmProb;
    }

    return ensembleProb;
}

// ─── Main Handler ───

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Kalshi-Key-Id, X-Kalshi-Private-Key');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const {
        budget = 50,
        maxPerTrade = 10,
        dryRun = true,
        marketLimit = 10,
    } = req.body || {};

    const kalshiKeyId = req.headers['x-kalshi-key-id'] || process.env.KALSHI_API_KEY_ID;
    const kalshiPrivateKey = req.headers['x-kalshi-private-key'] || process.env.KALSHI_PRIVATE_KEY;
    const hasLiveCreds = !!(kalshiKeyId && kalshiPrivateKey);

    const report = {
        timestamp: new Date().toISOString(),
        strategy: 'weather',
        exchange: 'kalshi',
        marketsScanned: 0,
        candidates: 0,
        tradesExecuted: 0,
        totalSpent: 0,
        dryRun,
        hasLiveCreds,
        analyses: [],
        trades: [],
        errors: [],
    };

    try {
        // 1. Fetch weather markets from Kalshi
        //    Query multiple weather series: KXHIGH* and KXLOW*
        const weatherPrefixes = ['KXHIGH', 'KXLOW'];
        let allWeatherMarkets = [];

        for (const prefix of weatherPrefixes) {
            try {
                // Fetch markets with series_ticker prefix — paginate to get all
                let cursor = '';
                for (let page = 0; page < 3; page++) {
                    const params = {
                        series_ticker: prefix,
                        status: 'open',
                        limit: 200,
                    };
                    if (cursor) params.cursor = cursor;
                    const data = await getMarkets(params);
                    const batch = data.markets || [];
                    allWeatherMarkets.push(...batch);
                    cursor = data.cursor || '';
                    if (batch.length < 200 || !cursor) break;
                }
            } catch (err) {
                report.errors.push({ market: `fetch_${prefix}`, error: err.message });
            }
        }

        report.marketsScanned = allWeatherMarkets.length;

        // 2. Filter to tradeable markets with parseable info
        const candidates = [];
        for (const rawMarket of allWeatherMarkets) {
            const seriesTicker = rawMarket.series_ticker || rawMarket.event_ticker || rawMarket.ticker || '';
            const parsed = parseSeriesTicker(seriesTicker);
            if (!parsed) {
                // Also try parsing from ticker directly if series_ticker didn't work
                const altParsed = parseSeriesTicker(rawMarket.ticker);
                if (!altParsed) continue;
                Object.assign(parsed || {}, altParsed);
            }

            const station = resolveStation(parsed.citySuffix);
            if (!station) continue;

            const title = rawMarket.title || '';
            const threshold = extractThreshold(title);
            if (threshold === null) continue;

            const targetDate = extractTargetDate(rawMarket);
            if (!targetDate) continue;

            // Skip markets that have already expired or are too far out
            const daysOut = (new Date(targetDate) - new Date()) / (1000 * 60 * 60 * 24);
            if (daysOut < -0.5 || daysOut > 10) continue; // only trade 0-10 days out

            candidates.push({
                rawMarket,
                station,
                threshold,
                targetDate,
                direction: parsed.type === 'low' ? extractDirection(title) : extractDirection(title),
                tempField: parsed.type === 'high' ? 'temperature_2m_max' : 'temperature_2m_min',
                seriesType: parsed.type,
            });
        }

        report.candidates = candidates.length;

        // Limit analysis count
        const toAnalyze = candidates.slice(0, parseInt(marketLimit));
        let budgetLeft = budget;

        for (const candidate of toAnalyze) {
            if (budgetLeft < 1) break;

            const { rawMarket, station, threshold, targetDate, direction, tempField } = candidate;
            const market = normalizeMarket(rawMarket);

            try {
                // 3. Fetch ensemble + NBM forecasts in parallel
                const [ensembleTemps, nbmTemp, obData] = await Promise.all([
                    fetchEnsembleForecast(station.lat, station.lon, targetDate, tempField),
                    fetchNBMForecast(station.lat, station.lon, targetDate, tempField),
                    getOrderBook(rawMarket.ticker).catch(() => null),
                ]);

                if (!ensembleTemps || ensembleTemps.length === 0) {
                    report.errors.push({
                        ticker: rawMarket.ticker,
                        error: `No ensemble forecast data for ${station.name} on ${targetDate}`,
                    });
                    continue;
                }

                const ob = obData ? summarizeOrderBook(obData) : null;

                // 4. Calculate model probability
                const modelProb = calculateProbability(ensembleTemps, nbmTemp, threshold, direction);
                if (modelProb === null) continue;

                // 5. Get market price (YES price represents market's implied probability)
                const yesPriceDollars = parseFloat(rawMarket.last_price_dollars)
                    || parseFloat(rawMarket.yes_bid_dollars)
                    || null;
                if (yesPriceDollars === null) continue;
                const marketProb = yesPriceDollars;

                // Ensemble statistics for logging
                const ensembleMean = ensembleTemps.reduce((a, b) => a + b, 0) / ensembleTemps.length;
                const ensembleMin = Math.min(...ensembleTemps);
                const ensembleMax = Math.max(...ensembleTemps);

                const edge = modelProb - marketProb; // positive = model thinks YES is underpriced
                const absEdge = Math.abs(edge);

                const category = categorizeMarket(rawMarket.ticker, market.question);
                const analysisRecord = {
                    market: market.question,
                    ticker: rawMarket.ticker,
                    category,
                    station: station.name,
                    targetDate,
                    threshold,
                    direction,
                    ensembleMembers: ensembleTemps.length,
                    ensembleMean: parseFloat(ensembleMean.toFixed(1)),
                    ensembleMin: parseFloat(ensembleMin.toFixed(1)),
                    ensembleMax: parseFloat(ensembleMax.toFixed(1)),
                    nbmTemp: nbmTemp !== null ? parseFloat(nbmTemp.toFixed(1)) : null,
                    modelProb: parseFloat(modelProb.toFixed(3)),
                    marketProb: parseFloat(marketProb.toFixed(3)),
                    edge: parseFloat(edge.toFixed(3)),
                    absEdge: parseFloat(absEdge.toFixed(3)),
                    passed: false,
                };

                // 6. Only trade if edge > 8%
                if (absEdge <= 0.08) {
                    analysisRecord.skipReason = `Edge ${(absEdge * 100).toFixed(1)}% <= 8% threshold`;
                    report.analyses.push(analysisRecord);
                    try {
                        logDecision({
                            strategy: 'weather',
                            ticker: rawMarket.ticker,
                            category,
                            market: market.question,
                            action: 'SKIP',
                            modelProb,
                            marketProb,
                            edge,
                            reason: analysisRecord.skipReason,
                        });
                    } catch {}
                    continue;
                }

                analysisRecord.passed = true;
                report.analyses.push(analysisRecord);

                // 7. Determine trade side and price
                //    edge > 0 → model thinks YES is underpriced → BUY YES
                //    edge < 0 → model thinks NO is underpriced → BUY NO
                let side, orderPriceCents;

                if (edge > 0) {
                    // Buy YES — undercut best YES ask by 1 cent (maker order)
                    side = 'yes';
                    if (ob && ob.bestYesAsk != null) {
                        orderPriceCents = ob.bestYesAsk - 1;
                    } else {
                        orderPriceCents = Math.round(marketProb * 100);
                    }
                } else {
                    // Buy NO — undercut best NO ask by 1 cent
                    side = 'no';
                    const noMarketProb = 1 - marketProb;
                    if (ob && ob.bestNoBid != null) {
                        // NO ask = 100 - best YES bid
                        const bestNoAskCents = ob.bestYesBid != null ? (100 - ob.bestYesBid) : Math.round(noMarketProb * 100);
                        orderPriceCents = bestNoAskCents - 1;
                    } else {
                        orderPriceCents = Math.round(noMarketProb * 100);
                    }
                }

                if (orderPriceCents < 1 || orderPriceCents > 99) continue;

                // 8. Quarter-Kelly sizing
                const winProb = side === 'yes' ? modelProb : (1 - modelProb);
                const loseProb = 1 - winProb;
                const costProb = orderPriceCents / 100;
                const b = costProb > 0 && costProb < 1 ? (1 / costProb - 1) : 1;
                const kelly = b > 0 ? (winProb * b - loseProb) / b : 0;
                const quarterKelly = Math.max(0, kelly) * 0.25;
                const positionDollars = Math.min(quarterKelly * budgetLeft, maxPerTrade);

                if (positionDollars < 0.50) continue; // minimum viable trade

                const contracts = Math.max(1, Math.floor((positionDollars * 100) / orderPriceCents));
                const costDollars = (contracts * orderPriceCents) / 100;

                if (costDollars > budgetLeft) continue;

                // 9. Execute the trade
                const trade = await executeTrade({
                    ticker: rawMarket.ticker,
                    side,
                    count: contracts,
                    priceCents: orderPriceCents,
                    market,
                    hasLiveCreds,
                    dryRun,
                    kalshiKeyId,
                    kalshiPrivateKey,
                    reasoning: `${station.name} ${targetDate}: ensemble=${ensembleMean.toFixed(1)}F (${ensembleTemps.length} members), NBM=${nbmTemp?.toFixed(1) || 'N/A'}F, threshold=${threshold}F ${direction}, model=${(modelProb * 100).toFixed(0)}% vs market=${(marketProb * 100).toFixed(0)}%`,
                    edge,
                    modelProb,
                    marketProb,
                });

                trade.category = category;
                try { logTrade(trade); } catch {}

                report.trades.push(trade);
                report.tradesExecuted++;
                report.totalSpent += costDollars;
                budgetLeft -= costDollars;

            } catch (err) {
                report.errors.push({ ticker: rawMarket.ticker, market: market.question, error: err.message });
            }
        }

    } catch (err) {
        report.errors.push({ market: 'fetch_markets', error: err.message });
    }

    return res.status(200).json(report);
}

// ─── Trade Execution ───

async function executeTrade(params) {
    const {
        ticker, side, count, priceCents, market,
        hasLiveCreds, dryRun,
        kalshiKeyId, kalshiPrivateKey,
        reasoning, edge, modelProb, marketProb,
    } = params;

    const costDollars = (count * priceCents) / 100;

    const tradeRecord = {
        id: `weather_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        ticker,
        side,
        action: 'buy',
        type: 'limit',
        count,
        price: priceCents / 100,
        cost: costDollars,
        outcome: side === 'yes' ? 'Yes' : 'No',
        amount: costDollars,
        shares: count,
        marketId: ticker,
        tokenId: ticker,
        market: market.question,
        endDate: market.endDate || null,
        reasoning,
        edge: parseFloat(edge.toFixed(3)),
        modelProb: parseFloat(modelProb.toFixed(3)),
        marketProb: parseFloat(marketProb.toFixed(3)),
        exchange: 'kalshi',
        timestamp: new Date().toISOString(),
        auto: true,
        strategy: 'weather',
    };

    if (dryRun || !hasLiveCreds) {
        tradeRecord.paper = true;
        tradeRecord.status = 'resting';
        return tradeRecord;
    }

    try {
        const privateKeyPem = decodeKey(kalshiPrivateKey);
        const orderParams = {
            ticker,
            side,
            action: 'buy',
            count,
            type: 'limit',
        };

        // Set price on the correct side
        if (side === 'yes') {
            orderParams.yes_price = priceCents;
        } else {
            orderParams.no_price = priceCents;
        }

        const result = await placeOrder(orderParams, { apiKeyId: kalshiKeyId, privateKeyPem });
        tradeRecord.status = result.order?.status || 'submitted';
        tradeRecord.orderId = result.order?.order_id;
        tradeRecord.live = true;
        return tradeRecord;
    } catch (err) {
        tradeRecord.status = 'error';
        tradeRecord.error = err.message;
        return tradeRecord;
    }
}

function decodeKey(key) {
    if (!key) return key;
    if (key.includes('-----BEGIN')) return key;
    try {
        const decoded = Buffer.from(key, 'base64').toString('utf-8');
        if (decoded.includes('-----BEGIN')) return decoded;
    } catch {}
    return key;
}
