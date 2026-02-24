// src/components/twitch/handlers/redemptionHandler.js
// Handles Channel Points custom reward redemption events

import logger from '../../../lib/logger.js';
import * as redemptionCache from '../redemptionCache.js';
import { isChannelAllowed } from '../../../lib/allowList.js';
import { getTtsState } from '../../tts/ttsState.js';
import { publishTtsEvent } from '../../../lib/pubsub.js';
import { processMessageUrls } from '../../../lib/urlProcessor.js';
import { getSharedSessionInfo } from '../eventUtils.js';

/**
 * Handle Channel Points custom reward redemption events
 * This is the NEW implementation that uses EventSub instead of chat messages
 */
export async function handleChannelPointsRedemption(subscriptionType, event) {
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

            // Store rewardId along with redemption for later rejection if needed
            redemptionCache.addRedemption(redemptionId, userInput, userName, channelLogin, rewardId);
        } else if (status === 'fulfilled') {
            // Redemption was auto-approved (Skip Queue enabled) - validate and play immediately
            logger.info({
                channelLogin,
                userName,
                redemptionId,
                textPreview: userInput?.substring(0, 30)
            }, 'Channel Points redemption auto-approved - validating and playing');

            await processTtsRedemption(channelLogin, userInput, userName, ttsConfig, redemptionId, rewardId);
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
                }, 'Channel Points redemption approved by streamer - validating and playing TTS');

                await processTtsRedemption(
                    cachedRedemption.channelName,
                    cachedRedemption.userInput,
                    cachedRedemption.userName,
                    ttsConfig,
                    redemptionId,
                    cachedRedemption.rewardId || rewardId
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
 * Handle Channel Points redemption announcement via TTS
 * Announces ALL reward redemptions (not just the configured TTS reward)
 * Generates announcement text like "<user> redeemed <reward title>: <user input>"
 */
export async function handleRedemptionAnnouncement(subscriptionType, event, channelLogin, ttsConfig) {
    // Only announce on redemption.add events
    if (subscriptionType !== 'channel.channel_points_custom_reward_redemption.add') {
        return;
    }

    const rewardTitle = event?.reward?.title;
    const rewardId = event?.reward?.id;
    const userInput = (event?.user_input || '').trim();
    const userName = event?.user_name || event?.user_login || 'Someone';

    // Skip if this is the configured TTS reward (already handled by handleChannelPointsRedemption)
    const configuredRewardId = ttsConfig.channelPoints?.rewardId || ttsConfig.channelPointRewardId;
    if (configuredRewardId && rewardId === configuredRewardId) {
        logger.debug({ channelLogin, rewardId }, 'Skipping redemption announcement for configured TTS reward');
        return;
    }

    if (!rewardTitle) {
        logger.debug({ channelLogin }, 'Redemption event missing reward title - skipping announcement');
        return;
    }

    // Build announcement text
    let ttsText = `${userName} redeemed ${rewardTitle}`;
    if (userInput) {
        ttsText += `: ${userInput}`;
    }

    logger.info({ channelLogin, userName, rewardTitle, hasUserInput: !!userInput }, 'Announcing Channel Points redemption via TTS');

    // Get shared session info for distribution
    const sharedSessionInfo = await getSharedSessionInfo(channelLogin);

    await publishTtsEvent(channelLogin, {
        text: ttsText,
        user: userName,
        type: 'event'
    }, sharedSessionInfo);
}

/**
 * Get user access token for broadcaster from Firestore
 * This retrieves the broadcaster's OAuth token with channel:manage:redemptions scope
 */
async function getBroadcasterAccessToken(channelLogin) {
    try {
        // Dynamically import Firestore
        const { Firestore } = await import('@google-cloud/firestore');
        const db = new Firestore();

        // Get user document from managedChannels collection
        const userDoc = await db.collection('managedChannels').doc(channelLogin).get();

        if (!userDoc.exists) {
            logger.warn({ channelLogin }, 'Broadcaster not found in managedChannels - cannot get user token');
            return null;
        }

        const userData = userDoc.data();
        const { twitchUserId, needsTwitchReAuth } = userData;

        if (needsTwitchReAuth) {
            logger.warn({ channelLogin }, 'Broadcaster needs to re-authenticate - cannot reject redemption');
            return null;
        }

        if (!twitchUserId) {
            logger.warn({ channelLogin }, 'Broadcaster missing twitchUserId');
            return null;
        }

        // Get access token from Firestore (migrated from Secret Manager)
        const oauthDoc = await db.collection('users').doc(twitchUserId)
            .collection('private').doc('oauth').get();

        if (!oauthDoc.exists) {
            logger.warn({ channelLogin, twitchUserId }, 'Broadcaster OAuth tokens not found in Firestore');
            return null;
        }

        const accessToken = oauthDoc.data()?.twitchAccessToken;
        if (accessToken) {
            logger.debug({ channelLogin }, 'Retrieved broadcaster access token from Firestore');
            return accessToken.trim();
        } else {
            logger.warn({ channelLogin, twitchUserId }, 'Broadcaster OAuth doc exists but no access token');
            return null;
        }
    } catch (error) {
        logger.error({
            err: error,
            channelLogin
        }, 'Error getting broadcaster access token');
        return null;
    }
}

/**
 * Reject a Channel Points redemption via Twitch API
 * Requires broadcaster's user access token with channel:manage:redemptions scope
 */
async function rejectRedemption(channelLogin, redemptionId, rewardId, reason) {
    try {
        const { getUsersByLogin } = await import('../helixClient.js');
        const { getClientId } = await import('../auth.js');

        const users = await getUsersByLogin([channelLogin]);
        if (!users || users.length === 0) {
            logger.warn({ channelLogin }, 'Cannot reject redemption - broadcaster user ID not found');
            return false;
        }

        const broadcasterId = users[0].id;

        // Get broadcaster's user access token (not app access token!)
        const token = await getBroadcasterAccessToken(channelLogin);
        if (!token) {
            logger.warn({
                channelLogin,
                redemptionId,
                reason
            }, 'Cannot reject redemption - broadcaster access token not available (may need to re-authenticate)');
            return false;
        }

        const clientId = await getClientId();

        const axios = (await import('axios')).default;
        const url = `https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions?broadcaster_id=${encodeURIComponent(broadcasterId)}&reward_id=${encodeURIComponent(rewardId)}&id=${encodeURIComponent(redemptionId)}`;

        await axios.patch(url, {
            status: 'CANCELED'
        }, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Client-ID': clientId,
                'Content-Type': 'application/json'
            },
            timeout: 10000
        });

        logger.info({
            channelLogin,
            redemptionId,
            reason
        }, 'Rejected Channel Points redemption and refunded points');

        return true;
    } catch (error) {
        logger.error({
            err: error,
            channelLogin,
            redemptionId,
            status: error.response?.status,
            data: error.response?.data
        }, 'Failed to reject Channel Points redemption via Twitch API');
        return false;
    }
}

