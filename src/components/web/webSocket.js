// src/components/web/webSocket.js
// WebSocket server: channel client tracking, token authentication, and heartbeat.

import { WebSocketServer, WebSocket } from 'ws';
import logger from '../../lib/logger.js';
import { isChannelAllowed } from '../../lib/allowList.js';
import { getTtsState } from '../tts/ttsState.js';
import { getSecretValue } from '../../lib/secretManager.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// channelName (lowercase) -> Set of WebSocket clients
const channelClients = new Map();

// ---------------------------------------------------------------------------
// Auth rate limiting
// ---------------------------------------------------------------------------

const authFailures = new Map(); // clientIP -> { count, lastAttempt }
const MAX_AUTH_FAILURES = 50; // Relaxed for debugging
const AUTH_FAILURE_WINDOW_MS = 60000; // 1 minute
const AUTH_LOCKOUT_MS = 5000; // 5 seconds (relaxed for debugging)

function checkRateLimit(clientIP) {
    const now = Date.now();
    const record = authFailures.get(clientIP);

    if (!record) return { allowed: true };

    if (record.count >= MAX_AUTH_FAILURES) {
        const timeSinceLast = now - record.lastAttempt;
        if (timeSinceLast < AUTH_LOCKOUT_MS) {
            return {
                allowed: false,
                retryAfter: Math.ceil((AUTH_LOCKOUT_MS - timeSinceLast) / 1000),
            };
        }
        // Lockout expired, reset
        authFailures.delete(clientIP);
        return { allowed: true };
    }

    if (now - record.lastAttempt > AUTH_FAILURE_WINDOW_MS) {
        authFailures.delete(clientIP);
        return { allowed: true };
    }

    return { allowed: true };
}

function recordAuthFailure(clientIP) {
    const now = Date.now();
    const record = authFailures.get(clientIP);

    if (!record || now - record.lastAttempt > AUTH_FAILURE_WINDOW_MS) {
        authFailures.set(clientIP, { count: 1, lastAttempt: now });
    } else {
        record.count++;
        record.lastAttempt = now;
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true if the given channel currently has at least one connected
 * WebSocket client (i.e. an active OBS browser source).
 */
export function hasActiveClients(channelName) {
    const lowerChannelName = channelName.toLowerCase();
    const clients = channelClients.get(lowerChannelName);
    return clients != null && clients.size > 0;
}

/**
 * Send an audio URL or a control command to all connected clients for a channel.
 * Pass 'STOP_CURRENT_AUDIO' as audioUrlOrCommand to send a stop signal.
 */
export function sendAudioToChannel(channelName, audioUrlOrCommand) {
    const lowerChannelName = channelName.toLowerCase();
    const clients = channelClients.get(lowerChannelName);

    if (!clients || clients.size === 0) {
        logger.info(
            `No active TTS WebSocket clients for channel: ${lowerChannelName}. Audio not sent: ${audioUrlOrCommand.substring(0, 50)}`
        );
        return;
    }

    const messagePayload = {
        type: audioUrlOrCommand === 'STOP_CURRENT_AUDIO' ? 'stopAudio' : 'playAudio',
        url: audioUrlOrCommand !== 'STOP_CURRENT_AUDIO' ? audioUrlOrCommand : undefined,
    };
    const message = JSON.stringify(messagePayload);

    logger.debug(
        `Sending to ${clients.size} client(s) for channel ${lowerChannelName}: ${message.substring(0, 100)}...`
    );

    clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(message);
        } else {
            logger.warn(
                `TTS WebSocket client for ${lowerChannelName} not open (state: ${ws.readyState}). Message not sent.`
            );
        }
    });
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * Attach a WebSocketServer to an existing HTTP server and start handling TTS
 * overlay connections.  Returns the WebSocketServer instance.
 */
