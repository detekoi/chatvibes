// src/components/twitch/twitchSubs.js
// Twitch EventSub subscription management for TTS event announcements

import axios from 'axios';
import { getHelixClient, getUsersByLogin } from './helixClient.js';

import { getClientId } from './tokenManager.js';
import logger from '../../lib/logger.js';
import config from '../../config/index.js';

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

        logger.error({
            err: error.response ? error.response.data : error.message,
            method,
            endpoint
        }, 'Error making Helix request');
        return { success: false, error: error.message };
    }
}

/**
 * Get broadcaster's user access token from Firestore
 * @param {string} broadcasterUserId - The broadcaster's Twitch user ID
 * @returns {Promise<string|null>} The access token or null if not found
 */
async function getBroadcasterAccessToken(broadcasterUserId) {
    try {
        const { Firestore } = await import('@google-cloud/firestore');
        const db = new Firestore();

        const oauthDoc = await db.collection('users').doc(broadcasterUserId)
            .collection('private').doc('oauth').get();

        if (!oauthDoc.exists) {
            logger.warn({ broadcasterUserId }, 'Broadcaster access token not found in Firestore');
            return null;
        }

        const accessToken = oauthDoc.data()?.twitchAccessToken;
        if (!accessToken) {
            logger.warn({ broadcasterUserId }, 'Broadcaster OAuth doc exists but no access token');
            return null;
        }

        return accessToken.trim();
    } catch (error) {
        logger.error({ err: error, broadcasterUserId }, 'Error retrieving broadcaster access token');
        return null;
    }
}

/**
 * Make a Twitch Helix API request with broadcaster's user access token
 * (Required for EventSub subscriptions with scope requirements)
 */
async function makeHelixRequestWithBroadcasterToken(method, endpoint, body, broadcasterUserId) {
    try {
        const userToken = await getBroadcasterAccessToken(broadcasterUserId);
        if (!userToken) {
            return { success: false, error: 'Broadcaster access token not available' };
        }

        // Use the web UI's Client ID (same one that generated the broadcaster token)
        const clientId = await getClientId();

        const response = await axios({
            method,
            url: `https://api.twitch.tv/helix${endpoint}`,
            data: body,
            headers: {
                'Authorization': `Bearer ${userToken}`,
                'Client-ID': clientId,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });

        return { success: true, data: response.data };
    } catch (error) {
        // 409 Conflict means the subscription already exists - treat as success
        if (error.response && error.response.status === 409) {
            logger.debug({
                method,
                endpoint,
                type: body?.type,
                broadcasterUserId
            }, 'EventSub subscription already exists (409) - treating as success');
            return { success: true, data: error.response.data };
        }

        logger.error({
            err: error.response ? error.response.data : error.message,
            method,
            endpoint,
            broadcasterUserId
        }, 'Error making Helix request with broadcaster token');
        return { success: false, error: error.message };
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

/**
 * Delete all EventSub subscriptions for a specific broadcaster
 * @param {string} broadcasterUserId - The broadcaster's user ID
 * @returns {Promise<{deleted: number, errors: number}>} Count of deleted and failed subscriptions
 */
export async function deleteChannelEventSubSubscriptions(broadcasterUserId) {
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
 * Subscribe to channel.chat.message events (chat messages)
 * Requires app to be categorized as "Chat Bot" and bot user to have user:read:chat scope
 */
export async function subscribeChannelChatMessage(broadcasterUserId) {
    const { publicUrl, eventSubSecret } = config.twitch;
    if (!publicUrl || !eventSubSecret) {
        logger.error('Missing PUBLIC_URL or TWITCH_EVENTSUB_SECRET in config');
        return { success: false, error: 'Missing configuration' };
    }

    // Get the bot's user ID
    const { getBotUserId } = await import('./chatClient.js');
    const botUserId = await getBotUserId();
    if (!botUserId) {
        logger.error('Could not determine bot user ID for channel.chat.message subscription');
        return { success: false, error: 'Could not determine bot user ID' };
    }

    const body = {
        type: 'channel.chat.message',
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
        logger.info({ broadcasterUserId, botUserId, type: 'channel.chat.message' }, 'Successfully subscribed to channel.chat.message');
    }
    return result;
}

/**
 * Subscribe a channel to all TTS-relevant events
 * @param {string} broadcasterUserId - The broadcaster's user ID
 * @param {object} options - Optional flags for which events to subscribe to
 * @returns {Promise<object>} Results of all subscription attempts
 */
export async function subscribeChannelToTtsEvents(broadcasterUserId, options = {}) {
    const {
        subscribe = true,           // channel.subscribe
        resubscribe = true,         // channel.subscription.message
        giftSub = true,             // channel.subscription.gift
        cheer = true,               // channel.cheer
        raid = true,                // channel.raid
        follow = true,              // channel.follow (v2 - uses broadcaster token with moderator:read:followers scope)
        channelPointsAdd = true,    // channel.channel_points_custom_reward_redemption.add
        channelPointsUpdate = true, // channel.channel_points_custom_reward_redemption.update
        chatMessage = true          // channel.chat.message (NEW: default true)
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
        const chatMessageFailed = results.failed.find(f => f.type === 'channel.chat.message');

        if (chatMessageFailed) {
            // CRITICAL: channel.chat.message is essential for receiving chat
            logger.error({
                broadcasterUserId,
                error: chatMessageFailed.error,
                type: 'channel.chat.message'
            }, 'CRITICAL: Failed to subscribe to channel.chat.message - channel will not receive chat messages!');
        }

        // Log all other failures as warnings
        results.failed.forEach(failure => {
            if (failure.type !== 'channel.chat.message') {
                logger.warn({
                    broadcasterUserId,
                    type: failure.type,
                    error: failure.error
                }, `EventSub subscription failed: ${failure.type}`);
            }
        });
    }

    return results;
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

                if (subResults.failed.length === 0) {
                    results.successful.push({ channel: channelName, userId, events: subResults.successful });
                } else {
                    results.failed.push({ channel: channelName, error: 'Some subscriptions failed', details: subResults.failed });
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
