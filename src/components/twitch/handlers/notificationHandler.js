// src/components/twitch/handlers/notificationHandler.js
// Handles Twitch event notifications (subscriptions, raids, follows, cheers, watch streaks)

import logger from '../../../lib/logger.js';
import { dispatchTtsEvent } from '../../../lib/ttsDispatch.js';
import { getSharedSessionInfo } from '../eventUtils.js';
import { formatTtsText } from '../../../lib/formatTtsText.js';
import { getPronunciationRules } from '../../../lib/textRewrite/pronunciation.js';
import { pronounService } from '../../../lib/pronounService.js';
import { isTwitchUserIgnored } from '../../../lib/ignoreList.js';

/** Synthetic subscription type used to route watch streak events from channel.chat.notification */
export const WATCH_STREAK_TYPE = 'channel.chat.notification.watch_streak';

/**
 * Synthetic subscription types for gift subs, routed from channel.chat.notification.
 *
 * Gift subs are announced from channel.chat.notification rather than the dedicated
 * channel.subscription.gift subscription because that payload names only the gifter —
 * it has no recipient fields at all, so a single gift could only ever be announced as
 * "X gifted 1 sub!". The sub_gift notice carries recipient_user_name, and it needs only
 * the bot's own chat scopes, so it also works on channels that never granted
 * channel:read:subscriptions.
 */
export const SUB_GIFT_TYPE = 'channel.chat.notification.sub_gift';
export const COMMUNITY_SUB_GIFT_TYPE = 'channel.chat.notification.community_sub_gift';

/**
 * How long to wait on the pronoun API before falling back to "They".
 *
 * A backstop, not a latency budget. pronounService caps its own fetch at 3s and never
 * rejects, so this only matters if that guarantee ever breaks. It was 500ms and that
 * lost the race on every cold cache — a miss on pronouns.alejo.io costs ~700-760ms, so
 * viewers with pronouns registered were still announced as "They". Nothing is gained by
 * cutting it fine: the announcement then spends seconds in TTS generation regardless.
 */
const PRONOUN_LOOKUP_TIMEOUT_MS = 2500;

/**
 * Subject pronoun for the "<Subject> said:" prefix on a viewer message attached to an
 * event. Falls back to "They" when the login is unknown, the API has no entry, or the
 * lookup exceeds PRONOUN_LOOKUP_TIMEOUT_MS.
 *
 * Callers should run this concurrently with formatTtsText so the fetch overlaps with
 * formatting work rather than adding to it.
 */
async function resolvePronounSubject(login) {
    if (!login || login === 'someone') return 'They';

    const pronouns = await new Promise(resolve => {
        let done = false;
        const timer = setTimeout(() => {
            done = true;
            resolve(null);
        }, PRONOUN_LOOKUP_TIMEOUT_MS);
        pronounService.getUserPronouns(login).then(res => {
            if (!done) { done = true; clearTimeout(timer); resolve(res); }
        }).catch(() => {
            if (!done) { done = true; clearTimeout(timer); resolve(null); }
        });
    });

    return pronouns?.Subject || 'They';
}

/**
 * " Tier 1" / " Tier 2" / " Tier 3" from a chat notification's sub_tier ("1000"/"2000"/"3000"),
 * or "" when the field is missing or not one of those values.
 */
function formatSubTier(subTier) {
    const tier = Number(subTier) / 1000;
    return Number.isInteger(tier) && tier >= 1 && tier <= 3 ? ` Tier ${tier}` : '';
}

/**
 * Whether the gifter on a gift notice is on the channel's ignore list. An anonymous gifter
 * has no account ID to match, so it is never ignored — the same rule the cheer handler applies.
 */
function isIgnoredGifter(event, ttsConfig, isAnonymous) {
    if (isAnonymous) return false;
    return isTwitchUserIgnored(ttsConfig, event.chatter_user_id);
}

/**
 * Handle event notifications (subs, raids, follows, cheers)
 * Generates appropriate TTS text and publishes to Pub/Sub
 */
