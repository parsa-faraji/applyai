/**
 * Simple local dev server — no Vercel CLI needed.
 * Serves static files + routes /api/* to serverless functions.
 *
 * Usage: node server.js
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const MIME = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // API routes — dynamically import the handler
    if (url.pathname.startsWith('/api/')) {
        const handlerPath = path.join(__dirname, url.pathname + '.js');
        try {
            if (!fs.existsSync(handlerPath)) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'API route not found' }));
            }

            // Build req-like object with query, body, headers
            const mod = await import(handlerPath + '?t=' + Date.now());
            const handler = mod.default;

            // Parse query string
            req.query = Object.fromEntries(url.searchParams);

            // Parse body for POST
            if (req.method === 'POST' || req.method === 'PUT') {
                req.body = await parseBody(req);
            }

            // Shim res.status().json()
            const origWriteHead = res.writeHead.bind(res);
            res.status = (code) => {
                res.statusCode = code;
                return {
                    json: (data) => {
                        res.writeHead(code, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(data));
                    },
                    end: (data) => {
                        res.writeHead(code);
                        res.end(data);
                    },
                };
            };
            // Also shim res.json directly
            res.json = (data) => {
                if (!res.headersSent) res.writeHead(res.statusCode || 200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(data));
            };

            await handler(req, res);
        } catch (err) {
            console.error(`API error [${url.pathname}]:`, err);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        }
        return;
    }

    // Static files
    let filePath = path.join(__dirname, url.pathname === '/' ? 'index.html' : url.pathname);

    if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        return res.end('Not found');
    }

    const ext = path.extname(filePath);
    const contentType = MIME[ext] || 'application/octet-stream';
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
});

function parseBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch { resolve({}); }
        });
    });
}

server.listen(PORT, () => {
    console.log(`\n  Prediction Bot running at http://localhost:${PORT}\n`);
    console.log('  Steps:');
    console.log('  1. Open the URL above in your browser');
    console.log('  2. Go to Settings tab');
    console.log('  3. Select "Kalshi" as your exchange');
    console.log('  4. Paste your Anthropic key (sk-ant-...)');
    console.log('  5. Paste your Kalshi API Key ID');
    console.log('  6. Paste your Kalshi private key (PEM)');
    console.log('  7. Set budget, click Save');
    console.log('  8. Go to Bot tab, click "Start Bot"\n');
});
