// src/components/twitch/eventsub.js
// EventSub webhook handler - Router pattern
// Routes events to specialized handlers for better maintainability

import crypto from 'crypto';
import config from '../../config/index.js';
import logger from '../../lib/logger.js';
import { isChannelAllowed } from '../../lib/allowList.js';
import { getTtsState } from '../tts/ttsState.js';
import { Firestore, Timestamp } from '@google-cloud/firestore';

// Import event handlers
import { handleChatMessage } from './handlers/chatHandler.js';
import { handleChannelPointsRedemption, handleRedemptionAnnouncement } from './handlers/redemptionHandler.js';
import { handleNotification } from './handlers/notificationHandler.js';
import * as sharedChatHandler from './handlers/sharedChatHandler.js';

// Firestore for cross-instance EventSub deduplication
const firestore = new Firestore();
const processedEventSubIds = firestore.collection('processedEventSubMessages');
const EVENTSUB_DEDUP_TTL_MS = 10 * 60 * 1000; // 10 minutes (match replay protection)

// Idempotency and replay protection (in-memory window)
const processedEventIds = new Map(); // messageId -> timestamp(ms)
const TEN_MINUTES_MS = 10 * 60 * 1000;

/**
 * Prune old processed event IDs to prevent memory leak
 */
function pruneOldProcessedIds(nowTs) {
    for (const [id, ts] of processedEventIds) {
        if (nowTs - ts > TEN_MINUTES_MS) {
            processedEventIds.delete(id);
        }
    }
}

/**
 * Claim an EventSub message globally using Firestore
 * Returns true if this instance successfully claimed it (should process)
 * Returns false if another instance already claimed it (skip processing)
 */
async function claimEventSubMessageGlobal(messageId) {
    const docRef = processedEventSubIds.doc(messageId);
    const now = Date.now();
    const expireAt = Timestamp.fromMillis(now + EVENTSUB_DEDUP_TTL_MS);

    try {
        const result = await firestore.runTransaction(async (tx) => {
            const snap = await tx.get(docRef);
            if (snap.exists) {
                const data = snap.data() || {};
                // Check both old (expireAtMs) and new (expireAt) formats for backward compatibility
                let expired = true;
                if (data.expireAt instanceof Timestamp) {
                    expired = data.expireAt.toMillis() <= now;
                } else if (typeof data.expireAtMs === 'number') {
                    expired = data.expireAtMs <= now;
                }

                if (!expired) {
                    // Already claimed by another instance
                    logger.info({
                        eventSubMessageId: messageId,
                        ageMs: now - (data.createdAtMs || 0),
                        claimedBy: data.instance || 'unknown'
                    }, 'EventSub webhook already processed by another instance - skipping');
                    return false;
                }
            }
            // Claim it
            tx.set(docRef, {
                eventSubMessageId: messageId,
                instance: process.env.K_REVISION || 'local',
                createdAtMs: now,
                expireAt: expireAt, // Firestore Timestamp for TTL policy
            }, { merge: true });
            return true;
        });
        return result;
    } catch (err) {
        // On Firestore error, fail-open to avoid message loss
        logger.warn({ err, messageId }, 'EventSub global claim failed; proceeding without global dedupe');
        return true;
    }
}

/**
 * Check if an event should be processed (duplicate prevention + replay protection)
 */
async function shouldProcessEvent(req) {
    const messageId = req.headers['twitch-eventsub-message-id'];
    const timestampHeader = req.headers['twitch-eventsub-message-timestamp'];

    if (!messageId || !timestampHeader) {
        logger.warn('EventSub message missing required headers');
        return false;
    }

    const nowTs = Date.now();
    const msgTs = Date.parse(timestampHeader);

    // Replay protection: reject messages older than 10 minutes
    if (Number.isFinite(msgTs) && (nowTs - msgTs) > TEN_MINUTES_MS) {
        logger.warn({ messageId, timestampHeader }, 'Dropping EventSub message older than 10 minutes (replay guard)');
        return false;
    }

    // Idempotency: reject duplicate messages (local memory check first - fast path)
    if (processedEventIds.has(messageId)) {
        logger.info({ messageId }, 'Dropping duplicate EventSub message (already processed by this instance)');
        return false;
    }

    // Global Firestore claim (authoritative, prevents duplicate processing across instances)
    const claimed = await claimEventSubMessageGlobal(messageId);
    if (!claimed) {
        return false; // Another instance already processed this
    }

    // Record this message ID in local memory and prune old ones
    processedEventIds.set(messageId, nowTs);
    if (processedEventIds.size > 1000) {
        pruneOldProcessedIds(nowTs);
    }

    return true;
}

/**
 * Verify EventSub webhook signature
 */
function verifySignature(req, rawBody) {
    // Allow bypassing signature verification for local development
    const bypass = process.env.EVENTSUB_BYPASS === '1' || process.env.EVENTSUB_BYPASS === 'true';
    if (bypass) {
        logger.warn('[DEV] EVENTSUB_BYPASS enabled - skipping signature verification');
        return true;
    }

    const secret = config.twitch.eventSubSecret;
    const messageId = req.headers['twitch-eventsub-message-id'];
    const timestamp = req.headers['twitch-eventsub-message-timestamp'];
    const signature = req.headers['twitch-eventsub-message-signature'];

    if (!secret || !messageId || !timestamp || !signature) {
        logger.warn('A required header or secret for signature verification is missing.');
        return false;
    }

    const hmacMessage = messageId + timestamp + rawBody;
    const hmac = 'sha256=' + crypto.createHmac('sha256', secret).update(hmacMessage).digest('hex');

    const isSignatureValid = crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(signature));

    if (!isSignatureValid) {
        logger.warn({ messageId }, 'EventSub signature verification failed');
    }

    return isSignatureValid;
}

