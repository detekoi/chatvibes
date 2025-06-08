// src/components/web/server.js
import http from 'http';
import path from 'path';
import fs from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import logger from '../../lib/logger.js'; // Path: src/lib/logger.js

// Import TTS state management functions
import { 
    getTtsState, 
    setTtsState,
    addIgnoredUser,
    removeIgnoredUser,
    setChannelDefaultPitch,
    setChannelDefaultSpeed,
    setChannelDefaultEmotion,
    setChannelDefaultLanguage,
    resetChannelDefaultPitch,
    resetChannelDefaultSpeed,
    resetChannelDefaultEmotion,
    resetChannelDefaultLanguage,
    setBitsConfig,
    getBitsConfig,
    resetBitsConfig
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 8080;

let wssInstance = null;
const channelClients = new Map(); // channelName (lowercase) -> Set of WebSocket clients

// Helper function to parse JSON body
function parseJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
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

// Helper function to send JSON response
function sendJsonResponse(res, statusCode, data) {
    res.writeHead(statusCode, { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end(JSON.stringify(data));
}

// Helper function to send error response
function sendErrorResponse(res, statusCode, message) {
    sendJsonResponse(res, statusCode, { success: false, error: message });
}

// Helper function to extract channel from URL path
function extractChannelFromPath(url) {
    const parts = url.split('/');
    const channelIndex = parts.indexOf('channel');
    return channelIndex !== -1 && parts[channelIndex + 1] ? parts[channelIndex + 1].toLowerCase() : null;
}

// Simple channel ownership verification
async function verifyChannelAccess(req, channelName) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return { authorized: false, error: 'Missing authorization header' };
    }

    const token = authHeader.split(' ')[1];
    
    try {
        // In a real implementation, you would:
        // 1. Decode the JWT token from the web UI
        // 2. Verify it's valid and not expired  
        // 3. Extract the user's Twitch username
        // 4. Check if it matches the channelName or if user is a moderator
        
        // For now, we'll do a simple check that the token exists
        // TODO: Implement proper JWT verification with shared secret
        if (!token || token.length < 10) {
            return { authorized: false, error: 'Invalid token' };
        }
        
        // Placeholder: In production, verify JWT and extract username
        // const decodedToken = jwt.verify(token, JWT_SECRET);
        // const username = decodedToken.userLogin;
        // return { authorized: username.toLowerCase() === channelName, username };
        
        // For development: Allow access (remove in production)
        return { authorized: true, username: channelName };
        
    } catch (error) {
        logger.error({ err: error }, 'Token verification failed');
        return { authorized: false, error: 'Token verification failed' };
    }
}

// Route handlers for REST API
async function handleApiRequest(req, res) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname;
    const method = req.method;

    // Handle CORS preflight
    if (method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        });
        res.end();
        return;
    }

    try {
        // Special endpoint for voices (no auth required)
        if (pathname === '/api/voices') {
            return await handleVoicesEndpoint(req, res);
        }

        // Extract channel name from URL
        const channelName = extractChannelFromPath(pathname);
        if (!channelName) {
            return sendErrorResponse(res, 400, 'Channel name required in URL path');
        }

        // Verify user has access to this channel's settings
        const authResult = await verifyChannelAccess(req, channelName);
        if (!authResult.authorized) {
            return sendErrorResponse(res, 401, authResult.error || 'Unauthorized access to channel settings');
        }

        // Route to appropriate handler based on path and method
        if (pathname.includes('/api/tts/settings')) {
            await handleTtsSettings(req, res, channelName, method);
        } else if (pathname.includes('/api/tts/ignore')) {
            await handleTtsIgnore(req, res, channelName, method);
        } else if (pathname.includes('/api/music/settings')) {
            await handleMusicSettings(req, res, channelName, method);
        } else if (pathname.includes('/api/music/ignore')) {
            await handleMusicIgnore(req, res, channelName, method);
        } else {
            sendErrorResponse(res, 404, 'API endpoint not found');
        }
    } catch (error) {
        logger.error({ err: error, url: pathname }, 'API request error');
        sendErrorResponse(res, 500, 'Internal server error');
    }
}

