// src/components/twitch/twitchSubs.js
// Twitch EventSub subscription management for TTS event announcements

import { getHelixClient, getUsersByLogin } from './helixClient.js';

import logger from '../../lib/logger.js';
import config from '../../config/index.js';
import { Firestore } from '@google-cloud/firestore';

let _firestoreDb = null;
function getDb() {
    if (!_firestoreDb) _firestoreDb = new Firestore();
    return _firestoreDb;
}

/**
 * NOTE: EventSub webhook subscriptions ALWAYS use App Access Tokens for the API call.
 * 
 * For events that require broadcaster permissions (subscriptions, bits, channel points, etc.),
 * Twitch validates that the broadcaster (identified by broadcaster_user_id in the condition)
 * has granted the required scopes to your application during OAuth.
 * 
 * The app access token authenticates YOUR APPLICATION to Twitch's API.
 * The broadcaster's OAuth scopes authorize access to THEIR data.
 */

/**
 * Make a Twitch Helix API request (uses app token)
 */
async function makeHelixRequest(method, endpoint, body = null) {
    try {
        const helixClient = getHelixClient();
        const response = await helixClient({ method, url: endpoint, data: body });
        return { success: true, data: response.data };
    } catch (error) {
        // 409 Conflict means the subscription already exists - treat as success
        if (error.response && error.response.status === 409) {
            logger.debug({
                method,
                endpoint,
                type: body?.type
            }, 'EventSub subscription already exists (409) - treating as success');
            return { success: true, data: error.response.data };
        }

        // 403 Forbidden means the broadcaster's OAuth scopes are missing or revoked
        if (error.response && error.response.status === 403) {
            logger.warn({
                method,
                endpoint,
                type: body?.type,
                status: 403
            }, 'EventSub subscription failed — broadcaster OAuth scopes missing or revoked (403)');
            return { success: false, error: '403 Forbidden: broadcaster OAuth scopes missing or revoked', status: 403 };
        }

        logger.error({
            err: error.response ? error.response.data : error.message,
            method,
            endpoint
        }, 'Error making Helix request');
        return { success: false, error: error.message };
    }
}

/**
 * Check whether a broadcaster has completed OAuth (has a stored access token).
 * Uses a Firestore select() projection to avoid reading the full token value.
 * @param {string} broadcasterUserId - The broadcaster's Twitch user ID
 * @returns {Promise<boolean>} True if the broadcaster has a stored access token
 */
async function hasBroadcasterOAuth(broadcasterUserId) {
    try {
        const db = getDb();

        const oauthDoc = await db.collection('users').doc(broadcasterUserId)
            .collection('private').doc('oauth')
            .select('twitchAccessToken').get();

        if (!oauthDoc.exists) {
            logger.debug({ broadcasterUserId }, 'Broadcaster OAuth doc not found');
            return false;
        }

        const hasToken = !!oauthDoc.data()?.twitchAccessToken;
        if (!hasToken) {
            logger.debug({ broadcasterUserId }, 'Broadcaster OAuth doc exists but no access token');
        }
        return hasToken;
    } catch (error) {
        logger.error({ err: error, broadcasterUserId }, 'Error checking broadcaster OAuth status');
        return false;
    }
}


/**
 * Get all EventSub subscriptions
 */
export async function getEventSubSubscriptions() {
    return await makeHelixRequest('get', '/eventsub/subscriptions');
}

/**
 * Delete an EventSub subscription by ID
 */
export async function deleteEventSubSubscription(subscriptionId) {
    const result = await makeHelixRequest('delete', `/eventsub/subscriptions?id=${subscriptionId}`);
    if (result.success) {
        logger.info({ subscriptionId }, 'EventSub subscription deleted successfully');
    }
    return result;
}

/**
 * Delete all EventSub subscriptions
 */
export async function deleteAllEventSubSubscriptions() {
    const result = await getEventSubSubscriptions();
    if (!result.success || !result.data || !result.data.data) {
        logger.error('Could not fetch subscriptions to delete.');
        return;
    }

    const subscriptions = result.data.data;
    if (subscriptions.length === 0) {
        logger.info('No subscriptions to delete.');
        return;
    }

    for (const sub of subscriptions) {
        await deleteEventSubSubscription(sub.id);
    }
    logger.info(`Deleted ${subscriptions.length} subscriptions.`);
}

const activeDeleteRequests = new Map();

