// src/components/twitch/eventsub.js
// EventSub webhook handler for TTS bot event announcements

import crypto from 'crypto';
import config from '../../config/index.js';
import logger from '../../lib/logger.js';
import { isChannelAllowed } from '../../lib/allowList.js';
import * as ttsQueue from '../tts/ttsQueue.js';
import { getTtsState } from '../tts/ttsState.js';
import * as sharedChatManager from './sharedChatManager.js';
import * as redemptionCache from './redemptionCache.js';
import { publishTtsEvent } from '../../lib/pubsub.js';
import { processMessageUrls } from '../../lib/urlProcessor.js';

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

        // Handle shared chat events (processed separately from TTS events)
        if (subscription.type === 'channel.shared_chat.begin') {
            try {
                const sessionId = event?.session_id;
                const hostBroadcasterId = event?.host_broadcaster_user_id;
                const participants = event?.participants || [];

                if (!sessionId || !hostBroadcasterId) {
                    logger.warn({ event }, 'ChatVibes: channel.shared_chat.begin missing required fields');
                    return;
                }

                const channelLogins = participants.map(p => p.broadcaster_user_login);
                logger.info({
                    sessionId,
                    hostBroadcasterId,
                    participantCount: participants.length,
                    channels: channelLogins
                }, `ChatVibes: Shared chat session started: ${channelLogins.join(', ')}`);

                sharedChatManager.addSession(sessionId, hostBroadcasterId, participants);
            } catch (error) {
                logger.error({ err: error }, 'ChatVibes: Error handling channel.shared_chat.begin');
            }
            return;
        }

        if (subscription.type === 'channel.shared_chat.update') {
            try {
                const sessionId = event?.session_id;
                const participants = event?.participants || [];

                if (!sessionId) {
                    logger.warn({ event }, 'ChatVibes: channel.shared_chat.update missing session_id');
                    return;
                }

                const channelLogins = participants.map(p => p.broadcaster_user_login);
                logger.info({
                    sessionId,
                    participantCount: participants.length,
                    channels: channelLogins
                }, `ChatVibes: Shared chat session updated: ${channelLogins.join(', ')}`);

                sharedChatManager.updateSession(sessionId, participants);
            } catch (error) {
                logger.error({ err: error }, 'ChatVibes: Error handling channel.shared_chat.update');
            }
            return;
        }

        if (subscription.type === 'channel.shared_chat.end') {
            try {
                const sessionId = event?.session_id;

                if (!sessionId) {
                    logger.warn({ event }, 'ChatVibes: channel.shared_chat.end missing session_id');
                    return;
                }

                logger.info({ sessionId }, 'ChatVibes: Shared chat session ended');
                sharedChatManager.removeSession(sessionId);
            } catch (error) {
                logger.error({ err: error }, 'ChatVibes: Error handling channel.shared_chat.end');
            }
            return;
        }

        // Handle Channel Points redemption events separately (they don't require TTS events to be enabled)
        if (subscription.type === 'channel.channel_points_custom_reward_redemption.add' ||
            subscription.type === 'channel.channel_points_custom_reward_redemption.update') {
            try {
                await handleChannelPointsRedemption(subscription.type, event);
            } catch (error) {
                logger.error({ err: error, type: subscription.type }, 'Error handling Channel Points redemption event');
            }
            return;
        }

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

/**
 * Helper function to get broadcaster ID from cache (to avoid repeated lookups)
 */
const broadcasterIdCache = new Map();

async function getBroadcasterIdByLogin(channelLogin) {
    if (broadcasterIdCache.has(channelLogin)) {
        return broadcasterIdCache.get(channelLogin);
    }
    
    const { getUsersByLogin } = await import('./helixClient.js');
    const users = await getUsersByLogin([channelLogin]);
    if (users && users.length > 0) {
        const broadcasterId = users[0].id;
        broadcasterIdCache.set(channelLogin, broadcasterId);
        return broadcasterId;
    }
    
    return null;
}

/**
 * Get shared session info for a channel
 */
async function getSharedSessionInfo(channelLogin) {
    try {
        const broadcasterId = await getBroadcasterIdByLogin(channelLogin);
        if (!broadcasterId) {
            return null;
        }

        const sessionId = sharedChatManager.getSessionForChannel(broadcasterId);
        if (!sessionId) {
            return null;
        }

        const session = sharedChatManager.getSession(sessionId);
        if (!session) {
            return null;
        }

        const channelLogins = session.participants.map(p => p.broadcaster_user_login);
        
        return {
            sessionId,
            channels: channelLogins,
            participantCount: channelLogins.length
        };
    } catch (error) {
        logger.warn({ err: error, channel: channelLogin }, 'Error getting shared session info for channel points redemption');
        return null;
    }
}

/**
 * Handle Channel Points custom reward redemption events
 * This is the NEW implementation that uses EventSub instead of chat messages
 */
