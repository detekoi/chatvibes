// src/components/twitch/twitchSubs.js
// Twitch EventSub subscription management for TTS event announcements

import axios from 'axios';
import { getHelixClient, getUsersByLogin } from './helixClient.js';
import { refreshIrcToken } from './ircAuthHelper.js';
import logger from '../../lib/logger.js';
import config from '../../config/index.js';

/**
 * Get bot's user access token (required for EventSub subscriptions with user-level scopes)
 */
async function getBotUserAccessToken() {
    try {
        // refreshIrcToken returns the access token without oauth: prefix
        const token = await refreshIrcToken();
        if (!token) {
            throw new Error('Failed to get bot user access token');
        }
        return token;
    } catch (error) {
        logger.error({ err: error }, 'Error getting bot user access token');
        return null;
    }
}

/**
 * Make a Twitch Helix API request with user access token
 * (Required for EventSub subscriptions with channel:read:subscriptions, bits:read, etc.)
 */
async function makeHelixRequestWithUserToken(method, endpoint, body = null) {
    try {
        const userToken = await getBotUserAccessToken();
        if (!userToken) {
            throw new Error('Failed to obtain user access token');
        }

        const response = await axios({
            method,
            url: `https://api.twitch.tv/helix${endpoint}`,
            data: body,
            headers: {
                'Authorization': `Bearer ${userToken}`,
                'Client-ID': config.twitch.clientId,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });

        return { success: true, data: response.data };
    } catch (error) {
        logger.error({
            err: error.response ? error.response.data : error.message,
            method,
            endpoint
        }, 'Error making Helix request with user token');
        return { success: false, error: error.message };
    }
}

/**
 * Make a Twitch Helix API request (uses app token)
 */
async function makeHelixRequest(method, endpoint, body = null) {
    try {
        const helixClient = getHelixClient();
        const response = await helixClient({ method, url: endpoint, data: body });
        return { success: true, data: response.data };
    } catch (error) {
        logger.error({
            err: error.response ? error.response.data : error.message,
            method,
            endpoint
        }, 'Error making Helix request');
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

    const result = await makeHelixRequest('post', '/eventsub/subscriptions', body);
    if (result.success) {
        logger.info({ broadcasterUserId, type: 'channel.follow' }, 'Successfully subscribed to channel.follow (v2)');
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
        subscribe = true,      // channel.subscribe
        resubscribe = true,    // channel.subscription.message
        giftSub = true,        // channel.subscription.gift
        cheer = true,          // channel.cheer
        raid = true,           // channel.raid
        follow = false         // channel.follow (disabled by default - requires moderator scope)
    } = options;

    const results = {
        successful: [],
        failed: [],
        broadcasterUserId
    };

    // Subscribe to selected events
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

    logger.info({
        broadcasterUserId,
        successful: results.successful.length,
        failed: results.failed.length,
        types: results.successful
    }, 'TTS EventSub subscriptions completed');

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