/**
 * Delete all EventSub subscriptions for a specific broadcaster
 * @param {string} broadcasterUserId - The broadcaster's user ID
 * @returns {Promise<{deleted: number, errors: number}>} Count of deleted and failed subscriptions
 */
export async function deleteChannelEventSubSubscriptions(broadcasterUserId) {
    if (activeDeleteRequests.has(broadcasterUserId)) {
        logger.debug({ broadcasterUserId }, 'Subscription deletion already in progress, returning existing promise');
        return activeDeleteRequests.get(broadcasterUserId);
    }

    const deletePromise = (async () => {
        const result = await getEventSubSubscriptions();
    if (!result.success || !result.data || !result.data.data) {
        logger.error({ broadcasterUserId }, 'Could not fetch subscriptions to delete for broadcaster');
        return { deleted: 0, errors: 1 };
    }

    const subscriptions = result.data.data;
    // Filter subscriptions for this broadcaster
    const broadcasterSubs = subscriptions.filter(sub =>
        sub.condition?.broadcaster_user_id === broadcasterUserId
    );

    if (broadcasterSubs.length === 0) {
        logger.info({ broadcasterUserId }, 'No subscriptions found for broadcaster');
        return { deleted: 0, errors: 0 };
    }

    logger.info({ broadcasterUserId, count: broadcasterSubs.length }, 'Deleting EventSub subscriptions for broadcaster');

    let deleted = 0;
    let errors = 0;

    for (const sub of broadcasterSubs) {
        const deleteResult = await deleteEventSubSubscription(sub.id);
        if (deleteResult.success) {
            deleted++;
        } else {
            errors++;
        }
    }

        logger.info({ broadcasterUserId, deleted, errors }, 'Completed deleting EventSub subscriptions for broadcaster');
        return { deleted, errors };
    })();

    activeDeleteRequests.set(broadcasterUserId, deletePromise);
    try {
        return await deletePromise;
    } finally {
        activeDeleteRequests.delete(broadcasterUserId);
    }
}

/**
 * Subscribe to channel.subscribe events (new subscriptions)
 */
export async function subscribeChannelSubscribe(broadcasterUserId) {
    const { publicUrl, eventSubSecret } = config.twitch;
    if (!publicUrl || !eventSubSecret) {
        logger.error('Missing PUBLIC_URL or TWITCH_EVENTSUB_SECRET in config');
        return { success: false, error: 'Missing configuration' };
    }

    const body = {
        type: 'channel.subscribe',
        version: '1',
        condition: { broadcaster_user_id: broadcasterUserId },
        transport: {
            method: 'webhook',
            callback: `${publicUrl}/twitch/event`,
            secret: eventSubSecret
        }
    };

    const result = await makeHelixRequest('post', '/eventsub/subscriptions', body);
    if (result.success) {
        logger.info({ broadcasterUserId, type: 'channel.subscribe' }, 'Successfully subscribed to channel.subscribe');
    }
    return result;
}

/**
 * Subscribe to channel.subscription.message events (resubs with messages)
 */
export async function subscribeChannelSubscriptionMessage(broadcasterUserId) {
    const { publicUrl, eventSubSecret } = config.twitch;
    if (!publicUrl || !eventSubSecret) {
        logger.error('Missing PUBLIC_URL or TWITCH_EVENTSUB_SECRET in config');
        return { success: false, error: 'Missing configuration' };
    }

    const body = {
        type: 'channel.subscription.message',
        version: '1',
        condition: { broadcaster_user_id: broadcasterUserId },
        transport: {
            method: 'webhook',
            callback: `${publicUrl}/twitch/event`,
            secret: eventSubSecret
        }
    };

    const result = await makeHelixRequest('post', '/eventsub/subscriptions', body);
    if (result.success) {
        logger.info({ broadcasterUserId, type: 'channel.subscription.message' }, 'Successfully subscribed to channel.subscription.message');
    }
    return result;
}

/**
 * Subscribe to channel.subscription.gift events (gift subs)
 */
