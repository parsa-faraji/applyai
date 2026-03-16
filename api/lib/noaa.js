/**
 * NOAA Weather API client
 * https://www.weather.gov/documentation/services-web-api
 *
 * Fetches real weather forecasts and alerts to compare against
 * Kalshi weather markets (temperature, precipitation, storms, etc.).
 *
 * No API key required — just a User-Agent header.
 */

const BASE_URL = 'https://api.weather.gov';
const HEADERS = {
    'User-Agent': 'PredictBot/1.0',
    'Accept': 'application/geo+json',
};

/**
 * Well-known locations for common weather markets.
 * Maps city names / aliases to { lat, lon }.
 */
const KNOWN_LOCATIONS = {
    'new york':       { lat: 40.7128, lon: -74.0060 },
    'nyc':            { lat: 40.7128, lon: -74.0060 },
    'manhattan':      { lat: 40.7128, lon: -74.0060 },
    'los angeles':    { lat: 34.0522, lon: -118.2437 },
    'la':             { lat: 34.0522, lon: -118.2437 },
    'chicago':        { lat: 41.8781, lon: -87.6298 },
    'houston':        { lat: 29.7604, lon: -95.3698 },
    'phoenix':        { lat: 33.4484, lon: -112.0740 },
    'philadelphia':   { lat: 39.9526, lon: -75.1652 },
    'san antonio':    { lat: 29.4241, lon: -98.4936 },
    'san diego':      { lat: 32.7157, lon: -117.1611 },
    'dallas':         { lat: 32.7767, lon: -96.7970 },
    'miami':          { lat: 25.7617, lon: -80.1918 },
    'atlanta':        { lat: 33.7490, lon: -84.3880 },
    'boston':          { lat: 42.3601, lon: -71.0589 },
    'seattle':        { lat: 47.6062, lon: -122.3321 },
    'denver':         { lat: 39.7392, lon: -104.9903 },
    'washington':     { lat: 38.9072, lon: -77.0369 },
    'dc':             { lat: 38.9072, lon: -77.0369 },
    'washington dc':  { lat: 38.9072, lon: -77.0369 },
    'nashville':      { lat: 36.1627, lon: -86.7816 },
    'san francisco':  { lat: 37.7749, lon: -122.4194 },
    'sf':             { lat: 37.7749, lon: -122.4194 },
    'austin':         { lat: 30.2672, lon: -97.7431 },
    'las vegas':      { lat: 36.1699, lon: -115.1398 },
    'detroit':        { lat: 42.3314, lon: -83.0458 },
    'portland':       { lat: 45.5152, lon: -122.6784 },
    'minneapolis':    { lat: 44.9778, lon: -93.2650 },
};

/**
 * US state abbreviations for alert lookups.
 */
const STATE_ABBREVS = {
    'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR',
    'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE',
    'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID',
    'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS',
    'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
    'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS',
    'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV',
    'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york state': 'NY',
    'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK',
    'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
    'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT',
    'vermont': 'VT', 'virginia': 'VA', 'washington state': 'WA', 'west virginia': 'WV',
    'wisconsin': 'WI', 'wyoming': 'WY',
};

/**
 * Resolve a location string to lat/lon coordinates.
 * Uses the known-locations lookup table.
 * @param {string} location - city name or alias
 * @returns {{lat: number, lon: number}|null}
 */
function resolveLocation(location) {
    const key = location.toLowerCase().trim();
    if (KNOWN_LOCATIONS[key]) return KNOWN_LOCATIONS[key];

    // Partial match — check if any known location is contained in the query
    for (const [name, coords] of Object.entries(KNOWN_LOCATIONS)) {
        if (key.includes(name) || name.includes(key)) {
            return coords;
        }
    }
    return null;
}

/**
 * Fetch the weather forecast for a location.
 * Resolves the location to coordinates, then calls /points and /forecast.
 *
 * @param {string} location - city name (e.g. 'Chicago', 'NYC')
 * @returns {Promise<{location: string, periods: Array<{name: string, temperature: number, unit: string, windSpeed: string, shortForecast: string, detailedForecast: string}>}>}
 */
