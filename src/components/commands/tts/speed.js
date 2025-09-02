import {
    setUserSpeedPreference,
    clearUserSpeedPreference,
    getUserSpeedPreference
} from '../../tts/ttsState.js';
import {
    TTS_SPEED_MIN,
    TTS_SPEED_MAX
} from '../../tts/ttsConstants.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import logger from '../../../lib/logger.js'; // Added logger import for consistency, though not used in this version

export default {
    name: 'speed',
    description: `Sets your personal TTS speed (${TTS_SPEED_MIN} to ${TTS_SPEED_MAX}, 1.0 is normal). Use 'reset' for channel default.`,
    usage: '!tts speed <value|reset>',
    permission: 'everyone',
    execute: async (context) => {
        const { channel, user, args, replyToId } = context;
        const channelNameNoHash = channel.substring(1);
        const username = user.username;
        const displayName = user['display-name'] || username;

        if (args.length === 0) {
            const currentSpeed = await getUserSpeedPreference(channelNameNoHash, username);
            enqueueMessage(channel, `Your current speed preference: ${currentSpeed ?? 'Channel Default'}. Usage: !tts speed <value|reset>`, { replyToId });
            return;
        }

        const actionOrValue = args[0].toLowerCase();
        let success;

        if (actionOrValue === 'reset' || actionOrValue === 'default') {
            success = await clearUserSpeedPreference(channelNameNoHash, username);
            if (success) {
                enqueueMessage(channel, `Your TTS speed preference has been reset to the channel default.`, { replyToId });
            } else {
                enqueueMessage(channel, `Could not reset your speed preference.`, { replyToId });
            }
        } else {
            const speedValue = parseFloat(actionOrValue);
            if (isNaN(speedValue) || speedValue < TTS_SPEED_MIN || speedValue > TTS_SPEED_MAX) {
                enqueueMessage(channel, `Invalid speed. Must be a number between ${TTS_SPEED_MIN} and ${TTS_SPEED_MAX}.`, { replyToId });
                return;
            }
            success = await setUserSpeedPreference(channelNameNoHash, username, speedValue);
            if (success) {
                enqueueMessage(channel, `Your TTS speed preference set to ${speedValue}.`, { replyToId });
            } else {
                enqueueMessage(channel, `Could not set your speed preference to ${speedValue}.`, { replyToId });
            }
        }
    },
};