export async function subscribeChannelSubscriptionGift(broadcasterUserId) {
    const { publicUrl, eventSubSecret } = config.twitch;
    if (!publicUrl || !eventSubSecret) {
        logger.error('Missing PUBLIC_URL or TWITCH_EVENTSUB_SECRET in config');
        return { success: false, error: 'Missing configuration' };
    }

    const body = {
        type: 'channel.subscription.gift',
        version: '1',
        condition: { broadcaster_user_id: broadcasterUserId },
        transport: {
            method: 'webhook',
            callback: `${publicUrl}/twitch/event`,
            secret: eventSubSecret
        }
    };

    const result = await makeHelixRequest('post', '/eventsub/subscriptions', body);
    if (result.success) {
        logger.info({ broadcasterUserId, type: 'channel.subscription.gift' }, 'Successfully subscribed to channel.subscription.gift');
    }
    return result;
}

/**
 * Subscribe to channel.cheer events (bits cheers)
 */
export async function subscribeChannelCheer(broadcasterUserId) {
    const { publicUrl, eventSubSecret } = config.twitch;
    if (!publicUrl || !eventSubSecret) {
        logger.error('Missing PUBLIC_URL or TWITCH_EVENTSUB_SECRET in config');
        return { success: false, error: 'Missing configuration' };
    }

    const body = {
        type: 'channel.cheer',
        version: '1',
        condition: { broadcaster_user_id: broadcasterUserId },
        transport: {
            method: 'webhook',
            callback: `${publicUrl}/twitch/event`,
            secret: eventSubSecret
        }
    };

    const result = await makeHelixRequest('post', '/eventsub/subscriptions', body);
    if (result.success) {
        logger.info({ broadcasterUserId, type: 'channel.cheer' }, 'Successfully subscribed to channel.cheer');
    }
    return result;
}

/**
 * Subscribe to channel.raid events (incoming raids)
 */
export async function subscribeChannelRaid(broadcasterUserId) {
    const { publicUrl, eventSubSecret } = config.twitch;
    if (!publicUrl || !eventSubSecret) {
        logger.error('Missing PUBLIC_URL or TWITCH_EVENTSUB_SECRET in config');
        return { success: false, error: 'Missing configuration' };
    }

    const body = {
        type: 'channel.raid',
        version: '1',
        condition: { to_broadcaster_user_id: broadcasterUserId },
        transport: {
            method: 'webhook',
            callback: `${publicUrl}/twitch/event`,
            secret: eventSubSecret
        }
    };

    const result = await makeHelixRequest('post', '/eventsub/subscriptions', body);
    if (result.success) {
        logger.info({ broadcasterUserId, type: 'channel.raid' }, 'Successfully subscribed to channel.raid');
    }
    return result;
}

/**
 * Subscribe to channel.follow events (v2 - requires moderator scope)
 */
export async function subscribeChannelFollow(broadcasterUserId) {
    const { publicUrl, eventSubSecret } = config.twitch;
    if (!publicUrl || !eventSubSecret) {
        logger.error('Missing PUBLIC_URL or TWITCH_EVENTSUB_SECRET in config');
        return { success: false, error: 'Missing configuration' };
    }

    const body = {
        type: 'channel.follow',
        version: '2',
        condition: {
            broadcaster_user_id: broadcasterUserId,
            moderator_user_id: broadcasterUserId // Use broadcaster as moderator
        },
        transport: {
            method: 'webhook',
            callback: `${publicUrl}/twitch/event`,
            secret: eventSubSecret
        }
    };

    // Use app access token (required for webhook subscriptions). The app must have been granted moderator:read:followers scope.
    const result = await makeHelixRequest('post', '/eventsub/subscriptions', body);

    if (result.success) {
        logger.info({ broadcasterUserId, type: 'channel.follow' }, 'Successfully subscribed to channel.follow (v2)');
    }
    return result;
}

/**
 * Subscribe to channel.channel_points_custom_reward_redemption.add events
 * (New redemptions - both fulfilled and unfulfilled)
 */
export async function subscribeChannelPointsRedemptionAdd(broadcasterUserId) {
    const { publicUrl, eventSubSecret } = config.twitch;
    if (!publicUrl || !eventSubSecret) {
        logger.error('Missing PUBLIC_URL or TWITCH_EVENTSUB_SECRET in config');
        return { success: false, error: 'Missing configuration' };
    }

    const body = {
        type: 'channel.channel_points_custom_reward_redemption.add',
        version: '1',
        condition: { broadcaster_user_id: broadcasterUserId },
        transport: {
            method: 'webhook',
            callback: `${publicUrl}/twitch/event`,
            secret: eventSubSecret
        }
    };

    const result = await makeHelixRequest('post', '/eventsub/subscriptions', body);
    if (result.success) {
        logger.info({ broadcasterUserId, type: 'channel.channel_points_custom_reward_redemption.add' }, 'Successfully subscribed to channel points redemption.add');
    }
    return result;
}

