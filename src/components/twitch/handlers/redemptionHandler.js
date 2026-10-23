// src/components/twitch/handlers/redemptionHandler.js
// Handles Channel Points custom reward redemption events

import logger from '../../../lib/logger.js';
import * as redemptionCache from '../redemptionCache.js';
import { isChannelActive } from '../../../lib/allowList.js';
import { getTtsState, getUserEmoteModePreference, isViewerGloballyOptedOut } from '../../tts/ttsState.js';
import { dispatchTtsEvent } from '../../../lib/ttsDispatch.js';
import { getSharedSessionInfo } from '../eventUtils.js';
import { formatTtsText } from '../../../lib/formatTtsText.js';
import { getPronunciationRules } from '../../../lib/textRewrite/pronunciation.js';
import { consumeFragments } from '../redemptionFragmentCache.js';
import { isTwitchUserIgnored, getIgnoreEntry, canSelfUnignore, PLATFORM_TWITCH } from '../../../lib/ignoreList.js';
import { containsBannedWord } from '../../../lib/bannedWords.js';
import { isRewardMuted } from '../../../lib/rewardMuteList.js';
import { getTranslator, resolveChannelLocale } from '../../../i18n/index.js';
import { setRedemptionStatus, stopRewardSkippingQueue } from '../redemptionStatus.js';

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
    if (!enabledViaNewConfig) {
        logger.debug({ channelLogin }, 'Channel Points TTS is disabled for this channel - ignoring');
        return;
    }

    const isAdd = subscriptionType === 'channel.channel_points_custom_reward_redemption.add';
    const isUpdate = subscriptionType === 'channel.channel_points_custom_reward_redemption.update';
    const settle = { broadcasterId, channelLogin, rewardId, redemptionId };
    // The dashboard's "Skip the Reward Queue" toggle. On, the bot approves a
    // redemption that passes the checks at once; off, the streamer approves it.
    const autoApprove = ttsConfig.channelPoints?.skipQueue !== false;

    // An unfulfilled .add is the one moment a refund is possible: Twitch lets
    // the bot change a redemption only while it is UNFULFILLED. Everything that
    // would refuse the message is decided here, and a refusal is a refund.
    if (isAdd && status === 'unfulfilled') {
        const refusal = ttsRedemptionRefusal(ttsConfig, userId, userInput);
        if (refusal) {
            logger.info({ channelLogin, userName, redemptionId, reason: refusal }, 'Refusing Channel Points TTS redemption - refunding');
            await setRedemptionStatus({ ...settle, status: 'CANCELED', reason: refusal });
            return;
        }

        if (autoApprove) {
            logger.info({ channelLogin, userName, redemptionId, textPreview: userInput?.substring(0, 30) },
                'Channel Points TTS redemption approved automatically - playing');
            // Fulfilled before it plays, so it cannot be refunded after it was
            // heard. A failure to fulfill (an expired token, say) does not stop
            // the message: the viewer paid, and the streamer can still settle
            // the redemption by hand.
            await setRedemptionStatus({ ...settle, status: 'FULFILLED', reason: 'approved automatically' });
            await speakTtsRedemption(channelLogin, userInput, userName, ttsConfig, redemptionId, rewardId, userId);
            return;
        }

        // Waiting for the streamer. Store rewardId for the approval, and any
        // fragments the chatHandler may have cached (best-effort, see
        // redemptionFragmentCache.js for multi-instance caveats).
        logger.info({ channelLogin, userName, redemptionId, textPreview: userInput?.substring(0, 30) },
            'Channel Points redemption pending approval - adding to cache');
        const cachedFragments = consumeFragments(rewardId, userId, channelLogin);
        redemptionCache.addRedemption(redemptionId, userInput, userName, channelLogin, rewardId, userId, cachedFragments);
        return;
    }

    // A fulfilled .add comes from a reward that still skips the request queue,
    // made before the bot settled redemptions itself. The points are already
    // spent and cannot be refunded, so a refusal only keeps the message silent.
    // The reward is switched over so the next redemption can be refunded.
    if (isAdd && status === 'fulfilled') {
        void stopRewardSkippingQueue(settle);
        const refusal = ttsRedemptionRefusal(ttsConfig, userId, userInput);
        if (refusal) {
            logger.warn({ channelLogin, userName, redemptionId, reason: refusal },
                'Refusing Channel Points TTS redemption - the reward skips the request queue, so it cannot be refunded');
            return;
        }
        logger.info({ channelLogin, userName, redemptionId, textPreview: userInput?.substring(0, 30) },
            'Channel Points redemption auto-approved by Twitch - playing');
        await speakTtsRedemption(channelLogin, userInput, userName, ttsConfig, redemptionId, rewardId, userId);
        return;
    }

    if (isUpdate && status === 'fulfilled') {
        // Only a redemption that waited for the streamer is in the cache. One the
        // bot fulfilled itself also sends this event, and is skipped here.
        const cachedRedemption = redemptionCache.getRedemption(redemptionId);
        if (!cachedRedemption) {
            logger.debug({ redemptionId, channelLogin }, 'Redemption update for fulfilled status but not in cache - already handled on .add');
            return;
        }
        // The checks ran on .add, but a moderator can mute the viewer, or the
        // streamer can change the policy, while it waits. It is fulfilled now,
        // so a refusal cannot be refunded; it only keeps the message silent.
        const approvedUserId = cachedRedemption.userId || userId;
        const refusal = ttsRedemptionRefusal(ttsConfig, approvedUserId, cachedRedemption.userInput);
        if (refusal) {
            logger.warn({ channelLogin, redemptionId, reason: refusal }, 'Approved Channel Points TTS redemption refused - not played');
            redemptionCache.removeRedemption(redemptionId);
            return;
        }
        logger.info({ channelLogin, userName, redemptionId, textPreview: cachedRedemption.userInput?.substring(0, 30) },
            'Channel Points redemption approved by streamer - playing TTS');
        await speakTtsRedemption(
            cachedRedemption.channelName,
            cachedRedemption.userInput,
            cachedRedemption.userName,
            ttsConfig,
            redemptionId,
            cachedRedemption.rewardId || rewardId,
            approvedUserId
        );
        // Removed after playing: speakTtsRedemption reads the fragments stashed on it.
        redemptionCache.removeRedemption(redemptionId);
        return;
    }

    if (isUpdate && status === 'canceled') {
        // Redemption was canceled - remove from cache if present
        const existed = redemptionCache.removeRedemption(redemptionId);
        if (existed) {
            logger.info({ channelLogin, userName, redemptionId }, 'Channel Points redemption canceled - removed from cache');
        }
    }
}

