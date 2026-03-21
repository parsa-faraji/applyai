/**
 * Simple local dev server — no Vercel CLI needed.
 * Serves static files + routes /api/* to serverless functions.
 *
 * Each API request runs in a forked child process so that module
 * changes are always picked up without restarting the server.
 *
 * Usage: node server.js
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fork } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const WORKER = path.join(__dirname, '_api-worker.js');

const MIME = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
};

/**
 * Prevent path-traversal attacks by resolving the path and ensuring
 * it stays within the project root. Returns null if the path escapes.
 * @param {string} unsafePath - URL pathname (e.g. "/api/../../../etc/passwd")
 * @param {string} suffix - optional suffix to append (e.g. ".js")
 * @returns {string|null} resolved absolute path, or null if it escapes __dirname
 */
function safePath(unsafePath, suffix = '') {
    const resolved = path.resolve(__dirname, '.' + unsafePath + suffix);
    if (!resolved.startsWith(__dirname + path.sep) && resolved !== __dirname) {
        return null;
    }
    return resolved;
}

const MAX_BODY_SIZE = 1024 * 1024; // 1 MB

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // API routes — run handler in a fresh child process (no module cache)
    if (url.pathname.startsWith('/api/')) {
        const handlerPath = safePath(url.pathname, '.js');
        if (!handlerPath || !fs.existsSync(handlerPath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'API route not found' }));
        }

        try {
            const body = (req.method === 'POST' || req.method === 'PUT')
                ? await parseBody(req)
                : {};

            const result = await runInWorker(handlerPath, {
                method: req.method,
                headers: req.headers,
                query: Object.fromEntries(url.searchParams),
                body,
            });

            res.writeHead(result.statusCode || 200, result.headers || { 'Content-Type': 'application/json' });
            res.end(result.body || '');
        } catch (err) {
            console.error(`API error [${url.pathname}]:`, err.message);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Internal server error' }));
            }
        }
        return;
    }

    // Static files — resolve and verify path stays inside project root
    const filePath = safePath(url.pathname === '/' ? '/index.html' : url.pathname);

    if (!filePath || !fs.existsSync(filePath)) {
        res.writeHead(404);
        return res.end('Not found');
    }

    // Only serve known file types; reject dotfiles and other sensitive paths
    const ext = path.extname(filePath);
    if (!MIME[ext]) {
        res.writeHead(403);
        return res.end('Forbidden');
    }

    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] });
    res.end(content);
});

/**
 * Fork a child process to run the API handler with fresh modules.
 */
function runInWorker(handlerPath, reqData) {
    return new Promise((resolve, reject) => {
        const child = fork(WORKER, [], {
            stdio: ['pipe', 'inherit', 'inherit', 'ipc'],
        });

        const timeout = setTimeout(() => {
            child.kill();
            reject(new Error('API handler timed out after 20min'));
        }, 1200000);

        child.on('message', (msg) => {
            clearTimeout(timeout);
            if (msg.error) {
                reject(new Error(msg.error));
            } else {
                resolve(msg);
            }
            child.kill();
        });

        child.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });

        child.on('exit', (code) => {
            clearTimeout(timeout);
            if (code && code !== 0) {
                reject(new Error(`Worker exited with code ${code}`));
            }
        });

        child.send({ handlerPath, ...reqData });
    });
}

function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY_SIZE) {
                req.destroy();
                return reject(new Error('Request body too large'));
            }
            body += chunk;
        });
        req.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch { resolve({}); }
        });
        req.on('error', reject);
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