/**
 * Subscribe to channel.channel_points_custom_reward_redemption.update events
 * (Redemption status changes - approval, cancellation, etc.)
 */
export async function subscribeChannelPointsRedemptionUpdate(broadcasterUserId) {
    const { publicUrl, eventSubSecret } = config.twitch;
    if (!publicUrl || !eventSubSecret) {
        logger.error('Missing PUBLIC_URL or TWITCH_EVENTSUB_SECRET in config');
        return { success: false, error: 'Missing configuration' };
    }

    const body = {
        type: 'channel.channel_points_custom_reward_redemption.update',
        version: '1',
        condition: { broadcaster_user_id: broadcasterUserId },
        transport: {
            method: 'webhook',
            callback: `${publicUrl}/twitch/event`,
            secret: eventSubSecret
        }
    };

    const result = await makeHelixRequest('post', '/eventsub/subscriptions', body);
    if (result.success) {
        logger.info({ broadcasterUserId, type: 'channel.channel_points_custom_reward_redemption.update' }, 'Successfully subscribed to channel points redemption.update');
    }
    return result;
}

/**
 * Subscribe to a chat-based EventSub type (channel.chat.message, channel.chat.notification, etc.)
 * These all use the same condition (broadcaster_user_id + bot user_id) and scopes.
 * @param {string} broadcasterUserId - The broadcaster's user ID
 * @param {string} eventType - The EventSub subscription type string
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function subscribeChatEventType(broadcasterUserId, eventType) {
    const { publicUrl, eventSubSecret } = config.twitch;
    if (!publicUrl || !eventSubSecret) {
        logger.error('Missing PUBLIC_URL or TWITCH_EVENTSUB_SECRET in config');
        return { success: false, error: 'Missing configuration' };
    }

    // Get the bot's user ID
    const { getBotUserId } = await import('./chatClient.js');
    const botUserId = await getBotUserId();
    if (!botUserId) {
        logger.error({ eventType }, `Could not determine bot user ID for ${eventType} subscription`);
        return { success: false, error: 'Could not determine bot user ID' };
    }

    const body = {
        type: eventType,
        version: '1',
        condition: {
            broadcaster_user_id: broadcasterUserId,
            user_id: botUserId // The bot's user ID (must have granted user:read:chat scope)
        },
        transport: {
            method: 'webhook',
            callback: `${publicUrl}/twitch/event`,
            secret: eventSubSecret
        }
    };

    // Use app access token (required for webhook subscriptions)
    // The app must be categorized as "Chat Bot" in Twitch Developer Console
    const result = await makeHelixRequest('post', '/eventsub/subscriptions', body);
    if (result.success) {
        logger.info({ broadcasterUserId, botUserId, type: eventType }, `Successfully subscribed to ${eventType}`);
    }
    return result;
}

/**
 * Subscribe to channel.chat.message events (chat messages)
 * Requires app to be categorized as "Chat Bot" and bot user to have user:read:chat scope
 */
export async function subscribeChannelChatMessage(broadcasterUserId) {
    return subscribeChatEventType(broadcasterUserId, 'channel.chat.message');
}

/**
 * Subscribe to channel.chat.notification events (watch streaks, etc.)
 * Uses same condition and scopes as channel.chat.message
 */
export async function subscribeChannelChatNotification(broadcasterUserId) {
    return subscribeChatEventType(broadcasterUserId, 'channel.chat.notification');
}

const activeSubscriptionRequests = new Map(); // broadcasterUserId -> Promise

/**
 * Subscribe a channel to all TTS-relevant events
 * @param {string} broadcasterUserId - The broadcaster's user ID
 * @param {object} options - Optional flags for which events to subscribe to
 * @returns {Promise<object>} Results of all subscription attempts
 */
