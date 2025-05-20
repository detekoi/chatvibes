// src/components/commands/tts/pitch.js
import {
    setUserPitchPreference,
    clearUserPitchPreference,
    getUserPitchPreference
} from '../../tts/ttsState.js';
import {
    TTS_PITCH_MIN,
    TTS_PITCH_MAX,
    TTS_PITCH_DEFAULT
} from '../../tts/ttsConstants.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import logger from '../../../lib/logger.js';

export default {
    name: 'pitch',
    description: `Sets your personal TTS pitch (${TTS_PITCH_MIN} to ${TTS_PITCH_MAX}, 0 is normal). Use 'reset' for channel default.`,
    usage: '!tts pitch <value|reset>',
    permission: 'everyone',
    execute: async (context) => {
        const { channel, user, args } = context;
        const channelNameNoHash = channel.substring(1);
        const username = user.username;
        const displayName = user['display-name'] || username;

        if (args.length === 0) {
            const currentPitch = await getUserPitchPreference(channelNameNoHash, username);
            enqueueMessage(channel, `@${displayName}, Your current pitch preference: ${currentPitch ?? 'Channel Default'}. Usage: ${this.usage}`);
            return;
        }

        const actionOrValue = args[0].toLowerCase();
        let success;

        if (actionOrValue === 'reset' || actionOrValue === 'default') {
            success = await clearUserPitchPreference(channelNameNoHash, username);
            if (success) {
                enqueueMessage(channel, `@${displayName}, Your TTS pitch preference has been reset to the channel default.`);
            } else {
                enqueueMessage(channel, `@${displayName}, Could not reset your pitch preference.`);
            }
        } else {
            const pitchValue = parseInt(actionOrValue, 10);
            if (isNaN(pitchValue) || pitchValue < TTS_PITCH_MIN || pitchValue > TTS_PITCH_MAX) {
                enqueueMessage(channel, `@${displayName}, Invalid pitch. Must be an integer between ${TTS_PITCH_MIN} and ${TTS_PITCH_MAX}.`);
                return;
            }
            success = await setUserPitchPreference(channelNameNoHash, username, pitchValue);
            if (success) {
                enqueueMessage(channel, `@${displayName}, Your TTS pitch preference set to ${pitchValue}.`);
            } else {
                enqueueMessage(channel, `@${displayName}, Could not set your pitch preference to ${pitchValue}.`);
            }
        }
    },
};