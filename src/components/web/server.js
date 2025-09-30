// src/components/web/server.js
import http from 'http';
import path from 'path';
import fs from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import logger from '../../lib/logger.js';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import config from '../../config/index.js';
import { isChannelAllowed, refreshAllowListOnDemand } from '../../lib/allowList.js';

// Import TTS state management functions
import {
    getTtsState,
    setTtsState,
    addIgnoredUser,
    removeIgnoredUser
} from '../tts/ttsState.js';

// Import Music state management functions
import {
    getMusicState,
    setMusicEnabled,
    setAllowedMusicRoles,
    addIgnoredUserMusic,
    removeIgnoredUserMusic,
    setBitsConfigMusic
} from '../music/musicState.js';

// Import constants for validation
import {
    VALID_EMOTIONS,
    VALID_LANGUAGE_BOOSTS,
    TTS_PITCH_MIN,
    TTS_PITCH_MAX,
    TTS_SPEED_MIN,
    TTS_SPEED_MAX
} from '../tts/ttsConstants.js';

import { getSecretValue } from '../../lib/secretManager.js'; // Import your secret manager helper

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 8080;

let wssInstance = null;
const channelClients = new Map(); // channelName (lowercase) -> Set of WebSocket clients

// --- Security & Utility Enhancements ---

// Enforce a reasonable body size limit to prevent DoS attacks
const MAX_BODY_SIZE = 1048576; // 1 MB

function parseJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > MAX_BODY_SIZE) {
                req.connection.destroy();
                reject(new Error('Payload too large'));
            }
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (error) {
                reject(error);
            }
        });
        req.on('error', reject);
    });
}

const apiRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    // Correctly extract IP when behind a proxy (like Cloud Run)
    keyGenerator: (req) => {
        return req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
    },
});

// CORS helper
function applyCors(req, res) {
    const origin = req.headers.origin;
    const allowedOrigins = new Set([
        'http://localhost:5002',
        'http://127.0.0.1:5002',
        'https://chatvibestts.web.app',
        'https://chatvibestts.firebaseapp.com'
    ]);
    if (origin && allowedOrigins.has(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
        res.setHeader('Access-Control-Allow-Origin', 'https://chatvibestts.web.app');
    }
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
}

// Helper function to send JSON response
function sendJsonResponse(res, statusCode, data, req) {
    if (req) applyCors(req, res);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json'
    });
    res.end(JSON.stringify(data));
}

// Helper function to send error response
function sendErrorResponse(res, statusCode, message, req) {
    sendJsonResponse(res, statusCode, { success: false, error: message }, req);
}

// Helper function to extract channel from URL path
function extractChannelFromPath(url) {
    const parts = url.split('/');
    const channelIndex = parts.indexOf('channel');
    return channelIndex !== -1 && parts[channelIndex + 1] ? parts[channelIndex + 1].toLowerCase() : null;
}

// --- Security Enhancements ---
const JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || config.secrets.jwtSecret;

// Hardened JWT Verification Middleware
async function verifyChannelAccess(req, res, next) {
    const channelName = extractChannelFromPath(req.url);
    if (!channelName) {
        return sendErrorResponse(res, 400, 'Channel name not found in URL path', req);
    }

    // Allow-list enforcement
    if (!isChannelAllowed(channelName)) {
        return sendErrorResponse(res, 403, 'Forbidden: Channel is not allowed to use this service', req);
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return sendErrorResponse(res, 401, 'Authorization token is required', req);
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
        return sendErrorResponse(res, 401, 'Bearer token is missing', req);
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET_KEY, {
            audience: 'chatvibes-api',
            issuer: 'chatvibes-auth'
        });

        if (!decoded?.userLogin) {
            return sendErrorResponse(res, 401, 'Token missing required userLogin claim', req);
        }

        const userLogin = decoded.userLogin.toLowerCase();
        if (userLogin !== channelName) {
            return sendErrorResponse(res, 403, 'Forbidden: You do not have permission to modify this channel', req);
        }

        req.channelName = channelName;
        req.userLogin = userLogin;
        await next(); // Await the next middleware/handler
    } catch (error) {
        logger.error({ err: error }, 'JWT verification failed');
        if (error instanceof jwt.TokenExpiredError) {
            return sendErrorResponse(res, 401, 'Token has expired', req);
        }
        if (error instanceof jwt.JsonWebTokenError) {
            return sendErrorResponse(res, 401, 'Invalid token', req);
        }
        return sendErrorResponse(res, 500, 'Internal server error during token verification', req);
    }
}

