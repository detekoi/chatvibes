// src/components/commands/tts/mode.js
import { setTtsState, getTtsState } from '../../tts/ttsState.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import logger from '../../../lib/logger.js';

export default {
    name: 'mode',
    description: 'Sets TTS mode to read all chat or only respond to commands.',
    usage: '!tts mode <all|command>',
    permission: 'moderator',
    execute: async (context) => {
        const { channel, user, args } = context;
        const channelNameNoHash = channel.substring(1);

        if (args.length === 0) {
            const currentState = await getTtsState(channelNameNoHash);
            enqueueMessage(channel, `@${user['display-name']}, Current TTS mode is: ${currentState.mode}. Use '!tts mode <all|command>'.`);
            return;
        }

        const newMode = args[0].toLowerCase();
        if (newMode !== 'all' && newMode !== 'command') {
            enqueueMessage(channel, `@${user['display-name']}, Invalid mode. Use 'all' or 'command'.`);
            return;
        }

        const success = await setTtsState(channelNameNoHash, 'mode', newMode);

        if (success) {
            enqueueMessage(channel, `@${user['display-name']}, TTS mode set to: ${newMode}.`);
            logger.info(`ChatVibes [${channelNameNoHash}]: TTS mode set to ${newMode} by ${user.username}.`);
        } else {
            enqueueMessage(channel, `@${user['display-name']}, Could not set TTS mode.`);
        }
    },
};