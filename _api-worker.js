/**
 * API worker — runs a serverless handler in a fresh Node process.
 * Receives request data via IPC, sends response back via IPC.
 * Each invocation = fresh module graph, no caching issues.
 */

process.on('message', async (msg) => {
    const { handlerPath, method, headers, query, body } = msg;

    try {
        const mod = await import(handlerPath);
        const handler = mod.default;

        // Build req-like object
        const req = { method, headers, query, body };

        // Capture the response
        let statusCode = 200;
        let responseHeaders = { 'Content-Type': 'application/json' };
        let responseBody = '';

        const res = {
            setHeader(key, val) { responseHeaders[key] = val; },
            writeHead(code, hdrs) { statusCode = code; if (hdrs) Object.assign(responseHeaders, hdrs); },
            statusCode: 200,
            headersSent: false,
            status(code) {
                statusCode = code;
                return {
                    json(data) {
                        responseHeaders['Content-Type'] = 'application/json';
                        responseBody = JSON.stringify(data);
                    },
                    end(data) {
                        responseBody = data || '';
                    },
                };
            },
            json(data) {
                responseHeaders['Content-Type'] = 'application/json';
                responseBody = JSON.stringify(data);
            },
            end(data) {
                if (data) responseBody = data;
            },
        };

        await handler(req, res);

        process.send({ statusCode, headers: responseHeaders, body: responseBody });
    } catch (err) {
        process.send({ error: err.message, statusCode: 500 });
    }
});