async function handleChannelPointsRedemption(subscriptionType, event) {
    const channelLogin = (event?.broadcaster_user_login || event?.broadcaster_user_name)?.toLowerCase();
    const rewardId = event?.reward?.id;
    const redemptionId = event?.id;
    const userInput = event?.user_input || '';
    const userName = (event?.user_login || event?.user_name)?.toLowerCase();
    const status = event?.status;

    logger.debug({
        type: subscriptionType,
        channelLogin,
        userName,
        rewardId,
        redemptionId,
        status,
        userInputPreview: userInput?.substring(0, 30)
    }, 'Received Channel Points redemption event');

    // Verify channel is allowed
    if (!channelLogin || !(await isChannelAllowed(channelLogin))) {
        logger.debug({ channelLogin, subscriptionType }, 'Channel Points event for non-allowed channel - ignoring');
        return;
    }

    // Get TTS config for this channel
    const ttsConfig = await getTtsState(channelLogin);
    const configuredRewardId = ttsConfig.channelPoints?.rewardId || ttsConfig.channelPointRewardId;
    
    // Check if this is our TTS reward
    if (!configuredRewardId || rewardId !== configuredRewardId) {
        logger.debug({ channelLogin, rewardId, configuredRewardId }, 'Redemption is not for our TTS reward - ignoring');
        return;
    }

    // Check if Channel Points TTS is enabled
    const enabledViaNewConfig = ttsConfig.channelPoints ? ttsConfig.channelPoints.enabled === true : true;
    if (!enabledViaNewConfig || !ttsConfig.engineEnabled) {
        logger.debug({ channelLogin }, 'Channel Points TTS is disabled for this channel - ignoring');
        return;
    }

    // Check if user is ignored
    const isIgnored = Array.isArray(ttsConfig.ignoredUsers) && ttsConfig.ignoredUsers.includes(userName);
    if (isIgnored) {
        logger.debug({ channelLogin, userName }, 'User is on ignore list - skipping TTS');
        return;
    }

    // Handle redemption.add event
    if (subscriptionType === 'channel.channel_points_custom_reward_redemption.add') {
        if (status === 'unfulfilled') {
            // Redemption is waiting for approval - add to cache
            logger.info({
                channelLogin,
                userName,
                redemptionId,
                textPreview: userInput?.substring(0, 30)
            }, 'Channel Points redemption pending approval - adding to cache');
            
            redemptionCache.addRedemption(redemptionId, userInput, userName, channelLogin);
        } else if (status === 'fulfilled') {
            // Redemption was auto-approved (Skip Queue enabled) - play immediately
            logger.info({
                channelLogin,
                userName,
                redemptionId,
                textPreview: userInput?.substring(0, 30)
            }, 'Channel Points redemption auto-approved - playing immediately');
            
            await processTtsRedemption(channelLogin, userInput, userName, ttsConfig);
        }
    }
    // Handle redemption.update event
    else if (subscriptionType === 'channel.channel_points_custom_reward_redemption.update') {
        if (status === 'fulfilled') {
            // Check if this redemption was in our cache (meaning it was waiting for approval)
            const cachedRedemption = redemptionCache.getRedemption(redemptionId);
            
            if (cachedRedemption) {
                logger.info({
                    channelLogin,
                    userName,
                    redemptionId,
                    textPreview: cachedRedemption.userInput?.substring(0, 30)
                }, 'Channel Points redemption approved by streamer - playing TTS');
                
                await processTtsRedemption(
                    cachedRedemption.channelName,
                    cachedRedemption.userInput,
                    cachedRedemption.userName,
                    ttsConfig
                );
                
                // Remove from cache after processing
                redemptionCache.removeRedemption(redemptionId);
            } else {
                logger.debug({ redemptionId, channelLogin }, 'Redemption update for fulfilled status but not in cache - likely was auto-approved');
            }
        } else if (status === 'canceled') {
            // Redemption was canceled - remove from cache if present
            const existed = redemptionCache.removeRedemption(redemptionId);
            if (existed) {
                logger.info({ channelLogin, userName, redemptionId }, 'Channel Points redemption canceled - removed from cache');
            }
        }
    }
}

/**
 * Process a TTS redemption (apply content policy and enqueue for playback)
 */
async function processTtsRedemption(channelLogin, userInput, userName, ttsConfig) {
    const redeemMessage = (userInput || '').trim();
    
    if (redeemMessage.length === 0) {
        logger.debug({ channelLogin, userName }, 'Empty redemption message - skipping');
        return;
    }

    // Enforce content policy if configured
    const policy = (ttsConfig.channelPoints && ttsConfig.channelPoints.contentPolicy) || {};
    const minChars = typeof policy.minChars === 'number' ? policy.minChars : 1;
    const maxChars = typeof policy.maxChars === 'number' ? policy.maxChars : 500;
    const blockLinks = policy.blockLinks !== false; // default block links
    const bannedWords = Array.isArray(policy.bannedWords) ? policy.bannedWords : [];

    if (redeemMessage.length < minChars) {
        logger.debug({ channelLogin, userName, length: redeemMessage.length, minChars }, 'Message too short - skipping');
        return;
    }
    
    if (redeemMessage.length > maxChars) {
        logger.debug({ channelLogin, userName, length: redeemMessage.length, maxChars }, 'Message too long - skipping');
        return;
    }
    
    if (blockLinks && /\bhttps?:\/\//i.test(redeemMessage)) {
        logger.debug({ channelLogin, userName }, 'Message contains blocked link - skipping');
        return;
    }
    
    const lowered = redeemMessage.toLowerCase();
    if (bannedWords.some(w => w && lowered.includes(String(w).toLowerCase()))) {
        logger.debug({ channelLogin, userName }, 'Message contains banned word - skipping');
        return;
    }

    // Process URLs based on channel configuration
    const processedMessage = processMessageUrls(redeemMessage, ttsConfig.readFullUrls);

    // Get shared session info
    const sharedSessionInfo = await getSharedSessionInfo(channelLogin);

    // Publish to Pub/Sub for distribution to all instances
    logger.info({
        channel: channelLogin,
        user: userName,
        textPreview: processedMessage.substring(0, 30)
    }, 'Publishing Channel Points TTS redemption to Pub/Sub');

    await publishTtsEvent(channelLogin, {
        text: processedMessage,
        user: userName,
        type: 'reward'
    }, sharedSessionInfo);
}
