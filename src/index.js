/**
 * dotenv → remove in production; use env.TIMEZONEDB_KEY from Worker secrets
 * cors() → handle OPTIONS plus Access-Control-Allow-Origin headers manually
 * express.json() → not needed here, because your current routes are GET-only
 * helmet() → not a direct Worker middleware pattern
 * compression() → not something you usually reproduce manually in a basic Worker proxy
 * express-rate-limit → replace later with Cloudflare’s Worker-side Rate Limiting API if you want per-IP/path control
 */

/**
 * https://developers.cloudflare.com/workers/runtime-apis/response/
 * creates a standardized JSON HTTP response with CORS headers.
 * @param {any} data the data to be returned
 * @param {number} [status=200] the status code
 * @param {string} [origin="*"] allowed origin for CORS
 * @returns {Response} A response containing JSON data and CORS headers
 */
function json(data, status = 200, origin = "*") {
    return new Response(JSON.stringify(data), { // actual data
        status,
        headers: {
            "Content-Type": "application/json", // tells client the response is JSON
            "Access-Control-Allow-Origin": origin, // the origins that are allowed to acces this response
            "Access-Control-Allow-Methods": "GET, OPTIONS", // allowed HTTP methods
            "Access-Control-Allow-Headers": "Content-Type" // allowed request headers
        }
    });
}

/**
 * Determines the allowed CORS origin from environment variables.
 * @param {Record<string, any>} env environment variable provided by the worker
 * @returns the allowed CORS origin, defaults to * if none
 */
function getCorsOrigin(env) {
    return env.ALLOWED_ORIGIN;
}

/**
 * Checks if the origin in the header file is whitelisted.
 * @param {Request} request incoming http request
 * @param {Record<string, any>} env environment variable provided by the worker
 * @returns {Boolean} if it is in the whitelisted list
 */
function isAllowedOrigin(request, env) {
    const requestOrigin = request.headers.get("Origin");
    const allowedOrigin = getCorsOrigin(env);
    // https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Sec-Fetch-Site
    const secFetchSite = request.headers.get("Sec-Fetch-Site");

    if (!allowedOrigin) return false;

    // normal exact-origin browser requests
    if (requestOrigin && requestOrigin.trim() === allowedOrigin.trim()) {
        return true;
    }

    // allow extension/background fetches that may omit Origin
    if (!requestOrigin && secFetchSite === "none") {
        return true;
    }

    return false;
}

/**
 * https://developers.cloudflare.com/workers/runtime-apis/request/
 * handles CORS preflight requests or HTTP: OPTIONS requests
 * @param {Request} request incoming http request
 * @param {Record<string, any>} env environment variable provided by the worker
 * @returns {Response} CORS headers ONLY with no content
 */
function handleOptions(request, env) {
    const allowedOrigin = getCorsOrigin(env);

    return new Response(null, {
        status: 204,
        headers: {
            "Access-Control-Allow-Origin": allowedOrigin,
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type"
        }
    });
}

/**
 * wraps fetch with a timeout mechanism
 * @param {string} url the URL to be fetched
 * @param {RequestInit} [options={}] options for outgoing requests (config for outgoing fetch)
 * @param {number} [timeoutMs=5000] total amount of time (in miliseconds) before timing out
 * @returns {Promise<Response>} a promise that resolves to the fetch Response
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
    const controller = new AbortController(); // kill switch for API req
    const timeout = setTimeout(() => controller.abort(), timeoutMs); // limit before timeout

    try {
        return await fetch(url, {
            ...options,
            signal: controller.signal
        });
    } finally {
        clearTimeout(timeout); // stop timeout timer
    }
}

export default {
    // https://developers.cloudflare.com/workers/runtime-apis/handlers/fetch/
    async fetch(request, env) {
        // get permitted CORS origin
        const allowedOrigin = getCorsOrigin(env);
        const isAllowed = isAllowedOrigin(request, env);
        const url = new URL(request.url);

        // permission handshake with browser (CORS preflight)
        if (request.method === "OPTIONS") {
            if (!isAllowed) {
                return json({ error: "Forbidden" }, 403, allowedOrigin);
            }

            return handleOptions(request, env);
        }

        // check for actual get requests
        if (!isAllowed) {
            return json({ error: "Forbidden" }, 403, allowedOrigin);
        }

        // https://developers.cloudflare.com/fundamentals/reference/http-headers/
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";

        // https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
        const { success } = await env.API_RATE_LIMIT.limit({key: `${ip}:${url.pathname}`});

        if (!success) {
            return json({error: `Rate limit exceeded for ${url.pathname}`}, 429, allowedOrigin)
        }

        if (request.method !== "GET") {
            return json({ error: "Method not allowed" }, 405, allowedOrigin);
        }

        const apiKey = env.TIMEZONEDB_KEY;

        if (!apiKey) {
            return json({ error: "Server misconfiguration" }, 500, allowedOrigin);
        }

        try {
        // get location endpoint
        if (url.pathname === "/timezone") {
            const latitude = Number(url.searchParams.get("latitude"));
            const longitude = Number(url.searchParams.get("longitude"));

            if (url.searchParams.get("latitude") === null || url.searchParams.get("longitude") === null) {
                return json({ error: "Missing latitude or longitude" }, 400, allowedOrigin);
            }

            if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
                return json({ error: "Invalid coordinates" }, 400, allowedOrigin);
            }

            if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
                return json({ error: "Coordinates out of range" }, 400, allowedOrigin);
            }

            const upstreamUrl =
                `https://api.timezonedb.com/v2.1/get-time-zone` +
                `?key=${encodeURIComponent(apiKey)}` +
                `&format=json&by=position` +
                `&lat=${encodeURIComponent(latitude)}` +
                `&lng=${encodeURIComponent(longitude)}`;

            const response = await fetchWithTimeout(upstreamUrl);

            if (!response.ok) {
                return json(
                    { error: `External API status: ${response.status}` },
                    502,
                    allowedOrigin
                );
            }

            const data = await response.json();
            return json(data, 200, allowedOrigin);
        }

        // get timezone list endpoint
        else if (url.pathname === "/listtimezones") {
            const upstreamUrl =
                `https://api.timezonedb.com/v2.1/list-time-zone` +
                `?key=${encodeURIComponent(apiKey)}` +
                `&format=json` +
                `&fields=countryCode,countryName,zoneName,gmtOffset,dst,timestamp`;

            const response = await fetchWithTimeout(upstreamUrl);

            if (!response.ok) {
                return json(
                    { error: `External API status: ${response.status}` },
                    502,
                    allowedOrigin
                );
            }

            const data = await response.json();
            return json(data, 200, allowedOrigin);
        }

        return json({ error: "Route not found" }, 404, allowedOrigin);

        } catch (error) {
            if (error?.name === "AbortError") {
                return json(
                    { error: "External API took too long to respond" },
                    504,
                    allowedOrigin
                );
            }

            return json({ error: "Internal server error" }, 500, allowedOrigin);
        }
    }
};