/**
 * Process a TTS redemption (apply content policy and enqueue for playback)
 * Returns validation result: { ok: boolean, reason?: string }
 */
async function processTtsRedemption(channelLogin, userInput, userName, ttsConfig, redemptionId = null, rewardId = null) {
    const redeemMessage = (userInput || '').trim();

    if (redeemMessage.length === 0) {
        logger.debug({ channelLogin, userName }, 'Empty redemption message - rejecting');
        if (redemptionId && rewardId) {
            await rejectRedemption(channelLogin, redemptionId, rewardId, 'Message is empty');
        }
        return { ok: false, reason: 'Message is empty' };
    }

    // Enforce content policy if configured
    const policy = (ttsConfig.channelPoints && ttsConfig.channelPoints.contentPolicy) || {};
    const blockLinks = policy.blockLinks !== false; // default block links
    const bannedWords = Array.isArray(policy.bannedWords) ? policy.bannedWords : [];

    // Note: Twitch enforces 500 character limit on redemption input, so we don't need to validate length here
    // If a message exceeds 500 chars, Twitch won't allow the redemption in the first place

    if (blockLinks && /\bhttps?:\/\//i.test(redeemMessage)) {
        const reason = 'Message contains blocked link';
        logger.info({ channelLogin, userName, redemptionId }, reason);
        if (redemptionId && rewardId) {
            await rejectRedemption(channelLogin, redemptionId, rewardId, reason);
        }
        return { ok: false, reason };
    }

    const lowered = redeemMessage.toLowerCase();
    if (bannedWords.some(w => w && lowered.includes(String(w).toLowerCase()))) {
        const reason = 'Message contains banned word';
        logger.info({ channelLogin, userName, redemptionId }, reason);
        if (redemptionId && rewardId) {
            await rejectRedemption(channelLogin, redemptionId, rewardId, reason);
        }
        return { ok: false, reason };
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

    return { ok: true };
}
