// src/components/web/webSocket.js
// WebSocket server: channel client tracking, token authentication, and heartbeat.

import { WebSocketServer, WebSocket } from 'ws';
import logger from '../../lib/logger.js';
import { INSTANCE_ID } from '../../lib/instanceId.js';
import { isChannelAllowed, resolveToChannelName } from '../../lib/allowList.js';
import { getTtsState, setTtsState } from '../tts/ttsState.js';
import { getSecretValue } from '../../lib/secretManager.js';
import { getClientIp } from '../../lib/clientIp.js';
import { enqueueMessage } from '../../lib/chatSender.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// channelName (lowercase) -> Set of WebSocket clients
const channelClients = new Map();

// Sentinel accepted by sendAudioToChannel in place of an audio payload.
export const STOP_CURRENT_AUDIO = 'STOP_CURRENT_AUDIO';

// How long before nagging a channel again about an outdated browser source. The
// notice stops for good once the source is refreshed, since a current player
// announces binaryAudio on connect and is never counted as stale again.
const STALE_PLAYER_NOTICE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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
    const resolved = resolveToChannelName(channelName);
    const clients = channelClients.get(resolved);
    return clients != null && clients.size > 0;
}

/**
 * Tell a channel, in chat, that its browser source is running an outdated player.
 *
 * Guarded by a timestamp on the channel config rather than an in-memory flag, so a
 * reconnect, an instance swap or a redeploy does not re-nag. enqueueMessage already
 * returns silently when botRespondsInChat is false, so silent-mode channels are left
 * alone — they keep working via the URL path regardless.
 */
async function notifyStalePlayer(channelName) {
    const state = await getTtsState(channelName);
    const last = state.stalePlayerNoticeAt || 0;
    if (Date.now() - last < STALE_PLAYER_NOTICE_INTERVAL_MS) return;

    // Record before sending: a failed send is far better than a nag loop.
    await setTtsState(channelName, 'stalePlayerNoticeAt', Date.now());

    await enqueueMessage(
        channelName,
        'Heads up: your WildcatTTS browser source is running an outdated version. ' +
        'Right-click the source in OBS and choose Refresh to get noticeably faster audio.'
    );
    logger.info({ channel: channelName }, 'Sent stale-player refresh notice to chat');
}

/**
 * True if any client currently connected for this channel is running a player that
 * cannot accept binary audio frames.
 *
 * The queue calls this *before* generating, so it can ask the provider for a URL
 * instead of inline bytes. That keeps an OBS source on a cached old player working
 * — just without the latency win — rather than going silent. Once every client for
 * the channel has refreshed, the channel returns to the fast inline-bytes path.
 */
export function channelPrefersUrlAudio(channelName) {
    const resolved = resolveToChannelName(channelName);
    const clients = channelClients.get(resolved);
    if (!clients || clients.size === 0) return false;

    for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN && !ws.supportsBinaryAudio) return true;
    }
    return false;
}

/**
 * Describe an audio payload for logging without dumping a whole buffer.
 */
function describePayload(payload) {
    if (payload === STOP_CURRENT_AUDIO) return 'STOP_CURRENT_AUDIO';
    if (payload?.kind === 'buffer') return `${payload.data.length} bytes (${payload.mime})`;
    return String(payload?.url ?? payload).substring(0, 80);
}

/**
 * Send audio or a control command to all connected clients for a channel.
 *
 * `payload` is either the 'STOP_CURRENT_AUDIO' sentinel or a discriminated audio
 * object from generateSpeech: `{kind:'buffer', data, mime}` or `{kind:'url', url}`.
 *
 * Buffers go out as raw binary frames, which is the whole point of the exercise —
 * it keeps the audio on the socket that is already open to the right Cloud Run
 * instance, with no CDN fetch and no instance-affinity problem. Clients that have
 * not announced binary support (an OBS source running a cached older player) fall
 * back to the URL flow so their audio keeps working, and get nudged to refresh.
 */
export function sendAudioToChannel(channelName, payload) {
    const resolved = resolveToChannelName(channelName);
    const clients = channelClients.get(resolved);

    if (!clients || clients.size === 0) {
        logger.info(
            `No active TTS WebSocket clients for channel: ${resolved}. Audio not sent: ${describePayload(payload)}`
        );
        return;
    }

    const isStop = payload === STOP_CURRENT_AUDIO;
    const jsonMessage = isStop
        ? JSON.stringify({ type: 'stopAudio' })
        : payload.kind === 'url'
            ? JSON.stringify({ type: 'playAudio', url: payload.url })
            : null;

    logger.debug(
        `Sending to ${clients.size} client(s) for channel ${resolved}: ${describePayload(payload)}`
    );

    let staleClients = 0;

    clients.forEach(ws => {
        if (ws.readyState !== WebSocket.OPEN) {
            logger.warn(
                `TTS WebSocket client for ${resolved} not open (state: ${ws.readyState}). Message not sent.`
            );
            return;
        }

        if (jsonMessage !== null) {
            ws.send(jsonMessage);
            return;
        }

        if (ws.supportsBinaryAudio) {
            ws.send(payload.data);
        } else {
            // Should be unreachable: channelPrefersUrlAudio makes the queue request a
            // URL from the provider whenever any client here is stale, so a buffer
            // never reaches one. Counted rather than assumed, in case a stale client
            // connects between that check and this send.
            staleClients++;
        }
    });

    if (staleClients > 0) {
        logger.warn(
            { channel: resolved, staleClients },
            'TTS client(s) on an outdated player could not receive binary audio'
        );
        notifyStalePlayer(resolved).catch(err =>
            logger.error({ err, channel: resolved }, 'Failed to send stale-player chat notice')
        );
    }
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * Attach a WebSocketServer to an existing HTTP server and start handling TTS
 * overlay connections.  Returns the WebSocketServer instance.
 */
export function initializeWebSocketServer(httpServer, { onClientConnect } = {}) {
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

        const clientIP = getClientIp(req);

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

        // Assume no binary support until the client says otherwise. Players older
        // than the binary-audio change never send a hello, so absence is the signal.
        ws.supportsBinaryAudio = false;

        // Register client
        if (!channelClients.has(channelName)) {
            channelClients.set(channelName, new Set());
        }
        channelClients.get(channelName).add(ws);

        // Records which instance a browser source landed on. Audio for a channel is
        // only ever sent from the one instance that won the claim for that message,
        // so a channel appearing here under two instances at once means the sources
        // on the losing instance are silent. Group this log by channel over a window
        // to find those: more than one distinct `instance` for a channel is the signal.
        logger.info({
            logKey: 'WS_CLIENT_REGISTERED',
            channel: channelName,
            instance: INSTANCE_ID,
            clientsForChannelHere: channelClients.get(channelName).size,
        }, `WebSocket client registered for channel ${channelName}`);

        if (onClientConnect) onClientConnect(channelName);

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
                } else if (parsedMessage?.type === 'hello') {
                    const features = Array.isArray(parsedMessage.features) ? parsedMessage.features : [];
                    ws.supportsBinaryAudio = features.includes('binaryAudio');
                    logger.debug(
                        { channel: channelName, features },
                        `Client announced features; binary audio ${ws.supportsBinaryAudio ? 'supported' : 'unsupported'}`
                    );
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