export async function handleNotification(subscriptionType, event, channelName, ttsConfig = {}) {
    let ttsText = null;
    let username = 'event_tts'; // Default for events without specific user
    let userId = undefined; // Twitch User ID for voice preference resolution

    switch (subscriptionType) {
        case 'channel.subscribe': {
            // New subscription
            // Skip if this is a gift subscription - the sub_gift chat notification will handle it
            if (event.is_gift) {
                logger.debug({ channelName, user: event.user_name }, 'Skipping gift subscription - will be announced by its sub_gift chat notification');
                return;
            }

            const subUser = event.user_name || event.user_login || 'Someone';
            if (isTwitchUserIgnored(ttsConfig, event.user_id)) {
                logger.debug({ channelName, user: subUser, userId: event.user_id }, 'Subscription from ignored user — skipping TTS');
                return;
            }

            const tier = event.tier ? ` (Tier ${event.tier / 1000})` : '';
            ttsText = `${subUser} just subscribed${tier}!`;
            username = subUser;
            userId = event.user_id;
            logger.info({ channelName, user: subUser, tier: event.tier }, 'New subscription event');
            break;
        }

        case 'channel.subscription.message': {
            // Resubscription with message
            const resubUser = event.user_name || event.user_login || 'Someone';
            const resubLogin = (event.user_login || resubUser).toLowerCase(); // pronoun lookup keys on the login
            if (isTwitchUserIgnored(ttsConfig, event.user_id)) {
                logger.debug({ channelName, user: resubUser, userId: event.user_id }, 'Resub from ignored user — skipping TTS');
                return;
            }

            const months = event.cumulative_months || event.duration_months || 0;
            const tier = event.tier ? ` (Tier ${event.tier / 1000})` : '';

            // Sub streak (consecutive months). Twitch sends null when the viewer opts
            // not to share it, and a 1-month "streak" isn't worth announcing.
            const streakMonths = Number(event.streak_months);
            const streak = Number.isFinite(streakMonths) && streakMonths >= 2
                ? `, on a ${streakMonths} month streak`
                : '';

            ttsText = `${resubUser} resubscribed for ${months} months${streak}${tier}!`;

            // Append the viewer's resub message if present, after moderation + formatting
            const rawResubMessage = event.message?.text?.trim();
            if (rawResubMessage) {
                const hasBannedWord = ttsConfig.bannedWords?.length > 0 &&
                    ttsConfig.bannedWords.some(w => w && rawResubMessage.toLowerCase().includes(String(w).toLowerCase()));
                if (hasBannedWord) {
                    logger.debug({ channelName, user: resubLogin }, 'Resub message contains banned word — announcing resub only');
                } else {
                    const emoteMode = ttsConfig.emoteMode || 'describe';
                    const fragments = event.message?.fragments || null;
                    const [formattedMessage, pronounSubject] = await Promise.all([
                        formatTtsText(rawResubMessage, fragments, {
                            emoteMode,
                            channelEmoteMode: emoteMode,
                            readFullUrls: ttsConfig.readFullUrls || false,
                            pronunciationRules: getPronunciationRules(ttsConfig),
                        }),
                        resolvePronounSubject(resubLogin),
                    ]);
                    if (formattedMessage) {
                        ttsText += ` ${pronounSubject} said: ${formattedMessage}`;
                    } else {
                        logger.info({ channelName, user: resubLogin, emoteMode, viewerMessage: rawResubMessage },
                            'Resub message formatted to empty (likely all emotes under emoteMode=skip) — announcing resub only');
                    }
                }
            }

            username = resubUser;
            userId = event.user_id;
            logger.info({ channelName, user: resubUser, months, streakMonths: event.streak_months ?? null, tier: event.tier, viewerMessage: rawResubMessage || null }, 'Resubscription event');
            break;
        }

        case 'channel.subscription.gift': {
            // Superseded by the sub_gift / community_sub_gift notices, which name the recipient.
            // No new subscriptions of this type are created, but ones made before that changed
            // are never deleted per-type, so their events keep arriving and must be dropped here
            // to avoid announcing every gift twice.
            logger.debug({ channelName, gifter: event.user_name, total: event.total },
                'Ignoring channel.subscription.gift - announced from channel.chat.notification instead');
            return;
        }

        case SUB_GIFT_TYPE: {
            // A single gift sub, which is the only case where a recipient can be named.
            // Gifts that are part of a mass gift carry community_gift_id and are dropped
            // by the caller — the community_sub_gift notice announces those as a batch.
            const recipient = event.sub_gift?.recipient_user_name || event.sub_gift?.recipient_user_login;
            if (!recipient) {
                logger.warn({ channelName, gifter: event.chatter_user_name }, 'sub_gift notice without a recipient - skipping TTS');
                return;
            }

            const isAnonymous = event.chatter_is_anonymous === true || !event.chatter_user_name;
            if (isIgnoredGifter(event, ttsConfig, isAnonymous)) {
                logger.debug({ channelName, user: event.chatter_user_login }, 'Gift sub from ignored user — skipping TTS');
                return;
            }

            const gifterUser = isAnonymous ? 'An anonymous gifter' : event.chatter_user_name;
            const tier = formatSubTier(event.sub_gift?.sub_tier);

            ttsText = `${gifterUser} just gifted a${tier} sub to ${recipient}!`;
            if (isAnonymous) {
                username = 'anonymous_gifter';
            } else {
                username = gifterUser;
                userId = event.chatter_user_id;
            }
            logger.info({ channelName, gifter: gifterUser, recipient, tier: event.sub_gift?.sub_tier, isAnonymous }, 'Gift subscription event');
            break;
        }

        case COMMUNITY_SUB_GIFT_TYPE: {
            // A mass gift. Recipients arrive as separate sub_gift notices, so they are not
            // named here — reading out a 50-name list is worse than reading the count.
            const total = event.community_sub_gift?.total || 1;
            const tier = formatSubTier(event.community_sub_gift?.sub_tier);
            const isAnonymous = event.chatter_is_anonymous === true || !event.chatter_user_name;
            if (isIgnoredGifter(event, ttsConfig, isAnonymous)) {
                logger.debug({ channelName, user: event.chatter_user_login }, 'Mass gift from ignored user — skipping TTS');
                return;
            }

            const gifterUser = isAnonymous ? 'An anonymous gifter' : event.chatter_user_name;

            if (isAnonymous) {
                ttsText = `${total}${tier} gift ${total === 1 ? 'sub' : 'subs'} from an anonymous gifter!`;
                username = 'anonymous_gifter';
            } else {
                ttsText = `${gifterUser} just gifted ${total}${tier} ${total === 1 ? 'sub' : 'subs'}!`;
                username = gifterUser;
                userId = event.chatter_user_id;
            }
            logger.info({ channelName, gifter: gifterUser, total, tier: event.community_sub_gift?.sub_tier, isAnonymous }, 'Community gift subscription event');
            break;
        }

        case 'channel.cheer': {
            // Bits cheer announcement only — event.message (plain string) is NOT appended here
            // because the cheer message text is already read via channel.chat.message in chatHandler.js
            const cheerUser = event.user_name || event.user_login || 'Someone';
            const bits = event.bits || 0;
            const isAnonymous = event.is_anonymous;

            if (!isAnonymous && isTwitchUserIgnored(ttsConfig, event.user_id)) {
                logger.debug({ channelName, user: cheerUser, userId: event.user_id }, 'Cheer from ignored user — skipping TTS');
                return;
            }

            const bitWord = bits === 1 ? 'bit' : 'bits';
            if (isAnonymous) {
                ttsText = `${bits} ${bitWord} from an anonymous cheerer!`;
                username = 'anonymous_cheerer';
            } else {
                ttsText = `${cheerUser} cheered ${bits} ${bitWord}!`;
                username = cheerUser;
                userId = event.user_id;
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
            userId = event.from_broadcaster_user_id;
            logger.info({ channelName, raider: raiderUser, viewers }, 'Raid event');
            break;
        }

        case 'channel.follow': {
            // New follower (v2)
            const anonymize = ttsConfig.anonymizeFollowers !== false;
            const followerUser = event.user_name || event.user_login || 'Someone';
            if (anonymize) {
                ttsText = 'Someone new just followed!';
                username = 'anonymous_follower';
            } else {
                ttsText = `${followerUser} just followed!`;
                username = followerUser;
                userId = event.user_id;
            }
            logger.info({ channelName, user: followerUser, anonymized: anonymize }, 'Follow event');
            break;
        }

        case WATCH_STREAK_TYPE: {
            // Watch streak milestone (from channel.chat.notification with notice_type: watch_streak)
            const streakUser = event.chatter_user_name || event.chatter_user_login || 'Someone';
            const streakLogin = (event.chatter_user_login || streakUser).toLowerCase(); // pronoun lookup keys on the login
            const streakCount = event.watch_streak?.streak_count;
            if (!streakCount || streakCount <= 0) {
                logger.warn({ channelName, user: streakUser, streakCount }, 'Watch streak event with invalid streak_count — skipping TTS');
                return;
            }

            // Check if the user is on the ignore list
            if (isTwitchUserIgnored(ttsConfig, event.chatter_user_id)) {
                logger.debug({ channelName, user: streakUser, userId: event.chatter_user_id }, 'Watch streak from ignored user — skipping TTS');
                return;
            }

            ttsText = `${streakUser} is on a ${streakCount} stream watch streak!`;

            // Append the viewer's attached chat message if present, after moderation + formatting
            const rawStreakMessage = event.message?.text?.trim();
            if (rawStreakMessage) {
                // Check banned words against the attached message
                const hasBannedWord = ttsConfig.bannedWords?.length > 0 &&
                    ttsConfig.bannedWords.some(w => w && rawStreakMessage.toLowerCase().includes(String(w).toLowerCase()));
                if (hasBannedWord) {
                    logger.debug({ channelName, user: streakLogin }, 'Watch streak message contains banned word — announcing streak only');
                } else {
                    // Run through the same formatting pipeline as chat messages
                    // (URL shortening, emote mode, emoji processing)
                    const emoteMode = ttsConfig.emoteMode || 'describe';
                    const fragments = event.message?.fragments || null;
                    const [formattedMessage, pronounSubject] = await Promise.all([
                        formatTtsText(rawStreakMessage, fragments, {
                            emoteMode,
                            channelEmoteMode: emoteMode,
                            readFullUrls: ttsConfig.readFullUrls || false,
                            pronunciationRules: getPronunciationRules(ttsConfig),
                        }),
                        resolvePronounSubject(streakLogin),
                    ]);
                    if (formattedMessage) {
                        ttsText += ` ${pronounSubject} said: ${formattedMessage}`;
                    } else {
                        logger.info({ channelName, user: streakLogin, emoteMode, viewerMessage: rawStreakMessage },
                            'Watch streak message formatted to empty (likely all emotes under emoteMode=skip) — announcing streak only');
                    }
                }
            }

            username = streakUser;
            userId = event.chatter_user_id;
            logger.info({ channelName, user: streakUser, streakCount, viewerMessage: rawStreakMessage || null }, 'Watch streak event');
            break;
        }

        default:
            logger.warn({ type: subscriptionType, channelName }, 'Unhandled EventSub notification type');
            return;
    }

    // Publish to Pub/Sub for distribution to all instances
    // This ensures shared chat sessions and multi-instance deployments work correctly
    if (ttsText) {
        logger.debug({ channelName, text: ttsText, user: username }, 'Publishing EventSub event to Pub/Sub for TTS');

        // Get shared session info for distribution to all participating channels
        const sharedSessionInfo = await getSharedSessionInfo(channelName);

        await dispatchTtsEvent(channelName, {
            text: ttsText,
            user: username,
            userId,
            type: 'event'
        }, sharedSessionInfo);
    }
}