// Voices endpoint handler
async function handleVoicesEndpoint(req, res) {
    try {
        // Try to fetch voices from Replicate or return hardcoded list
        const fallbackVoices = [
            'Friendly_Person', 'Professional_Woman', 'Casual_Male', 'Energetic_Youth',
            'Warm_Grandmother', 'Confident_Leader', 'Soothing_Narrator', 'Cheerful_Assistant',
            'Deep_Narrator', 'Bright_Assistant', 'Calm_Guide', 'Energetic_Host'
        ];
        
        // TODO: Fetch actual voices from TTS service
        sendJsonResponse(res, 200, { success: true, voices: fallbackVoices });
    } catch (error) {
        logger.error({ err: error }, 'Failed to fetch voices');
        sendErrorResponse(res, 500, 'Failed to fetch voices');
    }
}

// TTS Settings handlers
async function handleTtsSettings(req, res, channelName, method) {
    if (method === 'GET') {
        const settings = await getTtsState(channelName);
        sendJsonResponse(res, 200, { success: true, settings });
    } else if (method === 'PUT') {
        const body = await parseJsonBody(req);
        const { key, value } = body;
        
        // Validate the setting
        if (!await validateTtsSetting(key, value)) {
            return sendErrorResponse(res, 400, `Invalid setting: ${key} = ${value}`);
        }
        
        const success = await setTtsState(channelName, key, value);
        if (success) {
            sendJsonResponse(res, 200, { success: true, message: 'Setting updated successfully' });
        } else {
            sendErrorResponse(res, 500, 'Failed to update setting');
        }
    } else {
        sendErrorResponse(res, 405, 'Method not allowed');
    }
}

// TTS Ignore list handlers
async function handleTtsIgnore(req, res, channelName, method) {
    if (method === 'POST') {
        const body = await parseJsonBody(req);
        const { username } = body;
        if (!username) {
            return sendErrorResponse(res, 400, 'Username required');
        }
        
        const success = await addIgnoredUser(channelName, username);
        if (success) {
            sendJsonResponse(res, 200, { success: true, message: `User ${username} added to ignore list` });
        } else {
            sendErrorResponse(res, 500, 'Failed to add user to ignore list');
        }
    } else if (method === 'DELETE') {
        const body = await parseJsonBody(req);
        const { username } = body;
        if (!username) {
            return sendErrorResponse(res, 400, 'Username required');
        }
        
        const success = await removeIgnoredUser(channelName, username);
        if (success) {
            sendJsonResponse(res, 200, { success: true, message: `User ${username} removed from ignore list` });
        } else {
            sendErrorResponse(res, 500, 'Failed to remove user from ignore list');
        }
    } else {
        sendErrorResponse(res, 405, 'Method not allowed');
    }
}

// Music Settings handlers
async function handleMusicSettings(req, res, channelName, method) {
    if (method === 'GET') {
        const settings = await getMusicState(channelName);
        sendJsonResponse(res, 200, { success: true, settings });
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
            return sendErrorResponse(res, 400, `Unknown music setting: ${key}`);
        }
        
        if (success) {
            sendJsonResponse(res, 200, { success: true, message: 'Music setting updated successfully' });
        } else {
            sendErrorResponse(res, 500, 'Failed to update music setting');
        }
    } else {
        sendErrorResponse(res, 405, 'Method not allowed');
    }
}

// Music Ignore list handlers
async function handleMusicIgnore(req, res, channelName, method) {
    if (method === 'POST') {
        const body = await parseJsonBody(req);
        const { username } = body;
        if (!username) {
            return sendErrorResponse(res, 400, 'Username required');
        }
        
        const success = await addIgnoredUserMusic(channelName, username);
        if (success) {
            sendJsonResponse(res, 200, { success: true, message: `User ${username} added to music ignore list` });
        } else {
            sendErrorResponse(res, 500, 'Failed to add user to music ignore list');
        }
    } else if (method === 'DELETE') {
        const body = await parseJsonBody(req);
        const { username } = body;
        if (!username) {
            return sendErrorResponse(res, 400, 'Username required');
        }
        
        const success = await removeIgnoredUserMusic(channelName, username);
        if (success) {
            sendJsonResponse(res, 200, { success: true, message: `User ${username} removed from music ignore list` });
        } else {
            sendErrorResponse(res, 500, 'Failed to remove user from music ignore list');
        }
    } else {
        sendErrorResponse(res, 405, 'Method not allowed');
    }
}