// Route handlers for REST API
async function handleApiRequest(req, res) {
    apiRateLimiter(req, res, async () => {
        if (req.method === 'OPTIONS') {
            applyCors(req, res);
            res.writeHead(204);
            res.end();
            return;
        }

        if (req.url.startsWith('/api/voices')) {
            return handleVoicesEndpoint(req, res);
        }

        if (req.url.startsWith('/api/admin/refresh-allowlist')) {
            return handleAllowListRefresh(req, res);
        }

        // All other API endpoints require verification
        await verifyChannelAccess(req, res, async () => {
            const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
            if (pathname.includes('/api/tts/settings')) {
                await handleTtsSettings(req, res, req.channelName, req.method);
            } else if (pathname.includes('/api/tts/ignore')) {
                await handleTtsIgnore(req, res, req.channelName, req.method);
            } else if (pathname.includes('/api/music/settings')) {
                await handleMusicSettings(req, res, req.channelName, req.method);
            } else if (pathname.includes('/api/music/ignore')) {
                await handleMusicIgnore(req, res, req.channelName, req.method);
            } else {
                applyCors(req, res);
                sendErrorResponse(res, 404, 'API endpoint not found', req);
            }
        });
    });
}

// Voices endpoint handler
async function handleVoicesEndpoint(req, res) {
    try {
        // Try to fetch actual voices from TTS service
        const { getAvailableVoices } = await import('../tts/ttsService.js');
        const voiceList = await getAvailableVoices();

        if (voiceList && voiceList.length > 0) {
            const voiceIds = voiceList.map(voice => voice.id || voice);
            sendJsonResponse(res, 200, { success: true, voices: voiceIds }, req);
        } else {
            // Fallback voices if TTS service fails
            const fallbackVoices = [
                'Friendly_Person', 'Professional_Woman', 'Casual_Male', 'Energetic_Youth',
                'Warm_Grandmother', 'Confident_Leader', 'Soothing_Narrator', 'Cheerful_Assistant',
                'Deep_Narrator', 'Bright_Assistant', 'Calm_Guide', 'Energetic_Host'
            ];
            sendJsonResponse(res, 200, { success: true, voices: fallbackVoices });
        }
    } catch (error) {
        logger.error({ err: error }, 'Failed to fetch voices from TTS service');

        // Return fallback voices on error
        const fallbackVoices = [
            'Friendly_Person', 'Professional_Woman', 'Casual_Male', 'Energetic_Youth',
            'Warm_Grandmother', 'Confident_Leader', 'Soothing_Narrator', 'Cheerful_Assistant',
            'Deep_Narrator', 'Bright_Assistant', 'Calm_Guide', 'Energetic_Host'
        ];
        sendJsonResponse(res, 200, { success: true, voices: fallbackVoices }, req);
    }
}

// TTS Settings handlers
async function handleTtsSettings(req, res, channelName, method) {
    if (method === 'GET') {
        const settings = await getTtsState(channelName);
        const payload = {
            ...settings,
            englishNormalization: settings.englishNormalization !== undefined ? settings.englishNormalization : false,
        };
        sendJsonResponse(res, 200, { success: true, settings: payload }, req);
    } else if (method === 'PUT') {
        const body = await parseJsonBody(req);
        const { key, value } = body;

        // Validate the setting
        if (!await validateTtsSetting(key, value)) {
            return sendErrorResponse(res, 400, `Invalid setting: ${key} = ${value}`, req);
        }

        const success = await setTtsState(channelName, key, value);
        if (success) {
            sendJsonResponse(res, 200, { success: true, message: 'Setting updated successfully' }, req);
        } else {
            sendErrorResponse(res, 500, 'Failed to update setting', req);
        }
    } else {
        sendErrorResponse(res, 405, 'Method not allowed', req);
    }
}

// TTS Ignore list handlers
async function handleTtsIgnore(req, res, channelName, method) {
    if (method === 'POST') {
        const body = await parseJsonBody(req);
        const { username } = body;
        if (!username) {
            return sendErrorResponse(res, 400, 'Username required', req);
        }

        const success = await addIgnoredUser(channelName, username);
        if (success) {
            sendJsonResponse(res, 200, { success: true, message: `User ${username} added to ignore list` }, req);
        } else {
            sendErrorResponse(res, 500, 'Failed to add user to ignore list', req);
        }
    } else if (method === 'DELETE') {
        const body = await parseJsonBody(req);
        const { username } = body;
        if (!username) {
            return sendErrorResponse(res, 400, 'Username required', req);
        }

        const success = await removeIgnoredUser(channelName, username);
        if (success) {
            sendJsonResponse(res, 200, { success: true, message: `User ${username} removed from ignore list` }, req);
        } else {
            sendErrorResponse(res, 500, 'Failed to remove user from ignore list', req);
        }
    } else {
        sendErrorResponse(res, 405, 'Method not allowed', req);
    }
}

