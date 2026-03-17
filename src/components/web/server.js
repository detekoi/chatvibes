// src/components/web/server.js
// HTTP server bootstrapper: Express app + static file serving + API router + WebSocket.
// All REST logic lives in apiRoutes.js; all WSS logic lives in webSocket.js.

import http from 'http';
import path from 'path';
import express from 'express';
import { fileURLToPath } from 'url';
import logger from '../../lib/logger.js';

import { createApiRouter, applyCors } from './apiRoutes.js';
import { initializeWebSocketServer, sendAudioToChannel, hasActiveClients } from './webSocket.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 8080;

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();

// Trust the first proxy hop (Cloud Run / GLB) so that req.ip and rate-limiters
// see the real client IP via X-Forwarded-For.
app.set('trust proxy', 1);

// CORS preflight for non-API routes (e.g. the static files themselves)
app.options('*', (req, res) => {
    applyCors(req, res);
    res.status(204).end();
});

// Twitch EventSub webhook — must be registered BEFORE express.json() so the raw
// body is preserved for HMAC signature verification.
app.post('/twitch/event', (req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
        const { eventSubHandler } = await import('../twitch/eventsub.js');
        await eventSubHandler(req, res, Buffer.concat(chunks));
    });
});

// REST API (rate-limited, CORS-enabled, JWT-protected where needed)
app.use('/api', createApiRouter());

// Suppress noisy 404s for common browser icon requests
app.get(['/favicon.ico', '/apple-touch-icon.png', '/apple-touch-icon-precomposed.png'], (_req, res) => {
    res.status(204).end();
});

// Static files — express.static handles MIME types, ETag, 304s, and directory
// traversal prevention automatically, replacing the manual fs.readFile + switch block.
// The /tts-obs alias is handled by mapping it back to the root of PUBLIC_DIR.
app.use('/tts-obs', express.static(PUBLIC_DIR));
app.use('/', express.static(PUBLIC_DIR));

// Fallback: serve index.html for any unmatched path (SPA-style)
app.use((_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const httpServer = http.createServer(app);

// Let Cloud Run control connection lifecycle rather than Node's built-in timeout
httpServer.setTimeout(0);

// ---------------------------------------------------------------------------
// Exported initialisation function (called by bot.js)
// ---------------------------------------------------------------------------

let initialized = false;

export function initializeWebServer() {
    if (initialized) {
        logger.warn('WildcatTTS Web Server already initialized.');
        // Return the existing public API so callers don't break
        return { server: httpServer, sendAudioToChannel, hasActiveClients };
    }
    initialized = true;

    initializeWebSocketServer(httpServer);

    httpServer.listen(PORT, () => {
        logger.info(`WildcatTTS Web Server (for TTS OBS Source) listening on http://localhost:${PORT}`);
    });

    return { server: httpServer, sendAudioToChannel, hasActiveClients };
}

// Re-export for any consumers that import these directly from server.js
export { sendAudioToChannel, hasActiveClients };