// Validation function for TTS settings
async function validateTtsSetting(key, value) {
    switch (key) {
        case 'engineEnabled':
        case 'speakEvents':
        case 'bitsModeEnabled':
            return typeof value === 'boolean';
        case 'mode':
            return ['all', 'command'].includes(value);
        case 'emotion':
            return VALID_EMOTIONS.includes(value.toLowerCase());
        case 'languageBoost':
            return VALID_LANGUAGE_BOOSTS.includes(value);
        case 'pitch':
            const pitch = parseInt(value, 10);
            return !isNaN(pitch) && pitch >= TTS_PITCH_MIN && pitch <= TTS_PITCH_MAX;
        case 'speed':
            const speed = parseFloat(value);
            return !isNaN(speed) && speed >= TTS_SPEED_MIN && speed <= TTS_SPEED_MAX;
        case 'bitsMinimumAmount':
            const amount = parseInt(value, 10);
            return !isNaN(amount) && amount >= 0;
        default:
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
        case '.js':
            contentType = 'application/javascript';
            break;
        case '.css':
            contentType = 'text/css';
            break;
        case '.json':
            contentType = 'application/json';
            break;
        case '.png':
            contentType = 'image/png';
            break;
        case '.jpg':
            contentType = 'image/jpeg';
            break;
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

export function initializeWebServer() {
    // ... (wssInstance and WebSocket connection logic remains the same as the good version from previous response)
    // Ensure the 'channel' extraction from req.url in wss.on('connection') is robust.
    if (wssInstance) {
        logger.warn('ChatVibes TTS WebServer already initialized.');
        return { server: httpServer, wss: wssInstance, sendAudioToChannel };
    }

    wssInstance = new WebSocketServer({ server: httpServer }); // Attach WebSocket server to HTTP server
    logger.info(`ChatVibes TTS WebSocket Server initialized and attached to HTTP server.`);

    wssInstance.on('connection', (ws, req) => {
        let clientChannelName = 'unknown_channel'; // Default
        try {
            // req.url for WebSocket connection is the path part of the initial HTTP handshake URL
            // e.g., "/?channel=parfaittest"
            if (req.url) {
                const params = new URLSearchParams(req.url.split('?')[1] || '');
                const extractedChannel = params.get('channel')?.toLowerCase();
                if (extractedChannel) {
                    clientChannelName = extractedChannel;
                }
            }
        } catch (e) {
            logger.error({ err: e, url: req.url }, "Error parsing channel from WebSocket connection URL");
        }


        if (clientChannelName === 'unknown_channel' || clientChannelName === 'null' || !clientChannelName) {
            logger.warn(`TTS WebSocket connection attempt with invalid/missing channel identifier (URL: ${req.url}). Terminating.`);
            ws.send(JSON.stringify({ type: 'error', message: 'Channel identifier missing or invalid in WebSocket connection URL.' }));
            ws.terminate();
            return;
        }

        logger.info(`TTS WebSocket client connected for channel: ${clientChannelName}`);

        if (!channelClients.has(clientChannelName)) {
            channelClients.set(clientChannelName, new Set());
        }
        channelClients.get(clientChannelName).add(ws);
        ws.send(JSON.stringify({ type: 'registered', channel: clientChannelName, message: 'Successfully registered with ChatVibes TTS WebSocket.' }));

        ws.on('message', (message) => {
            try {
                const parsedMessage = JSON.parse(message.toString());
                logger.debug({ channel: clientChannelName, received: parsedMessage }, `Received WebSocket message`);
                // Handle client messages if necessary, e.g., confirmation of audio played
                // if (parsedMessage.type === 'audioPlayedConfirmation') { ... }
            } catch (e) {
                logger.warn({ channel: clientChannelName, rawMessage: message.toString() }, "Received unparseable WebSocket message from client.");
            }
        });

        ws.on('close', (code, reason) => {
            const reasonStr = reason ? reason.toString() : 'No reason given';
            logger.info(`TTS WebSocket client disconnected for channel: ${clientChannelName}. Code: ${code}, Reason: "${reasonStr}"`);
            if (channelClients.has(clientChannelName)) {
                channelClients.get(clientChannelName).delete(ws);
                if (channelClients.get(clientChannelName).size === 0) {
                    channelClients.delete(clientChannelName);
                    logger.info(`No more TTS clients for channel: ${clientChannelName}, removing from map.`);
                }
            }
        });

        ws.on('error', (error) => {
            logger.error({ err: error, channel: clientChannelName }, 'TTS WebSocket client error.');
        });
    });

    httpServer.listen(PORT, () => {
        logger.info(`ChatVibes Web Server (for TTS OBS Source) listening on http://localhost:${PORT}`);
    });

    return { server: httpServer, wss: wssInstance, sendAudioToChannel };
}

export function sendAudioToChannel(channelName, audioUrlOrCommand) {
    // ... (sendAudioToChannel logic remains the same as the good version from previous response)
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