// Music Settings handlers
async function handleMusicSettings(req, res, channelName, method) {
    if (method === 'GET') {
        const settings = await getMusicState(channelName);
        sendJsonResponse(res, 200, { success: true, settings }, req);
    } else if (method === 'PUT') {
        const body = await parseJsonBody(req);
        const { key, value } = body;

        let success = false;
        if (key === 'enabled') {
            success = await setMusicEnabled(channelName, value);
        } else if (key === 'allowedRoles') {
            success = await setAllowedMusicRoles(channelName, value);
        } else if (key === 'bitsConfig') {
            success = await setBitsConfigMusic(channelName, value);
        } else {
            return sendErrorResponse(res, 400, `Unknown music setting: ${key}`, req);
        }

        if (success) {
            sendJsonResponse(res, 200, { success: true, message: 'Music setting updated successfully' }, req);
        } else {
            sendErrorResponse(res, 500, 'Failed to update music setting', req);
        }
    } else {
        sendErrorResponse(res, 405, 'Method not allowed', req);
    }
}

// Music Ignore list handlers
async function handleMusicIgnore(req, res, channelName, method) {
    if (method === 'POST') {
        const body = await parseJsonBody(req);
        const { username } = body;
        if (!username) {
            return sendErrorResponse(res, 400, 'Username required', req);
        }

        const success = await addIgnoredUserMusic(channelName, username);
        if (success) {
            sendJsonResponse(res, 200, { success: true, message: `User ${username} added to music ignore list` }, req);
        } else {
            sendErrorResponse(res, 500, 'Failed to add user to music ignore list', req);
        }
    } else if (method === 'DELETE') {
        const body = await parseJsonBody(req);
        const { username } = body;
        if (!username) {
            return sendErrorResponse(res, 400, 'Username required', req);
        }

        const success = await removeIgnoredUserMusic(channelName, username);
        if (success) {
            sendJsonResponse(res, 200, { success: true, message: `User ${username} removed from music ignore list` }, req);
        } else {
            sendErrorResponse(res, 500, 'Failed to remove user from ignore list', req);
        }
    } else {
        sendErrorResponse(res, 405, 'Method not allowed', req);
    }
}

// Admin endpoint for refreshing allowlist
async function handleAllowListRefresh(req, res) {
    if (req.method !== 'POST') {
        return sendErrorResponse(res, 405, 'Method not allowed', req);
    }

    try {
        // Simple auth check - require a secret header for basic security
        const authHeader = req.headers['x-admin-secret'];
        const expectedSecret = process.env.ADMIN_REFRESH_SECRET || 'change-me-in-production';
        
        if (!authHeader || authHeader !== expectedSecret) {
            return sendErrorResponse(res, 401, 'Invalid admin credentials', req);
        }

        logger.info('[AllowList] Admin refresh endpoint called');
        await refreshAllowListOnDemand();
        
        sendJsonResponse(res, 200, { 
            success: true, 
            message: 'Allowlist refreshed successfully' 
        });
    } catch (error) {
        logger.error({ err: error }, 'Error refreshing allowlist via admin endpoint');
        sendErrorResponse(res, 500, 'Failed to refresh allowlist', req);
    }
}

// Validation function for TTS settings
async function validateTtsSetting(key, value) {
    switch (key) {
        case 'engineEnabled':
        case 'speakEvents':
        case 'bitsModeEnabled':
        case 'readFullUrls':
        case 'allowViewerPreferences':
            return typeof value === 'boolean';
        case 'englishNormalization':
            return typeof value === 'boolean';
        case 'mode':
            return ['all', 'command', 'bits_points_only'].includes(value);
        case 'ttsPermissionLevel':
            return ['everyone', 'mods'].includes(value);
        case 'emotion':
            return VALID_EMOTIONS.includes(value.toLowerCase());
        case 'languageBoost':
            return VALID_LANGUAGE_BOOSTS.includes(value);
        case 'pitch': {
            const pitch = parseInt(value, 10);
            return !isNaN(pitch) && pitch >= TTS_PITCH_MIN && pitch <= TTS_PITCH_MAX;
        }
        case 'speed': {
            const speed = parseFloat(value);
            return !isNaN(speed) && speed >= TTS_SPEED_MIN && speed <= TTS_SPEED_MAX;
        }
        case 'bitsMinimumAmount': {
            const amount = parseInt(value, 10);
            return !isNaN(amount) && amount >= 0;
        }
        case 'voiceId':
            // Allow any string voice ID - validation will happen in TTS service
            return typeof value === 'string' && value.length > 0;
        default:
            logger.warn(`Unknown TTS setting key: ${key}`);
            return false;
    }
}

