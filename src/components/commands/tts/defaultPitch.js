// src/components/commands/tts/defaultpitch.js
import {
    setChannelDefaultPitch,
    resetChannelDefaultPitch,
    getTtsState
} from '../../tts/ttsState.js';
import {
    TTS_PITCH_MIN,
    TTS_PITCH_MAX,
    TTS_PITCH_DEFAULT
} from '../../tts/ttsConstants.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import logger from '../../../lib/logger.js';

export default {
    name: 'defaultpitch',
    description: `Sets the channel's default TTS pitch (${TTS_PITCH_MIN} to ${TTS_PITCH_MAX}, 0 is normal). Use 'reset' for default (${TTS_PITCH_DEFAULT}).`,
    usage: '!tts defaultpitch <value|reset>',
    permission: 'moderator',
    execute: async (context) => {
        const { channel, user, args, replyToId } = context;
        const channelNameNoHash = channel.substring(1);
        const displayName = user['display-name'] || user.username;

        if (args.length === 0) {
            const currentConfig = await getTtsState(channelNameNoHash);
            enqueueMessage(channel, `Current default pitch: ${currentConfig.pitch ?? TTS_PITCH_DEFAULT}. Usage: !tts defaultpitch <value|reset>`, { replyToId });
            return;
        }

        const actionOrValue = args[0].toLowerCase();
        let success;

        if (actionOrValue === 'reset') {
            success = await resetChannelDefaultPitch(channelNameNoHash);
            if (success) {
                enqueueMessage(channel, `Channel default TTS pitch reset to ${TTS_PITCH_DEFAULT}.`, { replyToId });
                logger.info(`[${channelNameNoHash}] Channel default pitch reset to ${TTS_PITCH_DEFAULT} by ${user.username}.`);
            } else {
                enqueueMessage(channel, `Could not reset channel default pitch.`, { replyToId });
            }
        } else {
            const pitchValue = parseInt(actionOrValue, 10);
            if (isNaN(pitchValue) || pitchValue < TTS_PITCH_MIN || pitchValue > TTS_PITCH_MAX) {
                enqueueMessage(channel, `Invalid pitch. Must be an integer between ${TTS_PITCH_MIN} and ${TTS_PITCH_MAX}.`, { replyToId });
                return;
            }
            success = await setChannelDefaultPitch(channelNameNoHash, pitchValue);
            if (success) {
                enqueueMessage(channel, `Channel default TTS pitch set to ${pitchValue}.`, { replyToId });
                logger.info(`[${channelNameNoHash}] Channel default pitch set to ${pitchValue} by ${user.username}.`);
            } else {
                enqueueMessage(channel, `Could not set channel default pitch to ${pitchValue}.`, { replyToId });
            }
        }
    },
};