/**
 * Why a TTS reward redemption must not be read, or null when it may be.
 *
 * A viewer a moderator muted in this channel is refused: paying must not get
 * round the mute. A viewer who muted themselves here, or opted out of TTS in
 * every channel, is read: redeeming the TTS reward is an explicit, paid request
 * to be read. With the engine off nothing would play, so it is refused too.
 * @returns {string|null}
 */
function ttsRedemptionRefusal(ttsConfig, userId, userInput) {
    if (!ttsConfig.engineEnabled) return 'TTS is turned off';
    const ignoreEntry = getIgnoreEntry(ttsConfig, PLATFORM_TWITCH, userId);
    if (ignoreEntry && !canSelfUnignore(ignoreEntry)) return 'Viewer is muted in this channel';
    return contentPolicyRefusal(ttsConfig, userInput);
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
    // `ttsText` never carries the viewer's input; the full utterance goes in
    // textWithViewerMessage, which ttsQueue speaks only for a viewer who did not
    // opt out of TTS in every channel (see notificationHandler.js).
    const ttsText = t('announce.redemption', { user: userName, reward: rewardTitle });
    let textWithViewerMessage;
    if (userInput) {
        // Check banned words against user input
        const hasBannedWord = containsBannedWord(userInput, ttsConfig.bannedWords);
        if (hasBannedWord) {
            logger.debug({ channelLogin, user: userLogin }, 'Redemption user_input contains banned word — announcing redemption only');
        } else if (await isViewerGloballyOptedOut(userId)) {
            // Not formatted at all: formatting can send it to the emote describer.
            logger.debug({ channelLogin, user: userLogin }, 'Viewer opted out of TTS in every channel — announcing redemption only');
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
                textWithViewerMessage = t('announce.redemption.input', { text: ttsText, input: formattedInput });
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
        type: 'event',
        ...(textWithViewerMessage !== undefined && { textWithViewerMessage }),
    }, sharedSessionInfo);
}

/**
 * Why the content policy refuses a TTS reward message, or null when it passes.
 * Twitch caps reward input at 500 characters, so there is no length check.
 * @returns {string|null}
 */
function contentPolicyRefusal(ttsConfig, userInput) {
    const redeemMessage = (userInput || '').trim();
    if (redeemMessage.length === 0) return 'Message is empty';

    const policy = (ttsConfig.channelPoints && ttsConfig.channelPoints.contentPolicy) || {};
    const blockLinks = policy.blockLinks !== false; // default block links
    if (blockLinks && /\bhttps?:\/\//i.test(redeemMessage)) return 'Message contains blocked link';
    if (containsBannedWord(redeemMessage, policy.bannedWords)) return 'Message contains banned word';
    return null;
}

/**
 * Format a TTS reward message and send it to the queue. The caller has already
 * decided that it may be read (ttsRedemptionRefusal).
 */
async function speakTtsRedemption(channelLogin, userInput, userName, ttsConfig, redemptionId = null, rewardId = null, userId = null) {
    const redeemMessage = (userInput || '').trim();

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
    const userEmoteMode = await getUserEmoteModePreference(userId);
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
        return;
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
}