/**
 * Main EventSub webhook handler (Router)
 * Handles verification, deduplication, and routes events to specialized handlers
 */
export async function eventSubHandler(req, res, rawBody) {
    // 1. Verify signature first
    if (!verifySignature(req, rawBody)) {
        logger.warn('⚠️ Bad EventSub signature');
        res.writeHead(403).end();
        return;
    }

    const notification = JSON.parse(rawBody);
    const messageType = req.headers['twitch-eventsub-message-type'];

    // 2. Handle webhook verification challenge
    if (messageType === 'webhook_callback_verification') {
        logger.info('✅ EventSub webhook verification challenge received');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(notification.challenge);
        logger.info('✅ EventSub webhook verification challenge responded');
        return;
    }

    // For all other message types, respond 200 immediately
    res.writeHead(200).end();

    // 3. Handle event notifications
    if (messageType === 'notification') {
        // Check for duplicate/replay (with global Firestore-based deduplication)
        if (!(await shouldProcessEvent(req))) {
            return;
        }

        const { subscription, event } = notification;
        const type = subscription.type;

        // Route: Shared Chat events
        if (type.startsWith('channel.shared_chat.')) {
            if (type === 'channel.shared_chat.begin') {
                await sharedChatHandler.onBegin(event);
            } else if (type === 'channel.shared_chat.update') {
                await sharedChatHandler.onUpdate(event);
            } else if (type === 'channel.shared_chat.end') {
                await sharedChatHandler.onEnd(event);
            }
            return;
        }

        // Route: Channel Points redemption events
        // The TTS reward handler doesn't require TTS events to be enabled
        if (type.startsWith('channel.channel_points_custom_reward_redemption.')) {
            try {
                await handleChannelPointsRedemption(type, event);
            } catch (error) {
                logger.error({ err: error, type }, 'Error handling Channel Points redemption event');
            }

            // Also announce the redemption via TTS if speakRedemptionEvents is enabled
            const broadcasterId = event?.broadcaster_user_id;
            const channelLogin = (event?.broadcaster_user_login || event?.broadcaster_user_name)?.toLowerCase();
            if (broadcasterId && isChannelAllowed(broadcasterId)) {
                try {
                    const redemptionTtsConfig = await getTtsState(channelLogin);
                    // Default to speakEvents value for backward compat, then true
                    const speakRedemptions = redemptionTtsConfig.speakRedemptionEvents !== undefined
                        ? redemptionTtsConfig.speakRedemptionEvents
                        : (redemptionTtsConfig.speakEvents !== false);

                    if (redemptionTtsConfig.engineEnabled && speakRedemptions) {
                        await handleRedemptionAnnouncement(type, event, channelLogin, redemptionTtsConfig);
                    }
                } catch (error) {
                    logger.error({ err: error, type, channelLogin }, 'Error handling Channel Points redemption announcement');
                }
            }
            return;
        }

        // Common check for TTS-related events: Is channel allowed?
        const broadcasterUserId = event?.broadcaster_user_id;
        const channelName = (
            event?.broadcaster_user_name ||
            event?.broadcaster_user_login ||
            event?.to_broadcaster_user_name
        )?.toLowerCase();

        if (!broadcasterUserId || !isChannelAllowed(broadcasterUserId)) {
            logger.debug({ channelName, broadcasterUserId, type }, 'EventSub event for non-allowed channel - ignoring');
            return;
        }

        // Route: Chat messages
        if (type === 'channel.chat.message') {
            try {
                await handleChatMessage(event, channelName);
            } catch (error) {
                logger.error({ err: error, channelName }, 'Error handling chat message event');
            }
            return;
        }

        // For other event types, check if TTS events are enabled
        const ttsConfig = await getTtsState(channelName);

        // Granular check for cheer events
        if (type === 'channel.cheer') {
            // Check speakCheerEvents (default to true/speakEvents logic if undefined for backward compatibility)
            const speakCheers = ttsConfig.speakCheerEvents !== undefined
                ? ttsConfig.speakCheerEvents
                : (ttsConfig.speakEvents !== false); // Fallback to main toggle if not set

            if (!ttsConfig.engineEnabled || !speakCheers) {
                logger.debug({ channelName, type }, 'TTS cheer events disabled for channel - ignoring EventSub event');
                return;
            }
        }
        // Standard check for other events
        else if (!ttsConfig.engineEnabled || !ttsConfig.speakEvents) {
            logger.debug({ channelName, type }, 'TTS events disabled for channel - ignoring EventSub event');
            return;
        }

        logger.info({ channelName, type }, 'Processing EventSub event for TTS');

        // Route: Standard notifications (subs, raids, follows, cheers)
        try {
            await handleNotification(type, event, channelName, ttsConfig);
        } catch (error) {
            logger.error({ err: error, type, channelName }, 'Error handling EventSub notification');
        }
    }

    // 4. Handle revocation notifications
    if (messageType === 'revocation') {
        const { subscription } = notification;
        logger.warn({
            type: subscription.type,
            status: subscription.status,
            condition: subscription.condition
        }, 'EventSub subscription was revoked');
    }
}
