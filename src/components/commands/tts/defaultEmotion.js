import {
    setChannelDefaultEmotion,
    resetChannelDefaultEmotion,
    getTtsState
} from '../../tts/ttsState.js';
import {
    VALID_EMOTIONS,
    DEFAULT_TTS_SETTINGS
} from '../../tts/ttsConstants.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import logger from '../../../lib/logger.js';

export default {
    name: 'defaultemotion',
    description: `Sets the channel's default TTS emotion. Valid: ${VALID_EMOTIONS.join(', ')}. Use 'reset' for system default.`,
    usage: '!tts defaultemotion <emotion|reset>',
    permission: 'moderator',
    execute: async (context) => {
        const { channel, args, replyToId } = context;
        const channelNameNoHash = channel.substring(1);

        if (args.length === 0) {
            const currentConfig = await getTtsState(channelNameNoHash);
            enqueueMessage(channel, `Current default emotion: ${currentConfig.emotion ?? DEFAULT_TTS_SETTINGS.emotion}. Usage: !tts defaultemotion <emotion|reset>`, { replyToId });
            return;
        }

        const actionOrValue = args[0].toLowerCase();
        let success;

        if (actionOrValue === 'reset') {
            success = await resetChannelDefaultEmotion(channelNameNoHash);
            if (success) {
                enqueueMessage(channel, `Channel default TTS emotion reset to ${DEFAULT_TTS_SETTINGS.emotion}.`, { replyToId });
                logger.info(`[${channelNameNoHash}] Channel default emotion reset to ${DEFAULT_TTS_SETTINGS.emotion}.`);
            } else {
                enqueueMessage(channel, `Could not reset channel default emotion.`, { replyToId });
            }
        } else {
            const emotionValue = actionOrValue;
            if (!VALID_EMOTIONS.includes(emotionValue)) {
                enqueueMessage(channel, `Invalid emotion. Valid emotions are: ${VALID_EMOTIONS.join(', ')}.`, { replyToId });
                return;
            }
            success = await setChannelDefaultEmotion(channelNameNoHash, emotionValue);
            if (success) {
                enqueueMessage(channel, `Channel default TTS emotion set to ${emotionValue}.`, { replyToId });
                logger.info(`[${channelNameNoHash}] Channel default emotion set to ${emotionValue}.`);
            } else {
                enqueueMessage(channel, `Could not set channel default emotion to ${emotionValue}.`, { replyToId });
            }
        }
    },
};
