/**
 * API worker — runs a serverless handler in a fresh Node process.
 * Receives request data via IPC, sends response back via IPC.
 * Each invocation = fresh module graph, no caching issues.
 */

// Prevent unhandled errors from crashing silently — report them via IPC
process.on('uncaughtException', (err) => {
    try {
        process.send({ error: `Uncaught exception: ${err.message}`, statusCode: 500 });
    } catch {
        // IPC channel may be closed; exit with error code
    }
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    try {
        process.send({ error: `Unhandled rejection: ${msg}`, statusCode: 500 });
    } catch {
        // IPC channel may be closed
    }
    process.exit(1);
});

process.on('message', async (msg) => {
    const { handlerPath, method, headers, query, body } = msg;

    try {
        const mod = await import(handlerPath);
        const handler = mod.default;

        if (typeof handler !== 'function') {
            process.send({ error: 'API module does not export a default function', statusCode: 500 });
            return;
        }

        // Build req-like object
        const req = { method, headers, query, body };

        // Capture the response
        let statusCode = 200;
        let responseHeaders = { 'Content-Type': 'application/json' };
        let responseBody = '';
        let responded = false;

        const markResponded = () => { responded = true; };

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
                        markResponded();
                    },
                    end(data) {
                        responseBody = data || '';
                        markResponded();
                    },
                };
            },
            json(data) {
                responseHeaders['Content-Type'] = 'application/json';
                responseBody = JSON.stringify(data);
                markResponded();
            },
            end(data) {
                if (data) responseBody = data;
                markResponded();
            },
        };

        await handler(req, res);

        // Detect handlers that returned without sending a response
        if (!responded) {
            console.error(`Warning: handler for ${handlerPath} returned without sending a response`);
        }

        process.send({ statusCode, headers: responseHeaders, body: responseBody });
    } catch (err) {
        process.send({ error: err.message, statusCode: 500 });
    }
});
