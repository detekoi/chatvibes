// src/components/twitch/handlers/notificationHandler.js
// Handles Twitch event notifications (subscriptions, raids, follows, cheers, watch streaks)

import logger from '../../../lib/logger.js';
import { dispatchTtsEvent } from '../../../lib/ttsDispatch.js';
import { getSharedSessionInfo } from '../eventUtils.js';
import { formatTtsText } from '../../../lib/formatTtsText.js';
import { getPronunciationRules } from '../../../lib/textRewrite/pronunciation.js';
import { pronounService } from '../../../lib/pronounService.js';

/** Synthetic subscription type used to route watch streak events from channel.chat.notification */
export const WATCH_STREAK_TYPE = 'channel.chat.notification.watch_streak';

/** How long to wait on the pronoun API before falling back to "They" */
const PRONOUN_LOOKUP_TIMEOUT_MS = 500;

/**
 * Subject pronoun for the "<Subject> said:" prefix on a viewer message attached to an
 * event. Falls back to "They" when the login is unknown, the API has no entry, or the
 * lookup is slow — an event announcement should never wait on it.
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
            // Skip if this is a gift subscription - the channel.subscription.gift event will handle it
            if (event.is_gift) {
                logger.debug({ channelName, user: event.user_name }, 'Skipping gift subscription - will be announced by channel.subscription.gift event');
                return;
            }

            const subUser = event.user_name || event.user_login || 'Someone';
            const subLogin = (event.user_login || subUser).toLowerCase();
            if (ttsConfig.ignoredUsers?.includes(subLogin)) {
                logger.debug({ channelName, user: subLogin }, 'Subscription from ignored user — skipping TTS');
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
            const resubLogin = (event.user_login || resubUser).toLowerCase();
            if (ttsConfig.ignoredUsers?.includes(resubLogin)) {
                logger.debug({ channelName, user: resubLogin }, 'Resub from ignored user — skipping TTS');
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
                    const formattedMessage = await formatTtsText(rawResubMessage, fragments, {
                        emoteMode,
                        channelEmoteMode: emoteMode,
                        readFullUrls: ttsConfig.readFullUrls || false,
                        pronunciationRules: getPronunciationRules(ttsConfig),
                    });
                    if (formattedMessage) {
                        ttsText += ` ${await resolvePronounSubject(resubLogin)} said: ${formattedMessage}`;
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
            // Gift subscription(s)
            const gifterUser = event.user_name || event.user_login || 'An anonymous gifter';
            const total = event.total || 1;
            const tier = event.tier ? ` Tier ${event.tier / 1000}` : '';
            const isAnonymous = event.is_anonymous;

            if (isAnonymous || !event.user_name) {
                ttsText = `${total}${tier} gift ${total === 1 ? 'sub' : 'subs'} from an anonymous gifter!`;
                username = 'anonymous_gifter';
            } else {
                ttsText = `${gifterUser} just gifted ${total}${tier} ${total === 1 ? 'sub' : 'subs'}!`;
                username = gifterUser;
                userId = event.user_id;
            }
            logger.info({ channelName, gifter: gifterUser, total, tier: event.tier, isAnonymous }, 'Gift subscription event');
            break;
        }

        case 'channel.cheer': {
            // Bits cheer announcement only — event.message (plain string) is NOT appended here
            // because the cheer message text is already read via channel.chat.message in chatHandler.js
            const cheerUser = event.user_name || event.user_login || 'Someone';
            const bits = event.bits || 0;
            const isAnonymous = event.is_anonymous;

            if (!isAnonymous) {
                const cheerLogin = (event.user_login || cheerUser).toLowerCase();
                if (ttsConfig.ignoredUsers?.includes(cheerLogin)) {
                    logger.debug({ channelName, user: cheerLogin }, 'Cheer from ignored user — skipping TTS');
                    return;
                }
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
            const streakLogin = (event.chatter_user_login || streakUser).toLowerCase();
            const streakCount = event.watch_streak?.streak_count;
            if (!streakCount || streakCount <= 0) {
                logger.warn({ channelName, user: streakUser, streakCount }, 'Watch streak event with invalid streak_count — skipping TTS');
                return;
            }

            // Check if the user is on the ignore list
            if (ttsConfig.ignoredUsers?.includes(streakLogin)) {
                logger.debug({ channelName, user: streakLogin }, 'Watch streak from ignored user — skipping TTS');
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
                    const formattedMessage = await formatTtsText(rawStreakMessage, fragments, {
                        emoteMode,
                        channelEmoteMode: emoteMode,
                        readFullUrls: ttsConfig.readFullUrls || false,
                        pronunciationRules: getPronunciationRules(ttsConfig),
                    });
                    if (formattedMessage) {
                        ttsText += ` ${await resolvePronounSubject(streakLogin)} said: ${formattedMessage}`;
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
