// src/components/youtube/ytChatClient.js
// WebSocket client that connects to yt-chat-proxy to receive YouTube live chat
// messages and publish them through the existing TTS pipeline.

import WebSocket from 'ws';
import logger from '../../lib/logger.js';
import { getTtsState, getAllChannelConfigs, onYouTubeConfigChange } from '../tts/ttsState.js';
import { publishTtsEvent } from '../../lib/pubsub.js';
import { processMessageUrls } from '../../lib/urlProcessor.js';
import { replaceEmojisWithText, stripEmojis } from '../../lib/emojiUtils.js';
import { processYouTubeEmotes } from './ytEmoteProcessor.js';

const YT_CHAT_PROXY_URL = process.env.YT_CHAT_PROXY_URL || 'wss://ytchat.wildcat.chat/ws';

// Active connections: channelId -> { ws, youtubeHandle, reconnectTimer, reconnectAttempts }
const activeConnections = new Map();

// Reconnect backoff config
const RECONNECT_DELAYS = [5000, 10000, 30000, 60000]; // 5s, 10s, 30s, 60s cap
const PING_INTERVAL_MS = 30000; // 30s heartbeat to keep Cloud Run CPU active

/**
 * Initialize YouTube chat connections for all channels that have YouTube enabled.
 * Also registers a Firestore listener to react to config changes dynamically.
 * Called from bot.js after TTS state is loaded.
 */
export async function initializeYouTubeChat() {
    logger.info('YouTube Chat: Initializing YouTube chat client...');

    // Register for real-time config changes so connections
    // are created/destroyed as broadcasters toggle YouTube in the dashboard
    onYouTubeConfigChange(handleYouTubeConfigChange);

    const configs = getAllChannelConfigs();
    let connectedCount = 0;

    for (const [channelId, config] of configs) {
        if (config.youtubeEnabled && config.youtubeHandle) {
            connectToYouTubeChat(channelId, config.youtubeHandle);
            connectedCount++;
        }
    }

    logger.info(`YouTube Chat: Initialized ${connectedCount} YouTube chat connection(s)`);
}

/**
 * Connect to yt-chat-proxy for a specific channel's YouTube handle.
 * @param {string} channelId - The Twitch channel ID (Firestore doc key)
 * @param {string} youtubeHandle - YouTube handle (e.g. "@parfaitfair")
 */
export function connectToYouTubeChat(channelId, youtubeHandle) {
    // Normalize handle before comparing to avoid "@foo" vs "foo" mismatches
    const target = youtubeHandle.startsWith('@') ? youtubeHandle : `@${youtubeHandle}`;

    // Clean up existing connection if any
    const existing = activeConnections.get(channelId);
    if (existing) {
        if (existing.youtubeHandle === target && existing.ws?.readyState === WebSocket.OPEN) {
            logger.debug({ channelId, target }, 'YouTube Chat: Already connected to this handle, skipping');
            return;
        }
        disconnectYouTubeChat(channelId);
    }

    logger.info({ channelId, target, proxyUrl: YT_CHAT_PROXY_URL }, 'YouTube Chat: Connecting to yt-chat-proxy');

    const connState = {
        ws: null,
        youtubeHandle: target,
        reconnectTimer: null,
        pingTimer: null,
        reconnectAttempts: 0,
        intentionallyClosed: false,
    };
    activeConnections.set(channelId, connState);

    _connect(channelId, connState);
}

/**
 * Internal: establish the WebSocket connection.
 */
function _connect(channelId, connState) {
    try {
        const ws = new WebSocket(YT_CHAT_PROXY_URL);
        connState.ws = ws;

        ws.on('open', () => {
            logger.info({ channelId, target: connState.youtubeHandle }, 'YouTube Chat: WebSocket connected, sending JOIN');
            connState.reconnectAttempts = 0;

            // Send JOIN message to subscribe to the YouTube channel
            ws.send(JSON.stringify({
                action: 'JOIN',
                target: connState.youtubeHandle,
            }));

            // Start heartbeat to prevent Cloud Run CPU throttling from
            // silently killing the outbound WebSocket connection
            if (connState.pingTimer) clearInterval(connState.pingTimer);
            connState.pingTimer = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.ping();
                }
            }, PING_INTERVAL_MS);
        });

        ws.on('message', async (data) => {
            try {
                const msg = JSON.parse(data.toString());
                await _handleMessage(channelId, msg);
            } catch (err) {
                logger.warn({ err, channelId, rawData: data.toString().substring(0, 200) }, 'YouTube Chat: Failed to parse message');
            }
        });

        ws.on('close', (code, reason) => {
            const reasonStr = reason ? reason.toString() : 'No reason';
            logger.info({ channelId, code, reason: reasonStr }, 'YouTube Chat: WebSocket closed');
            connState.ws = null;

            if (connState.pingTimer) {
                clearInterval(connState.pingTimer);
                connState.pingTimer = null;
            }

            if (!connState.intentionallyClosed) {
                _scheduleReconnect(channelId, connState);
            }
        });

        ws.on('error', (err) => {
            logger.error({ err, channelId }, 'YouTube Chat: WebSocket error');
            // The 'close' event will fire after this, which handles reconnection
        });

        // Respond to server pings (ws library handles this automatically for standard pings)

    } catch (err) {
        logger.error({ err, channelId }, 'YouTube Chat: Failed to create WebSocket');
        _scheduleReconnect(channelId, connState);
    }
}