export function initializeWebSocketServer(httpServer) {
    const wss = new WebSocketServer({ server: httpServer });
    logger.info('WildcatTTS TTS WebSocket Server initialized and attached to HTTP server.');

    // Periodically clean up stale auth-failure records
    setInterval(() => {
        const now = Date.now();
        for (const [ip, record] of authFailures.entries()) {
            if (now - record.lastAttempt > AUTH_LOCKOUT_MS) {
                authFailures.delete(ip);
            }
        }
    }, 600000).unref();

    // Heartbeat: detect and evict broken connections, and keep them alive across proxies
    function heartbeat() {
        this.isAlive = true;
    }

    const heartbeatInterval = setInterval(() => {
        wss.clients.forEach(ws => {
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

    wss.on('close', () => clearInterval(heartbeatInterval));

    wss.on('connection', async (ws, req) => {
        ws.isAlive = true;
        ws.on('pong', heartbeat);

        let channelName = null;
        let tokenFromUrl = null;

        const clientIP =
            req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;

        try {
            const urlObj = new URL(req.url, `http://${req.headers.host}`);
            channelName = urlObj.searchParams.get('channel')?.toLowerCase();
            tokenFromUrl = urlObj.searchParams.get('token');
        } catch (e) {
            logger.error({ err: e, url: req.url }, 'Error parsing channel/token from WebSocket URL');
            ws.close(1008, 'Invalid URL format');
            return;
        }

        if (!channelName || !tokenFromUrl) {
            logger.warn('TTS WebSocket connection rejected: Channel or Token missing from URL.');
            ws.send(JSON.stringify({ type: 'error', message: 'Channel and token are required.' }));
            ws.close(1008, 'Channel and token required');
            return;
        }

        // Rate-limit check before any expensive operations
        const rateLimitCheck = checkRateLimit(clientIP);
        if (!rateLimitCheck.allowed) {
            logger.warn(
                { channel: channelName, clientIP, retryAfter: rateLimitCheck.retryAfter },
                'Rate limit exceeded for WebSocket authentication attempts'
            );
            ws.send(JSON.stringify({
                type: 'error',
                message: `Too many failed authentication attempts. Try again in ${rateLimitCheck.retryAfter} seconds.`,
            }));
            ws.close(1008, 'Rate limit exceeded');
            return;
        }

        // Allow-list check
        if (!isChannelAllowed(channelName)) {
            logger.warn({ channel: channelName }, 'Rejecting WS connection: Channel not in allow-list');
            ws.close(1008, 'Channel not allowed');
            recordAuthFailure(clientIP);
            return;
        }

        // Token validation
        try {
            const channelConfig = await getTtsState(channelName);

            // Prefer token stored directly in Firestore; fall back to Secret Manager
            let storedToken = channelConfig?.obsSocketToken;
            let tokenSource = 'firestore';

            if (!storedToken) {
                const secretName = channelConfig?.obsSocketSecretName;
                if (secretName) {
                    logger.debug({ channel: channelName, secretName }, 'Retrieving OBS token from Secret Manager');
                    storedToken = await getSecretValue(secretName);
                    tokenSource = 'secret-manager';

                    if (!storedToken) {
                        logger.error(
                            { channel: channelName, secretName },
                            'Rejecting WS connection: Failed to retrieve token from Secret Manager.'
                        );
                        ws.close(1011, 'Configuration error: Token not found');
                        recordAuthFailure(clientIP);
                        return;
                    }
                }
            }

            if (!storedToken) {
                logger.error(
                    { channel: channelName, configKeys: Object.keys(channelConfig || {}) },
                    'Rejecting WS connection: No OBS token configured (checked Firestore and Secret Manager).'
                );
                ws.close(1008, 'Configuration error: No token configured');
                recordAuthFailure(clientIP);
                return;
            }

            if (storedToken === tokenFromUrl) {
                logger.info(`WebSocket client authenticated for channel: ${channelName} (via ${tokenSource})`);
                authFailures.delete(clientIP); // clear failures on successful auth
            } else {
                logger.warn(
                    {
                        channel: channelName,
                        clientIP,
                        tokenSource,
                        urlTokenLength: tokenFromUrl?.length,
                        storedTokenLength: storedToken?.length,
                        urlTokenPreview: tokenFromUrl?.substring(0, 5),
                        storedTokenPreview: storedToken?.substring(0, 5),
                    },
                    'Rejecting WS connection: Token mismatch.'
                );
                recordAuthFailure(clientIP);
                ws.close(1008, 'Invalid token');
                return;
            }
        } catch (error) {
            logger.error(
                { err: error, channel: channelName, errorMessage: error.message },
                'Error during WebSocket token validation.'
            );
            recordAuthFailure(clientIP);
            ws.close(1011, 'Internal server error during authentication');
            return;
        }

        // Register client
        if (!channelClients.has(channelName)) {
            channelClients.set(channelName, new Set());
        }
        channelClients.get(channelName).add(ws);

        ws.send(JSON.stringify({
            type: 'registered',
            channel: channelName,
            message: 'Successfully registered with WildcatTTS TTS WebSocket.',
        }));

        ws.on('message', message => {
            try {
                const parsedMessage = JSON.parse(message.toString());
                logger.debug({ channel: channelName, received: parsedMessage }, 'Received WebSocket message');
                if (parsedMessage?.type === 'ping') {
                    try {
                        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
                    } catch (sendErr) {
                        logger.warn({ err: sendErr, channel: channelName }, 'Failed to send pong response');
                    }
                }
            } catch {
                logger.warn(
                    { channel: channelName, rawMessage: message.toString() },
                    'Received unparseable WebSocket message from client.'
                );
            }
        });

        ws.on('close', (code, reason) => {
            const reasonStr = reason ? reason.toString() : 'No reason given';
            logger.info(
                `WebSocket client disconnected for channel: ${channelName}. Code: ${code}, Reason: "${reasonStr}"`
            );
            const clients = channelClients.get(channelName);
            if (clients) {
                clients.delete(ws);
                if (clients.size === 0) {
                    channelClients.delete(channelName);
                    logger.info(`No more TTS clients for channel: ${channelName}, removing from map.`);
                }
            }
        });

        ws.on('error', error =>
            logger.error({ err: error, channel: channelName }, 'WebSocket client error.')
        );
    });

    return wss;
}
