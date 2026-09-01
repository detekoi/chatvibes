// src/components/twitch/handlers/redemptionHandler.js
// Handles Channel Points custom reward redemption events

import logger from '../../../lib/logger.js';
import * as redemptionCache from '../redemptionCache.js';
import { isChannelActive } from '../../../lib/allowList.js';
import { getTtsState, getUserEmoteModePreference } from '../../tts/ttsState.js';
import { dispatchTtsEvent } from '../../../lib/ttsDispatch.js';
import { getSharedSessionInfo } from '../eventUtils.js';
import { formatTtsText } from '../../../lib/formatTtsText.js';
import { getPronunciationRules } from '../../../lib/textRewrite/pronunciation.js';
import { consumeFragments } from '../redemptionFragmentCache.js';
import { isTwitchUserIgnored } from '../../../lib/ignoreList.js';
import { isRewardMuted } from '../../../lib/rewardMuteList.js';
import { getTranslator, resolveChannelLocale } from '../../../i18n/index.js';
import { getBroadcasterAccessToken } from '../broadcasterToken.js';

// Redemption IDs already announced, so a redemption can't be announced twice.
// Twitch's docs don't state whether an auto-fulfilled (skip-queue) redemption also
// emits an .update alongside its .add; if it does, the two arrive seconds apart on
// the same instance and the second is suppressed here. A queued redemption approved
// minutes later may land on a different instance and miss this guard — that fails
// toward announcing, which is the behavior we want.
const announcedRedemptions = new Map(); // redemptionId -> timestamp
const ANNOUNCED_TTL_MS = 15 * 60 * 1000;

function markAnnounced(redemptionId) {
    if (!redemptionId) return;
    announcedRedemptions.set(redemptionId, Date.now());
}

function wasAnnounced(redemptionId) {
    if (!redemptionId) return false;
    const at = announcedRedemptions.get(redemptionId);
    if (at === undefined) return false;
    if (Date.now() - at > ANNOUNCED_TTL_MS) {
        announcedRedemptions.delete(redemptionId);
        return false;
    }
    return true;
}

const announcedPruneInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, at] of announcedRedemptions.entries()) {
        if (now - at > ANNOUNCED_TTL_MS) announcedRedemptions.delete(id);
    }
}, ANNOUNCED_TTL_MS);
announcedPruneInterval.unref();

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
    const userId = event?.user_id;
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

    // Verify the bot is switched on for this channel (by broadcaster ID). Being
    // on the allow-list is not enough: a deactivated channel stays approved.
    const broadcasterId = event?.broadcaster_user_id;
    if (!broadcasterId || !isChannelActive(broadcasterId)) {
        logger.debug({ channelLogin, broadcasterId, subscriptionType }, 'Channel Points event for inactive or non-allowed channel - ignoring');
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
    if (isTwitchUserIgnored(ttsConfig, userId)) {
        logger.debug({ channelLogin, userName, userId }, 'User is on ignore list - skipping TTS');
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

            // Store rewardId along with redemption for later rejection if needed.
            // Also grab any fragments the chatHandler may have cached (best-effort,
            // see redemptionFragmentCache.js for multi-instance caveats).
            const cachedFragments = consumeFragments(rewardId, userId, channelLogin);
            redemptionCache.addRedemption(redemptionId, userInput, userName, channelLogin, rewardId, userId, cachedFragments);
        } else if (status === 'fulfilled') {
            // Redemption was auto-approved (Skip Queue enabled) - validate and play immediately
            logger.info({
                channelLogin,
                userName,
                redemptionId,
                textPreview: userInput?.substring(0, 30)
            }, 'Channel Points redemption auto-approved - validating and playing');

            await processTtsRedemption(channelLogin, userInput, userName, ttsConfig, redemptionId, rewardId, userId);
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
                    cachedRedemption.rewardId || rewardId,
                    cachedRedemption.userId || userId
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
 *
 * A redemption of a reward that skips Twitch's request queue arrives as
 * .add + fulfilled and is announced outright. One that does not skip the queue
 * arrives as .add + unfulfilled, and `announceUnfulfilledRedemptions` decides when
 * it is spoken:
 *
 *   on (default)          announce on .add whatever the status; every .update is
 *                         an echo of an announcement already made, so it is dropped
 *   off                   .add + unfulfilled stays silent and stashes its fragments
 *                         until .update + fulfilled says the streamer accepted it;
 *                         .update + canceled drops the stashed entry unannounced
 *
 * It defaults to on because a channel that never works its reward queue would
 * otherwise hear nothing at all from those rewards, which is indistinguishable
 * from the bot being broken. Switching it off buys back the ability to reject a
 * redemption before it is spoken, at the cost of that silence.
 */
export async function handleRedemptionAnnouncement(subscriptionType, event, channelLogin, ttsConfig) {
    const isAdd = subscriptionType === 'channel.channel_points_custom_reward_redemption.add';
    const isUpdate = subscriptionType === 'channel.channel_points_custom_reward_redemption.update';
    if (!isAdd && !isUpdate) {
        return;
    }

    const status = event?.status;
    const redemptionId = event?.id;
    const rewardTitle = event?.reward?.title;
    const rewardId = event?.reward?.id;
    const userInput = (event?.user_input || '').trim();
    const locale = resolveChannelLocale(ttsConfig);
    const t = getTranslator(locale);
    const userName = event?.user_name || event?.user_login || t('announce.fallback.someone');
    const userLogin = (event?.user_login || userName).toLowerCase();
    const userId = event?.user_id;

    // Skip if this is the configured TTS reward (already handled by handleChannelPointsRedemption).
    // This must come before any cache access below — handleChannelPointsRedemption runs first for
    // that reward and owns both the fragment cache and the redemption cache entry.
    const configuredRewardId = ttsConfig.channelPoints?.rewardId || ttsConfig.channelPointRewardId;
    if (configuredRewardId && rewardId === configuredRewardId) {
        logger.debug({ channelLogin, rewardId }, 'Skipping redemption announcement for configured TTS reward');
        return;
    }

    // A muted reward (a soundboard, say) is never announced, on either path.
    // Checked before the pending-approval stash below so a muted redemption is
    // not held and then spoken on approval; the removeRedemption covers an
    // entry stashed before the reward was muted.
    if (isRewardMuted(ttsConfig, rewardId)) {
        if (redemptionId) redemptionCache.removeRedemption(redemptionId);
        logger.debug({ channelLogin, rewardId, rewardTitle }, 'Reward is muted — skipping redemption announcement');
        return;
    }

    // Opt-out, not opt-in: a config written before this setting existed has no
    // field at all, and those are exactly the channels the silence was reported on.
    const announceOnAdd = ttsConfig.announceUnfulfilledRedemptions !== false;

    if (announceOnAdd && isUpdate) {
        // The .add already announced this one, so every .update is an echo of it —
        // including the approval that would otherwise announce below. `wasAnnounced`
        // cannot be leaned on here: it is per-instance with a 15 minute TTL, and an
        // approval arriving an hour later on another Cloud Run instance would pass it.
        if (redemptionId) redemptionCache.removeRedemption(redemptionId);
        logger.debug({ channelLogin, redemptionId, status }, 'Redemption already announced on .add — skipping update echo');
        return;
    }

    if (isAdd && status === 'unfulfilled' && !announceOnAdd) {
        // Pending approval — hold onto the chat fragments now, since the short-lived
        // fragment cache will have expired by the time the streamer approves.
        const pendingFragments = consumeFragments(rewardId, userId, channelLogin);
        redemptionCache.addRedemption(
            redemptionId, userInput, userLogin, channelLogin, rewardId, userId, pendingFragments
        );
        logger.debug({ channelLogin, redemptionId }, 'Redemption pending approval — deferring announcement');
        return;
    }

    if (isUpdate && status !== 'fulfilled') {
        // Canceled/rejected — never announced, so just drop the stashed entry.
        if (redemptionId) redemptionCache.removeRedemption(redemptionId);
        logger.debug({ channelLogin, redemptionId, status }, 'Redemption not fulfilled — skipping announcement');
        return;
    }

    if (wasAnnounced(redemptionId)) {
        logger.debug({ channelLogin, redemptionId }, 'Redemption already announced — skipping duplicate');
        return;
    }

    // From here on nothing is going to be spoken for this redemption, so an
    // entry stashed on the deferred path (.add + unfulfilled, opted out) is
    // dropped rather than left to the cache's 24-hour expiry.
    if (!rewardTitle) {
        if (redemptionId) redemptionCache.removeRedemption(redemptionId);
        logger.debug({ channelLogin }, 'Redemption event missing reward title - skipping announcement');
        return;
    }

    // Check if user is on the ignore list
    if (isTwitchUserIgnored(ttsConfig, userId)) {
        if (redemptionId) redemptionCache.removeRedemption(redemptionId);
        logger.debug({ channelLogin, user: userLogin, userId }, 'Redemption from ignored user — skipping TTS announcement');
        return;
    }

    // Build announcement text
    let ttsText = t('announce.redemption', { user: userName, reward: rewardTitle });
    if (userInput) {
        // Check banned words against user input
        const hasBannedWord = ttsConfig.bannedWords?.length > 0 &&
            ttsConfig.bannedWords.some(w => w && userInput.toLowerCase().includes(String(w).toLowerCase()));
        if (hasBannedWord) {
            logger.debug({ channelLogin, user: userLogin }, 'Redemption user_input contains banned word — announcing redemption only');
        } else {
            // Run user_input through formatting pipeline (URLs, emotes, emoji).
            // On the approval path the short-lived fragment cache has long expired, so
            // fall back to fragments stashed on the pending .add (24h TTL).
            const emoteMode = ttsConfig.emoteMode || 'describe';
            const fragments = consumeFragments(rewardId, userId, channelLogin)
                || (isUpdate ? redemptionCache.getRedemption(redemptionId)?.fragments : null)
                || null;
            const formattedInput = await formatTtsText(userInput, fragments, {
                emoteMode,
                channelEmoteMode: emoteMode,
                readFullUrls: ttsConfig.readFullUrls || false,
                pronunciationRules: getPronunciationRules(ttsConfig),
                locale,
            });
            if (formattedInput) {
                ttsText = t('announce.redemption.input', { text: ttsText, input: formattedInput });
            } else {
                logger.info({ channelLogin, user: userLogin, emoteMode, viewerMessage: userInput },
                    'Redemption user_input formatted to empty (likely all emotes under emoteMode=skip) — announcing redemption only');
            }
        }
    }

    // Announcement is committed from here on, so the stashed entry is no longer needed.
    if (redemptionId) redemptionCache.removeRedemption(redemptionId);
    markAnnounced(redemptionId);

    logger.info({ channelLogin, userName, userId, rewardTitle, hasUserInput: !!userInput }, 'Announcing Channel Points redemption via TTS');

    // Get shared session info for distribution
    const sharedSessionInfo = await getSharedSessionInfo(channelLogin);

    await dispatchTtsEvent(channelLogin, {
        text: ttsText,
        user: userName,
        userId,
        type: 'event'
    }, sharedSessionInfo);
}

/**
 * Reject a Channel Points redemption via Twitch API
 * Requires broadcaster's user access token with channel:manage:redemptions scope
 */
async function rejectRedemption(channelLogin, redemptionId, rewardId, reason) {
    try {
        const { getUsersByLogin } = await import('../helixClient.js');
        const { getClientId } = await import('../tokenManager.js');

        const users = await getUsersByLogin([channelLogin]);
        if (!users || users.length === 0) {
            logger.warn({ channelLogin }, 'Cannot reject redemption - broadcaster user ID not found');
            return false;
        }

        const broadcasterId = users[0].id;

        // Get broadcaster's user access token (not app access token!)
        const token = await getBroadcasterAccessToken(broadcasterId, channelLogin);
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
async function processTtsRedemption(channelLogin, userInput, userName, ttsConfig, redemptionId = null, rewardId = null, userId = null) {
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

    // Check if chat event arrived first and stashed fragment data.
    // NOTE: This is best-effort in multi-instance deployments. The fragment cache
    // is in-memory (same pattern as redemptionCache.js). When the chat message and
    // redemption events hit different Cloud Run instances, fragments won't be found
    // and we fall back to raw text — identical to the pre-fix behavior.
    let fragments = consumeFragments(rewardId, userId, channelLogin);

    // For manual-approval redemptions, fragments may have been stashed in the
    // redemptionCache entry (which has 24h TTL) since the short-lived fragment
    // cache would have expired by the time the streamer approves.
    if (!fragments) {
        const cachedRedemption = redemptionCache.getRedemption(redemptionId);
        if (cachedRedemption?.fragments) {
            fragments = cachedRedemption.fragments;
            logger.debug({ redemptionId }, 'Using fragments from redemption cache (manual approval path)');
        }
    }

    // Resolve emote mode: user preference → channel default → 'describe'
    const userEmoteMode = await getUserEmoteModePreference(userName, userId);
    const channelEmoteMode = ttsConfig.emoteMode || 'describe';
    const locale = resolveChannelLocale(ttsConfig);
    const emoteMode = userEmoteMode || channelEmoteMode;

    // Run user_input through full formatting pipeline (emotes, URLs, emoji)
    const processedMessage = await formatTtsText(redeemMessage, fragments, {
        emoteMode,
        channelEmoteMode,
        readFullUrls: ttsConfig.readFullUrls || false,
        pronunciationRules: getPronunciationRules(ttsConfig),
        locale,
    });

    // Guard against empty result (e.g. all-emote message with emoteMode='skip')
    if (!processedMessage) {
        logger.debug({ channelLogin, userName, redemptionId }, 'Processed redemption message is empty after formatting - skipping TTS');
        return { ok: true };
    }

    // Get shared session info
    const sharedSessionInfo = await getSharedSessionInfo(channelLogin);

    // Publish to Pub/Sub for distribution to all instances
    logger.info({
        channel: channelLogin,
        user: userName,
        textPreview: processedMessage.substring(0, 30)
    }, 'Publishing Channel Points TTS redemption to Pub/Sub');

    await dispatchTtsEvent(channelLogin, {
        text: processedMessage,
        user: userName,
        userId,
        type: 'reward'
    }, sharedSessionInfo);

    return { ok: true };
}