/**
 * Schedule a reconnection attempt with exponential backoff.
 */
function _scheduleReconnect(channelId, connState) {
    if (connState.intentionallyClosed) return;

    const delayIndex = Math.min(connState.reconnectAttempts, RECONNECT_DELAYS.length - 1);
    const delay = RECONNECT_DELAYS[delayIndex];
    connState.reconnectAttempts++;

    logger.info({ channelId, target: connState.youtubeHandle, delay, attempt: connState.reconnectAttempts },
        'YouTube Chat: Scheduling reconnect');

    connState.reconnectTimer = setTimeout(() => {
        if (connState.intentionallyClosed) return;
        _connect(channelId, connState);
    }, delay);
}

/**
 * Handle incoming messages from yt-chat-proxy.
 * Message format from the proxy (see poller.go normalizeAction):
 *   { type: "message", eventType, username, message, emotes, emoteFragments?, tags, id, channelId, amount?, subtext?, bodyColor?, headerColor? }
 *   { type: "system", status?, message? }
 */
async function _handleMessage(channelId, msg) {
    // System messages (connection status, waiting for stream, etc.)
    if (msg.type === 'system') {
        logger.info({ channelId, status: msg.status, message: msg.message }, 'YouTube Chat: System message');
        return;
    }

    // Only process chat messages
    if (msg.type !== 'message') return;

    const username = msg.username || 'YouTube Viewer';
    const messageText = (msg.message || '').trim();
    const eventType = msg.eventType || 'chat'; // chat, superchat, supersticker, membership

    const hasEmoteFragments = msg.emoteFragments?.length > 0;
    if (!messageText && !hasEmoteFragments && eventType === 'chat') {
        logger.debug({ channelId, username, eventType }, 'YouTube Chat: Empty message, skipping');
        return;
    }

    // Load TTS config for this channel
    const ttsConfig = await getTtsState(channelId);

    if (!ttsConfig.engineEnabled || !ttsConfig.youtubeEnabled) {
        return;
    }

    // Check ignored users (YouTube usernames)
    const lowerUsername = username.toLowerCase();
    if (ttsConfig.ignoredUsers?.includes(lowerUsername)) {
        logger.debug({ channelId, username }, 'YouTube Chat: User is ignored, skipping');
        return;
    }

    // Check banned words
    if (ttsConfig.bannedWords?.length > 0) {
        const lowerMessage = messageText.toLowerCase();
        if (ttsConfig.bannedWords.some(w => lowerMessage.includes(w))) {
            logger.debug({ channelId, username }, 'YouTube Chat: Message contains banned word, skipping');
            return;
        }
    }

    // Resolve emote mode from channel config.
    // YouTube does not currently support per-user emote mode overrides (unlike Twitch).
    const emoteMode = ttsConfig.emoteMode || 'describe';

    logger.debug({ channelId, emoteMode, hasEmoteFragments: !!msg.emoteFragments }, 'YouTube Chat: Emote mode resolved');

    // Processing pipeline: YouTube custom emotes → URLs → Unicode emoji
    let processedText = await processYouTubeEmotes(
        messageText, msg.emoteFragments || null, emoteMode, emoteMode
    );
    processedText = processMessageUrls(processedText, ttsConfig.readFullUrls);
    const processEmoji = emoteMode === 'skip' ? stripEmojis : replaceEmojisWithText;
    processedText = processEmoji(processedText);

    if (!processedText.trim()) return;

    // Determine TTS event type
    let ttsType;
    let announcementPrefix = '';

    switch (eventType) {
        case 'superchat':
            // Super Chats always read if YouTube is enabled (per user request)
            ttsType = 'cheer_tts';
            if (msg.amount) {
                announcementPrefix = `Super Chat from ${username} for ${msg.amount}: `;
            } else {
                announcementPrefix = `Super Chat from ${username}: `;
            }
            break;

        case 'supersticker':
            // Super Stickers — announce the sticker purchase
            ttsType = 'cheer_tts';
            announcementPrefix = msg.amount
                ? `${username} sent a Super Sticker for ${msg.amount}`
                : `${username} sent a Super Sticker`;
            processedText = announcementPrefix;
            announcementPrefix = '';
            break;

        case 'membership':
            // Membership messages — treat like Twitch subs
            ttsType = 'event';
            if (msg.subtext) {
                announcementPrefix = `New YouTube member ${username}: ${msg.subtext}. `;
            } else {
                announcementPrefix = `${username} just became a YouTube member! `;
            }
            break;

        case 'chat':
        default:
            // Regular chat — follow TTS mode rules
            ttsType = 'chat';

            // Check TTS mode (same logic as Twitch)
            if (ttsConfig.mode === 'command') {
                // In command mode, only !tts commands trigger TTS
                // YouTube doesn't have commands, so skip regular chat
                logger.debug({ channelId, mode: ttsConfig.mode }, 'YouTube Chat: Skipping regular chat in command mode');
                return;
            }
            if (ttsConfig.mode === 'bits_points_only') {
                logger.debug({ channelId, mode: ttsConfig.mode }, 'YouTube Chat: Skipping regular chat in bits_points_only mode');
                return;
            }
            // mode === 'all' falls through
            break;
    }

    const finalText = announcementPrefix + processedText;

    logger.debug({
        channelId,
        username,
        eventType,
        ttsType,
        textPreview: finalText.substring(0, 50),
        platform: 'youtube',
    }, 'YouTube Chat: Publishing TTS event');

    await publishTtsEvent(channelId, {
        text: finalText,
        user: username,
        userId: msg.channelId || null, // YouTube channel ID as userId
        type: ttsType,
        messageId: msg.id || `yt-${Date.now()}`,
        platform: 'youtube',
    });
}