export async function getWeatherForecast(location) {
    try {
        const coords = resolveLocation(location);
        if (!coords) {
            console.error(`NOAA: unknown location "${location}"`);
            return null;
        }

        // Step 1: get the grid point for these coordinates
        const pointsResp = await fetch(
            `${BASE_URL}/points/${coords.lat.toFixed(4)},${coords.lon.toFixed(4)}`,
            { headers: HEADERS }
        );
        if (!pointsResp.ok) {
            throw new Error(`NOAA points API ${pointsResp.status}`);
        }
        const pointsData = await pointsResp.json();

        const forecastUrl = pointsData.properties?.forecast;
        if (!forecastUrl) {
            throw new Error('No forecast URL returned from NOAA points API');
        }

        // Step 2: fetch the actual forecast
        const forecastResp = await fetch(forecastUrl, { headers: HEADERS });
        if (!forecastResp.ok) {
            throw new Error(`NOAA forecast API ${forecastResp.status}`);
        }
        const forecastData = await forecastResp.json();

        const periods = (forecastData.properties?.periods || []).slice(0, 14).map(p => ({
            name: p.name,
            temperature: p.temperature,
            unit: p.temperatureUnit,
            windSpeed: p.windSpeed,
            windDirection: p.windDirection,
            shortForecast: p.shortForecast,
            detailedForecast: p.detailedForecast,
            isDaytime: p.isDaytime,
            probabilityOfPrecipitation: p.probabilityOfPrecipitation?.value ?? null,
        }));

        return {
            location: location,
            gridId: pointsData.properties?.gridId,
            periods,
        };
    } catch (e) {
        console.error('NOAA forecast error:', e.message);
        return null;
    }
}

/**
 * Fetch active weather alerts for a US state.
 *
 * @param {string} state - state name or 2-letter abbreviation (e.g. 'TX', 'Texas')
 * @returns {Promise<Array<{event: string, headline: string, severity: string, description: string, areas: string}>>}
 */
export async function getWeatherAlerts(state) {
    try {
        // Resolve to 2-letter code
        let code = state.toUpperCase().trim();
        if (code.length > 2) {
            code = STATE_ABBREVS[state.toLowerCase().trim()] || '';
        }
        if (code.length !== 2) {
            console.error(`NOAA: cannot resolve state "${state}"`);
            return [];
        }

        const resp = await fetch(
            `${BASE_URL}/alerts/active?area=${code}`,
            { headers: HEADERS }
        );
        if (!resp.ok) {
            throw new Error(`NOAA alerts API ${resp.status}`);
        }
        const data = await resp.json();

        return (data.features || []).map(f => ({
            event: f.properties?.event || '',
            headline: f.properties?.headline || '',
            severity: f.properties?.severity || '',
            certainty: f.properties?.certainty || '',
            description: (f.properties?.description || '').slice(0, 300),
            areas: f.properties?.areaDesc || '',
        }));
    } catch (e) {
        console.error('NOAA alerts error:', e.message);
        return [];
    }
}

/**
 * Given a market question about weather, extract the location and conditions,
 * fetch relevant NOAA data, and return formatted text comparing the forecast
 * to what the market is asking.
 *
 * @param {string} query - the market question (e.g. "Will the high temperature in Chicago exceed 90F on Friday?")
 * @returns {Promise<string>} formatted text for inclusion in a Claude prompt, or '' on failure
 */