const httpServer = http.createServer(async (req, res) => {
    if (!req.url) { // Should not happen, but good to guard
        res.writeHead(400);
        res.end('Bad Request');
        return;
    }

    let requestedPath = req.url.split('?')[0]; // Get only the path part, remove query string

    // Handle API requests
    if (requestedPath.startsWith('/api/')) {
        return await handleApiRequest(req, res);
    }

    // Ignore common browser requests for icons to prevent 404 spam in logs
    if (requestedPath === '/favicon.ico' || requestedPath === '/apple-touch-icon.png' || requestedPath === '/apple-touch-icon-precomposed.png') {
        res.writeHead(204, { 'Content-Type': 'image/x-icon' }); // 204 No Content
        res.end();
        return;
    }

    let staticFilePath = requestedPath;
    // Default to index.html for root or specific OBS path
    if (staticFilePath === '/' || staticFilePath === '' || staticFilePath === '/tts-obs') {
        staticFilePath = '/index.html';
    }

    // If using /tts-obs as a base, strip it for file system lookup
    // This assumes files are directly in public, not in a 'tts-obs' subfolder within public
    const localFilePath = staticFilePath.startsWith('/tts-obs') ? staticFilePath.substring('/tts-obs'.length) : staticFilePath;
    const fullPath = path.join(PUBLIC_DIR, localFilePath);

    // Security: Prevent directory traversal
    if (fullPath.indexOf(PUBLIC_DIR) !== 0) {
        logger.warn(`Web server: Attempted directory traversal: ${req.url}`);
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('403 Forbidden');
        return;
    }

    const ext = path.extname(fullPath);
    let contentType = 'text/html'; // Default
    switch (ext) {
        case '.js': {
            contentType = 'application/javascript';
            break;
        }
        case '.css': {
            contentType = 'text/css';
            break;
        }
        case '.json': {
            contentType = 'application/json';
            break;
        }
        case '.png': {
            contentType = 'image/png';
            break;
        }
        case '.jpg': {
            contentType = 'image/jpeg';
            break;
        }
        // Add more MIME types as needed
    }

    fs.readFile(fullPath, (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') {
                logger.warn(`Web server: 404 Not Found - ${req.url} (resolved to file: ${fullPath})`);
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('404 Not Found');
            } else {
                logger.error({ err, requestedUrl: req.url, filePath: fullPath }, 'Web server: Error reading file');
                res.writeHead(500);
                res.end('500 Internal Server Error');
            }
            return;
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
});

// Disable Node.js HTTP server timeout to let Cloud Run control connection lifecycle
httpServer.setTimeout(0);

export function initializeWebServer() {
    if (wssInstance) {
        logger.warn('ChatVibes TTS WebServer already initialized.');
        return { server: httpServer, wss: wssInstance, sendAudioToChannel };
    }

    wssInstance = new WebSocketServer({ server: httpServer });
    logger.info(`ChatVibes TTS WebSocket Server initialized and attached to HTTP server.`);
    
    // Heartbeat to detect broken connections and keep them alive across proxies
    function heartbeat() {
        this.isAlive = true;
    }
    
    const heartbeatInterval = setInterval(() => {
        wssInstance.clients.forEach((ws) => {
            if (ws.isAlive === false) {
                logger.warn('Terminating stale WebSocket connection.');
                return ws.terminate();
            }
            ws.isAlive = false;
            try {
                ws.ping();
            } catch (err) {
                logger.warn({ err }, 'Error sending WebSocket ping; terminating socket');
                ws.terminate();
            }
        });
    }, 30000);

    wssInstance.on('connection', async (ws, req) => { // Make the handler async
        ws.isAlive = true;
        ws.on('pong', heartbeat);
        let channelName = null;
        let tokenFromUrl = null;

        try {
            const urlObj = new URL(req.url, `http://${req.headers.host}`);
            channelName = urlObj.searchParams.get('channel')?.toLowerCase();
            tokenFromUrl = urlObj.searchParams.get('token'); // This is the persistent OBS token
        } catch (e) {
            logger.error({ err: e, url: req.url }, "Error parsing channel/token from WebSocket URL");
            ws.close(1008, 'Invalid URL format');
            return;
        }

        if (!channelName || !tokenFromUrl) {
            logger.warn(`TTS WebSocket connection rejected: Channel or Token missing from URL.`);
            ws.send(JSON.stringify({ type: 'error', message: 'Channel and token are required.' }));
            ws.close(1008, 'Channel and token required');
            return;
        }

        // Enforce allow-list before any secret lookups
        if (!isChannelAllowed(channelName)) {
            logger.warn({ channel: channelName }, 'Rejecting WS connection: Channel not in allow-list');
            ws.close(1008, 'Channel not allowed');
            return;
        }

        // --- New Token Validation Logic ---
        try {
            const channelConfig = await getTtsState(channelName);
            const secretName = channelConfig?.obsSocketSecretName;

            if (!secretName) {
                logger.error({ channel: channelName }, "Rejecting WS connection: No OBS token secret is configured for this channel.");
                ws.close(1008, 'Configuration error: No token configured');
                return;
            }

            const storedToken = await getSecretValue(secretName);

            if (storedToken && storedToken === tokenFromUrl) {
                logger.info(`WebSocket client authenticated for channel: ${channelName}`);
            } else {
                logger.warn({ channel: channelName }, "Rejecting WS connection: Invalid token provided.");
                ws.close(1008, 'Invalid token');
                return;
            }
        } catch (error) {
            logger.error({ err: error, channel: channelName }, "Error during WebSocket token validation.");
            ws.close(1011, 'Internal server error during authentication');
            return;
        }
        // --- End Validation Logic ---

        if (!channelClients.has(channelName)) {
            channelClients.set(channelName, new Set());
        }
        channelClients.get(channelName).add(ws);
        ws.send(JSON.stringify({ type: 'registered', channel: channelName, message: 'Successfully registered with ChatVibes TTS WebSocket.' }));

        ws.on('message', (message) => {
            try {
                const parsedMessage = JSON.parse(message.toString());
                logger.debug({ channel: channelName, received: parsedMessage }, `Received WebSocket message`);
                if (parsedMessage && parsedMessage.type === 'ping') {
                    // Respond to application-level pings to keep browser clients confident
                    try {
                        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
                    } catch (sendErr) {
                        logger.warn({ err: sendErr, channel: channelName }, 'Failed to send pong response');
                    }
                }
            } catch (e) {
                logger.warn({ channel: channelName, rawMessage: message.toString() }, "Received unparseable WebSocket message from client.");
            }
        });

        ws.on('close', (code, reason) => {
            const reasonStr = reason ? reason.toString() : 'No reason given';
            logger.info(`WebSocket client disconnected for channel: ${channelName}. Code: ${code}, Reason: "${reasonStr}"`);
            const clients = channelClients.get(channelName);
            if (clients) {
                clients.delete(ws);
                if (clients.size === 0) {
                    channelClients.delete(channelName);
                    logger.info(`No more TTS clients for channel: ${channelName}, removing from map.`);
                }
            }
        });

        ws.on('error', (error) => logger.error({ err: error, channel: channelName }, 'WebSocket client error.'));
    });

    httpServer.listen(PORT, () => {
        logger.info(`ChatVibes Web Server (for TTS OBS Source) listening on http://localhost:${PORT}`);
    });

    wssInstance.on('close', () => {
        clearInterval(heartbeatInterval);
    });

    return { server: httpServer, wss: wssInstance, sendAudioToChannel };
}

export function sendAudioToChannel(channelName, audioUrlOrCommand) {
    if (!wssInstance) {
        logger.warn('ChatVibes TTS WebSocket server not initialized. Cannot send audio.');
        return;
    }
    const lowerChannelName = channelName.toLowerCase(); // Ensure consistency
    const clients = channelClients.get(lowerChannelName);

    if (!clients || clients.size === 0) {
        // It's normal for this to happen if OBS source isn't open for that channel.
        // Change to debug if this log is too noisy.
        logger.info(`No active TTS WebSocket clients for channel: ${lowerChannelName}. Audio not sent: ${audioUrlOrCommand.substring(0,50)}`);
        return;
    }

    const messagePayload = {
        type: audioUrlOrCommand === 'STOP_CURRENT_AUDIO' ? 'stopAudio' : 'playAudio',
        url: audioUrlOrCommand !== 'STOP_CURRENT_AUDIO' ? audioUrlOrCommand : undefined,
    };
    const message = JSON.stringify(messagePayload);

    logger.debug(`Sending to ${clients.size} client(s) for channel ${lowerChannelName}: ${message.substring(0,100)}...`);
    clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) { // WebSocket.OPEN (class property)
            ws.send(message);
        } else {
            logger.warn(`TTS WebSocket client for ${lowerChannelName} not open (state: ${ws.readyState}). Message not sent.`);
            // Optionally, remove dead clients here if state indicates permanent closure
        }
    });
}