export async function subscribeChannelToTtsEvents(broadcasterUserId, options = {}) {
    if (activeSubscriptionRequests.has(broadcasterUserId)) {
        logger.debug({ broadcasterUserId }, 'Subscription sync already in progress, returning existing promise');
        return activeSubscriptionRequests.get(broadcasterUserId);
    }

    const syncPromise = (async () => {
    // Check if the broadcaster has authorized scopes via OAuth.
    // Scope-gated subscription types (subscribe, cheer, follow, channel points)
    // require the broadcaster to have granted specific OAuth scopes to the app.
    // Without authorization, these calls always return 403 Forbidden.
    const hasBroadcasterAuth = await hasBroadcasterOAuth(broadcasterUserId);

    if (!hasBroadcasterAuth) {
        // List the scope-gated types being skipped for visibility
        const skippedTypes = [
            'channel.subscribe', 'channel.subscription.message', 'channel.subscription.gift',
            'channel.cheer', 'channel.follow', 'channel.channel_points_custom_reward_redemption.add',
            'channel.channel_points_custom_reward_redemption.update'
        ];
        logger.info({
            broadcasterUserId,
            skippedTypes,
            reason: 'Broadcaster has not completed OAuth — scope-gated subscriptions skipped'
        }, `Skipping ${skippedTypes.length} scope-gated EventSub subscriptions (broadcaster not authorized)`);
    }

    const {
        subscribe = hasBroadcasterAuth,     // channel.subscribe (requires channel:read:subscriptions)
        resubscribe = hasBroadcasterAuth,   // channel.subscription.message (requires channel:read:subscriptions)
        giftSub = hasBroadcasterAuth,       // channel.subscription.gift (requires channel:read:subscriptions)
        cheer = hasBroadcasterAuth,         // channel.cheer (requires bits:read)
        raid = true,                        // channel.raid (no scope needed)
        follow = hasBroadcasterAuth,        // channel.follow v2 (requires moderator:read:followers)
        channelPointsAdd = hasBroadcasterAuth,    // channel points add (requires channel:read:redemptions)
        channelPointsUpdate = hasBroadcasterAuth, // channel points update (requires channel:read:redemptions)
        chatMessage = true,                 // channel.chat.message (requires bot user scopes, not broadcaster)
        chatNotification = true             // channel.chat.notification (same scopes as chatMessage)
    } = options;

    const results = {
        successful: [],
        failed: [],
        broadcasterUserId
    };

    // Subscribe to selected events
    if (chatMessage) {
        const result = await subscribeChannelChatMessage(broadcasterUserId);
        if (result.success) {
            results.successful.push('channel.chat.message');
        } else {
            results.failed.push({ type: 'channel.chat.message', error: result.error });
        }
    }

    if (subscribe) {
        const result = await subscribeChannelSubscribe(broadcasterUserId);
        if (result.success) {
            results.successful.push('channel.subscribe');
        } else {
            results.failed.push({ type: 'channel.subscribe', error: result.error });
        }
    }

    if (resubscribe) {
        const result = await subscribeChannelSubscriptionMessage(broadcasterUserId);
        if (result.success) {
            results.successful.push('channel.subscription.message');
        } else {
            results.failed.push({ type: 'channel.subscription.message', error: result.error });
        }
    }

    if (giftSub) {
        const result = await subscribeChannelSubscriptionGift(broadcasterUserId);
        if (result.success) {
            results.successful.push('channel.subscription.gift');
        } else {
            results.failed.push({ type: 'channel.subscription.gift', error: result.error });
        }
    }

    if (cheer) {
        const result = await subscribeChannelCheer(broadcasterUserId);
        if (result.success) {
            results.successful.push('channel.cheer');
        } else {
            results.failed.push({ type: 'channel.cheer', error: result.error });
        }
    }

    if (raid) {
        const result = await subscribeChannelRaid(broadcasterUserId);
        if (result.success) {
            results.successful.push('channel.raid');
        } else {
            results.failed.push({ type: 'channel.raid', error: result.error });
        }
    }

    if (follow) {
        const result = await subscribeChannelFollow(broadcasterUserId);
        if (result.success) {
            results.successful.push('channel.follow');
        } else {
            results.failed.push({ type: 'channel.follow', error: result.error });
        }
    }

    if (channelPointsAdd) {
        const result = await subscribeChannelPointsRedemptionAdd(broadcasterUserId);
        if (result.success) {
            results.successful.push('channel.channel_points_custom_reward_redemption.add');
        } else {
            results.failed.push({ type: 'channel.channel_points_custom_reward_redemption.add', error: result.error });
        }
    }

    if (chatNotification) {
        const result = await subscribeChannelChatNotification(broadcasterUserId);
        if (result.success) {
            results.successful.push('channel.chat.notification');
        } else {
            results.failed.push({ type: 'channel.chat.notification', error: result.error });
        }
    }

    if (channelPointsUpdate) {
        const result = await subscribeChannelPointsRedemptionUpdate(broadcasterUserId);
        if (result.success) {
            results.successful.push('channel.channel_points_custom_reward_redemption.update');
        } else {
            results.failed.push({ type: 'channel.channel_points_custom_reward_redemption.update', error: result.error });
        }
    }

    // Log completion summary
    logger.info({
        broadcasterUserId,
        successful: results.successful.length,
        failed: results.failed.length,
        types: results.successful
    }, 'TTS EventSub subscriptions completed');

    // Log failures prominently, especially critical ones
    if (results.failed.length > 0) {
        const criticalTypes = ['channel.chat.message', 'channel.chat.notification'];

        for (const criticalType of criticalTypes) {
            const failure = results.failed.find(f => f.type === criticalType);
            if (failure) {
                logger.error({
                    broadcasterUserId,
                    error: failure.error,
                    type: criticalType
                }, `CRITICAL: Failed to subscribe to ${criticalType} - watch streak and/or chat events will not be received!`);
            }
        }

        // Log all other failures as warnings
        results.failed.forEach(failure => {
            if (!criticalTypes.includes(failure.type)) {
                logger.warn({
                    broadcasterUserId,
                    type: failure.type,
                    error: failure.error
                }, `EventSub subscription failed: ${failure.type}`);
            }
        });
    }
        return results;
    })();

    activeSubscriptionRequests.set(broadcasterUserId, syncPromise);
    try {
        return await syncPromise;
    } finally {
        activeSubscriptionRequests.delete(broadcasterUserId);
    }
}

