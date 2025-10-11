// src/components/twitch/eventsub.js
// EventSub webhook handler for TTS bot event announcements

import crypto from 'crypto';
import config from '../../config/index.js';
import logger from '../../lib/logger.js';
import { isChannelAllowed } from '../../lib/allowList.js';
import * as ttsQueue from '../tts/ttsQueue.js';
import { getTtsState } from '../tts/ttsState.js';

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
 * Check if an event should be processed (duplicate prevention + replay protection)
 */
function shouldProcessEvent(req) {
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

    // Idempotency: reject duplicate messages
    if (processedEventIds.has(messageId)) {
        logger.warn({ messageId }, 'Dropping duplicate EventSub message (already processed)');
        return false;
    }

    // Record this message ID and prune old ones
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
 * Main EventSub webhook handler
 * Processes webhook verification challenges and event notifications
 */
export async function eventSubHandler(req, res, rawBody) {
    // Verify signature first
    if (!verifySignature(req, rawBody)) {
        logger.warn('⚠️ Bad EventSub signature');
        res.writeHead(403).end();
        return;
    }

    const notification = JSON.parse(rawBody);
    const messageType = req.headers['twitch-eventsub-message-type'];

    // Handle webhook verification challenge
    if (messageType === 'webhook_callback_verification') {
        logger.info('✅ EventSub webhook verification challenge received');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(notification.challenge);
        logger.info('✅ EventSub webhook verification challenge responded');
        return;
    }

    // For all other message types, respond 200 immediately
    res.writeHead(200).end();

    // Handle event notifications
    if (messageType === 'notification') {
        // Check for duplicate/replay
        if (!shouldProcessEvent(req)) {
            return;
        }

        const { subscription, event } = notification;
        const channelName = (
            event?.broadcaster_user_name ||
            event?.broadcaster_user_login ||
            event?.to_broadcaster_user_name
        )?.toLowerCase();

        // Verify channel is allowed
        if (!channelName || !(await isChannelAllowed(channelName))) {
            logger.debug({ channelName, type: subscription.type }, 'EventSub event for non-allowed channel - ignoring');
            return;
        }

        // Check if TTS events are enabled for this channel
        const ttsConfig = await getTtsState(channelName);
        if (!ttsConfig.engineEnabled || !ttsConfig.speakEvents) {
            logger.debug({ channelName, type: subscription.type }, 'TTS events disabled for channel - ignoring EventSub event');
            return;
        }

        logger.info({ channelName, type: subscription.type }, 'Processing EventSub event for TTS');

        try {
            await handleEventNotification(subscription.type, event, channelName);
        } catch (error) {
            logger.error({ err: error, type: subscription.type, channelName }, 'Error handling EventSub notification');
        }
    }

    // Handle revocation notifications
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
 * Handle individual event notifications and send to TTS queue
 */
async function handleEventNotification(subscriptionType, event, channelName) {
    let ttsText = null;
    let username = 'event_tts'; // Default for events without specific user

    switch (subscriptionType) {
        case 'channel.subscribe': {
            // New subscription
            const subUser = event.user_name || event.user_login || 'Someone';
            const tier = event.tier ? ` (Tier ${event.tier / 1000})` : '';
            ttsText = `${subUser} just subscribed${tier}!`;
            username = subUser;
            logger.info({ channelName, user: subUser, tier: event.tier }, 'New subscription event');
            break;
        }

        case 'channel.subscription.message': {
            // Resubscription with message
            const resubUser = event.user_name || event.user_login || 'Someone';
            const months = event.cumulative_months || event.duration_months || 0;
            const tier = event.tier ? ` (Tier ${event.tier / 1000})` : '';
            const message = event.message?.text ? ` ${event.message.text}` : '';
            ttsText = `${resubUser} resubscribed for ${months} months${tier}!${message}`;
            username = resubUser;
            logger.info({ channelName, user: resubUser, months, tier: event.tier }, 'Resubscription event');
            break;
        }

        case 'channel.subscription.gift': {
            // Gift subscription(s)
            const gifterUser = event.user_name || event.user_login || 'An anonymous gifter';
            const total = event.total || 1;
            const tier = event.tier ? ` Tier ${event.tier / 1000}` : '';
            const isAnonymous = event.is_anonymous;

            if (isAnonymous || !event.user_name) {
                ttsText = `${total} ${tier} gift ${total === 1 ? 'sub' : 'subs'} from an anonymous gifter!`;
                username = 'anonymous_gifter';
            } else {
                ttsText = `${gifterUser} just gifted ${total} ${tier} ${total === 1 ? 'sub' : 'subs'}!`;
                username = gifterUser;
            }
            logger.info({ channelName, gifter: gifterUser, total, tier: event.tier, isAnonymous }, 'Gift subscription event');
            break;
        }

        case 'channel.cheer': {
            // Bits cheer (without the message - message already handled by IRC cheer handler)
            const cheerUser = event.user_name || event.user_login || 'Someone';
            const bits = event.bits || 0;
            const isAnonymous = event.is_anonymous;

            if (isAnonymous) {
                ttsText = `${bits} bits from an anonymous cheerer!`;
                username = 'anonymous_cheerer';
            } else {
                ttsText = `${cheerUser} cheered ${bits} bits!`;
                username = cheerUser;
            }
            logger.info({ channelName, user: cheerUser, bits, isAnonymous }, 'Cheer event');
            break;
        }

        case 'channel.raid': {
            // Incoming raid
            const raiderUser = event.from_broadcaster_user_name || event.from_broadcaster_user_login || 'A streamer';
            const viewers = event.viewers || 0;
            ttsText = `${raiderUser} is raiding with ${viewers} ${viewers === 1 ? 'viewer' : 'viewers'}!`;
            username = raiderUser;
            logger.info({ channelName, raider: raiderUser, viewers }, 'Raid event');
            break;
        }

        case 'channel.follow': {
            // New follower (v2 - doesn't include follower username for privacy)
            ttsText = `Someone just followed!`;
            username = 'follower';
            logger.info({ channelName }, 'Follow event (v2 - no username)');
            break;
        }

        default:
            logger.warn({ type: subscriptionType, channelName }, 'Unhandled EventSub subscription type');
            return;
    }

    // Enqueue the event for TTS
    if (ttsText) {
        logger.debug({ channelName, text: ttsText, user: username }, 'Enqueueing EventSub event for TTS');
        await ttsQueue.enqueue(channelName, {
            text: ttsText,
            user: username,
            type: 'event'
        });
    }
}
