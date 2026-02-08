// src/components/twitch/handlers/notificationHandler.js
// Handles Twitch event notifications (subscriptions, raids, follows, cheers)

import logger from '../../../lib/logger.js';
import { publishTtsEvent } from '../../../lib/pubsub.js';
import { getSharedSessionInfo } from '../eventUtils.js';

/**
 * Handle event notifications (subs, raids, follows, cheers)
 * Generates appropriate TTS text and publishes to Pub/Sub
 */
export async function handleNotification(subscriptionType, event, channelName, ttsConfig = {}) {
    let ttsText = null;
    let username = 'event_tts'; // Default for events without specific user

    switch (subscriptionType) {
        case 'channel.subscribe': {
            // New subscription
            // Skip if this is a gift subscription - the channel.subscription.gift event will handle it
            if (event.is_gift) {
                logger.debug({ channelName, user: event.user_name }, 'Skipping gift subscription - will be announced by channel.subscription.gift event');
                return;
            }

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
            // New follower (v2)
            const anonymize = ttsConfig.anonymizeFollowers !== false;
            const followerUser = event.user_name || event.user_login || 'Someone';
            if (anonymize) {
                ttsText = 'Someone new just followed!';
                username = 'anonymous_follower';
            } else {
                ttsText = `${followerUser} just followed!`;
                username = followerUser;
            }
            logger.info({ channelName, user: followerUser, anonymized: anonymize }, 'Follow event');
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

        await publishTtsEvent(channelName, {
            text: ttsText,
            user: username,
            type: 'event'
        }, sharedSessionInfo);
    }
}