/**
 * Disconnect a specific channel's YouTube chat connection.
 */
export function disconnectYouTubeChat(channelId) {
    const conn = activeConnections.get(channelId);
    if (!conn) return;

    conn.intentionallyClosed = true;

    if (conn.reconnectTimer) {
        clearTimeout(conn.reconnectTimer);
        conn.reconnectTimer = null;
    }

    if (conn.pingTimer) {
        clearInterval(conn.pingTimer);
        conn.pingTimer = null;
    }

    if (conn.ws) {
        try {
            conn.ws.close(1000, 'Intentional disconnect');
        } catch {
            // Ignore close errors
        }
        conn.ws = null;
    }

    activeConnections.delete(channelId);
    logger.info({ channelId }, 'YouTube Chat: Disconnected');
}

/**
 * Disconnect all YouTube chat connections. Called during graceful shutdown.
 */
export function disconnectAllYouTubeChat() {
    const count = activeConnections.size;
    for (const channelId of [...activeConnections.keys()]) {
        disconnectYouTubeChat(channelId);
    }
    logger.info(`YouTube Chat: Disconnected all ${count} connection(s)`);
}

/**
 * Handle a YouTube config change for a specific channel.
 * Called by ttsState.js when youtubeEnabled or youtubeHandle changes.
 * @param {string} channelId - The channel's Firestore doc ID
 * @param {object} config - The updated channel config
 */
export function handleYouTubeConfigChange(channelId, config) {
    const isEnabled = config.youtubeEnabled && config.youtubeHandle;
    const existing = activeConnections.get(channelId);

    if (isEnabled) {
        const handle = config.youtubeHandle.startsWith('@') ? config.youtubeHandle : `@${config.youtubeHandle}`;
        if (existing && existing.youtubeHandle === handle && existing.ws?.readyState === WebSocket.OPEN) {
            // Already connected to the same handle — no action needed
            return;
        }
        logger.info({ channelId, youtubeHandle: handle }, 'YouTube Chat: Config changed, connecting');
        connectToYouTubeChat(channelId, handle);
    } else {
        if (existing) {
            logger.info({ channelId }, 'YouTube Chat: Config changed, disconnecting');
            disconnectYouTubeChat(channelId);
        }
    }
}