/**
 * Subscribe all managed channels to TTS events
 */
export async function subscribeAllManagedChannelsToTtsEvents() {
    try {
        const { getActiveManagedChannels } = await import('./channelManager.js');
        const activeChannels = await getActiveManagedChannels();
        const results = { successful: [], failed: [], total: activeChannels.length };

        for (const channelName of activeChannels) {
            try {
                const userResponseArray = await getUsersByLogin([channelName]);
                if (!userResponseArray || userResponseArray.length === 0) {
                    logger.warn({ channelName }, 'Could not find user ID for channel');
                    results.failed.push({ channel: channelName, error: 'User not found' });
                    continue;
                }

                const userId = userResponseArray[0].id;
                const subResults = await subscribeChannelToTtsEvents(userId);

                // Classify: if all succeeded, it's successful.
                // If some failed but critical types (chat) succeeded, it's partial.
                // If critical types failed, it's a real failure.
                const criticalTypes = ['channel.chat.message', 'channel.chat.notification'];
                const hasCriticalFailure = subResults.failed.some(f => criticalTypes.includes(f.type));

                if (subResults.failed.length === 0) {
                    results.successful.push({ channel: channelName, userId, events: subResults.successful });
                } else if (!hasCriticalFailure) {
                    // Partial success — critical types registered, optional scope-gated types may have been skipped
                    // Check if failures are 403s (stale/revoked broadcaster OAuth)
                    const oauthFailures = subResults.failed.filter(f => f.status === 403);
                    if (oauthFailures.length > 0) {
                        logger.error({
                            channelName,
                            userId,
                            failedTypes: oauthFailures.map(f => f.type)
                        }, 'Broadcaster OAuth appears stale/revoked — scope-gated subscriptions failed with 403');
                    }
                    results.successful.push({
                        channel: channelName,
                        userId,
                        events: subResults.successful,
                        skippedOptional: subResults.failed.map(f => f.type)
                    });
                    logger.info({
                        channelName,
                        userId,
                        succeeded: subResults.successful,
                        failed: subResults.failed.map(f => f.type)
                    }, 'Channel subscribed with partial success (non-critical types skipped)');
                } else {
                    results.failed.push({ channel: channelName, error: 'Critical subscriptions failed', details: subResults.failed });
                }
            } catch (error) {
                logger.error({ err: error, channelName }, 'Error subscribing channel to TTS EventSub');
                results.failed.push({ channel: channelName, error: error.message });
            }
        }

        logger.info({
            successful: results.successful.length,
            failed: results.failed.length,
            total: results.total
        }, 'Batch TTS EventSub subscription completed');

        return results;
    } catch (error) {
        logger.error({ err: error }, 'Error in subscribeAllManagedChannelsToTtsEvents');
        return { successful: [], failed: [], total: 0, error: error.message };
    }
}