export async function getWeatherContext(query) {
    try {
        const q = query.toLowerCase();

        // --- Extract location from query ---
        let matchedLocation = null;
        for (const name of Object.keys(KNOWN_LOCATIONS)) {
            if (q.includes(name)) {
                // Pick the longest matching location name (e.g. "new york" over "la" inside "atlanta")
                if (!matchedLocation || name.length > matchedLocation.length) {
                    matchedLocation = name;
                }
            }
        }

        // --- Extract temperature thresholds ---
        const tempMatch = q.match(/(\d+)\s*°?\s*(f|fahrenheit|c|celsius)?/);
        const thresholdTemp = tempMatch ? parseInt(tempMatch[1], 10) : null;

        // --- Determine what we're checking ---
        const isHighTemp = q.includes('high') || q.includes('above') || q.includes('exceed') || q.includes('over') || q.includes('hotter');
        const isLowTemp = q.includes('low') || q.includes('below') || q.includes('under') || q.includes('colder') || q.includes('freeze');
        const isRain = q.includes('rain') || q.includes('precipitation') || q.includes('shower');
        const isSnow = q.includes('snow') || q.includes('blizzard') || q.includes('ice storm') || q.includes('winter storm');
        const isStorm = q.includes('storm') || q.includes('hurricane') || q.includes('tornado') || q.includes('severe');
        const isAlert = isStorm || q.includes('alert') || q.includes('warning') || q.includes('watch');

        const parts = [];

        // --- Fetch forecast if we have a location ---
        if (matchedLocation) {
            const forecast = await getWeatherForecast(matchedLocation);
            if (forecast && forecast.periods.length > 0) {
                parts.push(`**NOAA Forecast for ${capitalize(matchedLocation)}** (via weather.gov)`);

                // Show relevant periods
                const relevantPeriods = forecast.periods.slice(0, 7);
                for (const p of relevantPeriods) {
                    let line = `- **${p.name}:** ${p.temperature}°${p.unit} — ${p.shortForecast}`;
                    if (p.windSpeed) {
                        line += ` (wind: ${p.windSpeed} ${p.windDirection || ''})`;
                    }
                    if (p.probabilityOfPrecipitation != null) {
                        line += ` | Precip: ${p.probabilityOfPrecipitation}%`;
                    }
                    parts.push(line);
                }

                // --- Compare to market threshold ---
                if (thresholdTemp != null) {
                    const daytimePeriods = forecast.periods.filter(p => p.isDaytime);
                    const nightPeriods = forecast.periods.filter(p => !p.isDaytime);

                    if (isHighTemp && daytimePeriods.length > 0) {
                        const maxTemp = Math.max(...daytimePeriods.map(p => p.temperature));
                        const comparison = maxTemp >= thresholdTemp ? 'MEETS/EXCEEDS' : 'BELOW';
                        parts.push(`\n**Market comparison:** Forecast high of ${maxTemp}°F vs threshold of ${thresholdTemp}°F → ${comparison}`);
                    } else if (isLowTemp && nightPeriods.length > 0) {
                        const minTemp = Math.min(...nightPeriods.map(p => p.temperature));
                        const comparison = minTemp <= thresholdTemp ? 'MEETS/BELOW' : 'ABOVE';
                        parts.push(`\n**Market comparison:** Forecast low of ${minTemp}°F vs threshold of ${thresholdTemp}°F → ${comparison}`);
                    }
                }

                // --- Precipitation summary ---
                if (isRain || isSnow) {
                    const precipPeriods = forecast.periods.filter(
                        p => p.probabilityOfPrecipitation != null && p.probabilityOfPrecipitation > 0
                    );
                    if (precipPeriods.length > 0) {
                        const maxPrecip = Math.max(...precipPeriods.map(p => p.probabilityOfPrecipitation));
                        parts.push(`\n**Precipitation outlook:** Up to ${maxPrecip}% chance in forecast window`);
                    } else {
                        parts.push('\n**Precipitation outlook:** No significant precipitation in forecast');
                    }
                }
            }
        }

        // --- Fetch alerts if relevant ---
        if (isAlert || isStorm) {
            // Try to extract state from the query
            let stateCode = null;
            for (const [name, code] of Object.entries(STATE_ABBREVS)) {
                if (q.includes(name)) {
                    stateCode = code;
                    break;
                }
            }
            // Also check 2-letter codes directly
            if (!stateCode) {
                const codeMatch = q.match(/\b([A-Z]{2})\b/i);
                if (codeMatch) {
                    const candidate = codeMatch[1].toUpperCase();
                    if (Object.values(STATE_ABBREVS).includes(candidate)) {
                        stateCode = candidate;
                    }
                }
            }
            // Fall back to the matched location's likely state
            if (!stateCode && matchedLocation) {
                // A few defaults based on well-known cities
                const cityToState = {
                    'new york': 'NY', 'nyc': 'NY', 'manhattan': 'NY',
                    'los angeles': 'CA', 'la': 'CA', 'san francisco': 'CA', 'sf': 'CA', 'san diego': 'CA',
                    'chicago': 'IL', 'houston': 'TX', 'dallas': 'TX', 'san antonio': 'TX', 'austin': 'TX',
                    'phoenix': 'AZ', 'miami': 'FL', 'atlanta': 'GA', 'boston': 'MA',
                    'seattle': 'WA', 'portland': 'OR', 'denver': 'CO', 'las vegas': 'NV',
                    'detroit': 'MI', 'minneapolis': 'MN', 'nashville': 'TN',
                    'philadelphia': 'PA', 'washington': 'DC', 'dc': 'DC', 'washington dc': 'DC',
                };
                stateCode = cityToState[matchedLocation] || null;
            }

            if (stateCode) {
                const alerts = await getWeatherAlerts(stateCode);
                if (alerts.length > 0) {
                    parts.push(`\n**Active Weather Alerts (${stateCode}):** ${alerts.length} alert(s)`);
                    for (const alert of alerts.slice(0, 5)) {
                        parts.push(`- **${alert.event}** (${alert.severity}) — ${alert.headline}`);
                    }
                } else {
                    parts.push(`\n**Active Weather Alerts (${stateCode}):** None currently active`);
                }
            }
        }

        if (parts.length === 0) return '';
        return `\n## Weather Data (NOAA)\n${parts.join('\n')}\n`;
    } catch (e) {
        console.error('NOAA getWeatherContext error:', e.message);
        return '';
    }
}

/**
 * Capitalize the first letter of each word.
 * @param {string} str
 * @returns {string}
 */
function capitalize(str) {
    return str.replace(/\b\w/g, c => c.toUpperCase());
}
