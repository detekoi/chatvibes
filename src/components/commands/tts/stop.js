// src/components/commands/tts/stop.js
import * as ttsQueue from '../../tts/ttsQueue.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import logger from '../../../lib/logger.js';

export default {
    name: 'stop',
    description: 'If TTS is currently speaking, stops only the current speech.',
    usage: '!tts stop',
    permission: 'moderator',
    execute: async (context) => {
        const { channel, user } = context;
        const channelNameNoHash = channel.substring(1);

        const stopped = await ttsQueue.stopCurrentSpeech(channelNameNoHash);
        if (stopped) {
            enqueueMessage(channel, `@${user['display-name']}, Current TTS speech STOPPED.`);
            logger.info(`ChatVibes [${channelNameNoHash}]: Current speech stopped by ${user.username}.`);
        } else {
            enqueueMessage(channel, `@${user['display-name']}, Nothing was actively speaking to stop.`);
        }
    },
};