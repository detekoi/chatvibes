// src/components/twitch/eventsub.js
// EventSub webhook handler - Router pattern
// Routes events to specialized handlers for better maintainability

import crypto from 'crypto';
import config from '../../config/index.js';
import logger from '../../lib/logger.js';
import { INSTANCE_ID } from '../../lib/instanceId.js';
import { isChannelActive } from '../../lib/allowList.js';
import { getTtsState } from '../tts/ttsState.js';
import { Firestore, Timestamp } from '@google-cloud/firestore';
import { claimOnce } from '../../lib/firestoreClaim.js';
import { runWithTiming, markTiming, snapshotTiming } from '../../lib/ttsTiming.js';
import { isOwnershipEnabled, ownsBroadcaster, getLeaseOwner } from '../../lib/channelOwnership.js';
import { forwardToInbox } from '../../lib/channelInbox.js';

// Import event handlers
import { handleChatMessage } from './handlers/chatHandler.js';
import { handleChannelPointsRedemption, handleRedemptionAnnouncement } from './handlers/redemptionHandler.js';
import { handleNotification, WATCH_STREAK_TYPE, SUB_GIFT_TYPE, COMMUNITY_SUB_GIFT_TYPE } from './handlers/notificationHandler.js';
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
    const payload = {
        eventSubMessageId: messageId,
        instance: INSTANCE_ID,
        createdAtMs: now,
        expireAt: Timestamp.fromMillis(now + EVENTSUB_DEDUP_TTL_MS), // Firestore Timestamp for TTL policy
    };

    // One round trip on the common path, where runTransaction cost two
    // (BeginTransaction + read, then Commit) on every single message.
    return claimOnce(docRef, payload, now, { eventSubMessageId: messageId, source: 'eventsub' });
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
        // Every mark the TTS_TIMING log line reports is measured from these two:
        // Twitch's own timestamp on the message, and the moment it reached us.
        const originMs = Date.parse(req.headers['twitch-eventsub-message-timestamp']);
        await runWithTiming({
            source: 'eventsub',
            originMs: Number.isFinite(originMs) ? originMs : null,
            receivedMs: Date.now(),
        }, () => routeNotification(req, notification, rawBody));
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

/**
 * The channel a notification acts on. Raids act on the raided channel; every
 * other subscription type, shared-chat events included, is scoped to
 * broadcaster_user_id.
 * @param {object} notification
 * @returns {string|null} Broadcaster ID.
 */
export function resolveEventChannel(notification) {
    const event = notification?.event || {};
    const isRaid = notification?.subscription?.type === 'channel.raid';
    const broadcasterId = isRaid ? event.to_broadcaster_user_id : event.broadcaster_user_id;
    return broadcasterId ? String(broadcasterId) : null;
}

/**
 * Hands the notification to the instance that owns its channel (the one holding
 * the channel's browser source) when that is not this one. With no owner, the
 * event is handled here and its audio, if any, goes out over Pub/Sub as it did
 * before ownership existed.
 *
 * Fails open: if Firestore cannot be reached the event is handled here.
 * @returns {Promise<boolean>} True when forwarded and nothing is left to do here.
 */
async function forwardIfNotOwner(broadcasterId, messageId, rawBody, isChat) {
    if (!isOwnershipEnabled() || !broadcasterId) return false;
    // Only channels the bot is switched on for have owners; processNotification drops the rest.
    if (!isChannelActive(broadcasterId) || ownsBroadcaster(broadcasterId)) return false;

    try {
        const lease = await getLeaseOwner(broadcasterId);
        if (!lease || lease.ownerId === INSTANCE_ID) return false;
        await forwardToInbox(broadcasterId, {
            messageId,
            payload: rawBody.toString('utf8'),
            isChat,
            timing: snapshotTiming(),
            targetOwner: lease.ownerId,
        });
        logger.debug({ broadcasterId, messageId, ownerId: lease.ownerId }, '[EventSub] Forwarded to channel owner');
        return true;
    } catch (err) {
        logger.warn({ err, broadcasterId, messageId }, '[EventSub] Channel routing failed, handling locally');
        return false;
    }
}

/**
 * Inbox handler for a notification another instance forwarded here. It was
 * already claimed against processedEventSubMessages by the instance Twitch
 * delivered it to, so a retry reaching this instance directly is refused by
 * that claim. The timing record resumes where the forwarder left it.
 * @param {object} notification - Parsed EventSub notification body.
 * @param {object|null} timing - Record snapshotted by the forwarder.
 */
export async function handleForwardedNotification(notification, timing) {
    await runWithTiming(
        { ...(timing || {}), route: 'inbox', inboxReceivedMs: Date.now() },
        () => processNotification(notification)
    );
}

