// src/components/web/server.js
import http from 'http';
import path from 'path';
import fs from 'fs';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import logger from '../../lib/logger.js'; // Path: src/lib/logger.js

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 8080;

let wssInstance = null;
const channelClients = new Map(); // channelName (lowercase) -> Set of WebSocket clients

const httpServer = http.createServer((req, res) => {
    if (!req.url) { // Should not happen, but good to guard
        res.writeHead(400);
        res.end('Bad Request');
        return;
    }

    let requestedPath = req.url.split('?')[0]; // Get only the path part, remove query string

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