import {
    setChannelDefaultSpeed,
    resetChannelDefaultSpeed,
    getTtsState
} from '../../tts/ttsState.js';
import {
    TTS_SPEED_MIN,
    TTS_SPEED_MAX,
    TTS_SPEED_DEFAULT
} from '../../tts/ttsConstants.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import logger from '../../../lib/logger.js';

export default {
    name: 'defaultspeed',
    description: `Sets the channel's default TTS speed (${TTS_SPEED_MIN} to ${TTS_SPEED_MAX}, 1.0 is normal). Use 'reset' for default (${TTS_SPEED_DEFAULT}).`,
    usage: '!tts defaultspeed <value|reset>',
    permission: 'moderator',
    execute: async (context) => {
        const { channel, args, replyToId } = context;
        const channelNameNoHash = channel.substring(1);

        if (args.length === 0) {
            const currentConfig = await getTtsState(channelNameNoHash);
            enqueueMessage(channel, `Current default speed: ${currentConfig.speed ?? TTS_SPEED_DEFAULT}. Usage: !tts defaultspeed <value|reset>`, { replyToId });
            return;
        }

        const actionOrValue = args[0].toLowerCase();
        let success;

        if (actionOrValue === 'reset') {
            success = await resetChannelDefaultSpeed(channelNameNoHash);
            if (success) {
                enqueueMessage(channel, `Channel default TTS speed reset to ${TTS_SPEED_DEFAULT}.`, { replyToId });
                logger.info(`[${channelNameNoHash}] Channel default speed reset to ${TTS_SPEED_DEFAULT}.`);
            } else {
                enqueueMessage(channel, `Could not reset channel default speed.`, { replyToId });
            }
        } else {
            const speedValue = parseFloat(actionOrValue);
            if (isNaN(speedValue) || speedValue < TTS_SPEED_MIN || speedValue > TTS_SPEED_MAX) {
                enqueueMessage(channel, `Invalid speed. Must be a number between ${TTS_SPEED_MIN} and ${TTS_SPEED_MAX}.`, { replyToId });
                return;
            }
            success = await setChannelDefaultSpeed(channelNameNoHash, speedValue);
            if (success) {
                enqueueMessage(channel, `Channel default TTS speed set to ${speedValue}.`, { replyToId });
                logger.info(`[${channelNameNoHash}] Channel default speed set to ${speedValue}.`);
            } else {
                enqueueMessage(channel, `Could not set channel default speed to ${speedValue}.`, { replyToId });
            }
        }
    },
};