/**
 * Route one EventSub notification to its handler. Split out of eventSubHandler so
 * the whole of it runs inside the timing context established there.
 */
async function routeNotification(req, notification, rawBody) {
    // Check for duplicate/replay (with global Firestore-based deduplication)
    if (!(await shouldProcessEvent(req))) {
        return;
    }
    markTiming('claimedMs');

    const broadcasterId = resolveEventChannel(notification);
    const isChat = notification?.subscription?.type === 'channel.chat.message';
    if (await forwardIfNotOwner(broadcasterId, req.headers['twitch-eventsub-message-id'], rawBody, isChat)) {
        return;
    }

    await processNotification(notification);
}

/**
 * Acts on a verified, de-duplicated EventSub notification: one Twitch delivered
 * here, or one forwarded through the channel inbox by an instance that does not
 * own the channel.
 * @param {object} notification - Parsed EventSub notification body.
 */
async function processNotification(notification) {
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
        if (broadcasterId && isChannelActive(broadcasterId)) {
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

    // Common check for TTS-related events: is the bot switched on for this
    // channel? Approval alone is not enough — a channel that deactivated the
    // bot stays on the allow-list but must not be spoken in, and a stale
    // EventSub subscription can outlive the deactivation that unsubscribed it.
    //
    // A raid carries no broadcaster_user_id, only from_/to_broadcaster_user_id,
    // so reading that field alone dropped every raid here as "inactive".
    const broadcasterUserId = resolveEventChannel(notification);
    // The login first: a display name can differ from it by more than case.
    const channelName = (
        event?.broadcaster_user_login ||
        event?.broadcaster_user_name ||
        event?.to_broadcaster_user_login ||
        event?.to_broadcaster_user_name
    )?.toLowerCase();

    if (!broadcasterUserId || !isChannelActive(broadcasterUserId)) {
        logger.debug({ channelName, broadcasterUserId, type }, 'EventSub event for inactive or non-allowed channel - ignoring');
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

    // Route: Chat notifications (watch streaks, gift subs)
    // channel.chat.notification delivers many notice types (sub, resub, raid, announcement,
    // prime_paid_upgrade, pay_it_forward, etc.). Most overlap with dedicated EventSub subscriptions
    // we already handle; others (announcement, prime_paid_upgrade, etc.) are intentionally not
    // processed for TTS. Handled here: watch_streak (no dedicated subscription exists) and the
    // gift notices (channel.subscription.gift exists but omits the recipient — see
    // notificationHandler.SUB_GIFT_TYPE).
    if (type === 'channel.chat.notification') {
        const noticeType = event?.notice_type;

        // Each recipient of a mass gift also gets an individual sub_gift notice carrying the
        // batch's community_gift_id. The community_sub_gift notice announces the batch, so
        // dropping these is what keeps a 50-sub gift from producing 51 announcements.
        if (noticeType === 'sub_gift' && event?.sub_gift?.community_gift_id) {
            logger.debug({ channelName, communityGiftId: event.sub_gift.community_gift_id },
                'Ignoring sub_gift from a mass gift — announced by its community_sub_gift notice');
            return;
        }

        const noticeTypeToSyntheticType = {
            watch_streak: WATCH_STREAK_TYPE,
            sub_gift: SUB_GIFT_TYPE,
            community_sub_gift: COMMUNITY_SUB_GIFT_TYPE,
        };
        const syntheticType = noticeTypeToSyntheticType[noticeType];
        if (!syntheticType) {
            logger.debug({ channelName, noticeType }, 'Ignoring chat notification — notice type is not processed for TTS');
            return;
        }

        const noticeConfig = await getTtsState(channelName);
        // Watch streaks have a granular toggle (defaulting to speakEvents); gift subs follow
        // speakEvents, the same toggle that gated channel.subscription.gift.
        const speakNotice = syntheticType === WATCH_STREAK_TYPE
            ? (noticeConfig.speakWatchStreakEvents !== undefined
                ? noticeConfig.speakWatchStreakEvents
                : (noticeConfig.speakEvents !== false))
            : !!noticeConfig.speakEvents;

        if (!noticeConfig.engineEnabled || !speakNotice) {
            logger.debug({ channelName, type, noticeType }, 'TTS chat notification events disabled for channel - ignoring');
            return;
        }

        logger.info({ channelName, type, noticeType }, 'Processing chat notification event for TTS');
        try {
            await handleNotification(syntheticType, event, channelName, noticeConfig);
        } catch (error) {
            logger.error({ err: error, channelName, noticeType }, 'Error handling chat notification');
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
