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
        const { channel, user, args } = context;
        const channelNameNoHash = channel.substring(1);
        const displayName = user['display-name'] || user.username;

        if (args.length === 0) {
            const currentConfig = await getTtsState(channelNameNoHash);
            enqueueMessage(channel, `@${displayName}, Current default emotion: ${currentConfig.emotion ?? DEFAULT_TTS_SETTINGS.emotion}. Usage: ${this.usage}`);
            return;
        }

        const actionOrValue = args[0].toLowerCase();
        let success;

        if (actionOrValue === 'reset') {
            success = await resetChannelDefaultEmotion(channelNameNoHash);
            if (success) {
                enqueueMessage(channel, `@${displayName}, Channel default TTS emotion reset to ${DEFAULT_TTS_SETTINGS.emotion}.`);
                logger.info(`[${channelNameNoHash}] Channel default emotion reset to ${DEFAULT_TTS_SETTINGS.emotion} by ${user.username}.`);
            } else {
                enqueueMessage(channel, `@${displayName}, Could not reset channel default emotion.`);
            }
        } else {
            const emotionValue = actionOrValue;
            if (!VALID_EMOTIONS.includes(emotionValue)) {
                enqueueMessage(channel, `@${displayName}, Invalid emotion. Valid emotions are: ${VALID_EMOTIONS.join(', ')}.`);
                return;
            }
            success = await setChannelDefaultEmotion(channelNameNoHash, emotionValue);
            if (success) {
                enqueueMessage(channel, `@${displayName}, Channel default TTS emotion set to ${emotionValue}.`);
                logger.info(`[${channelNameNoHash}] Channel default emotion set to ${emotionValue} by ${user.username}.`);
            } else {
                enqueueMessage(channel, `@${displayName}, Could not set channel default emotion to ${emotionValue}.`);
            }
        }
    },
};
