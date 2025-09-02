// src/components/commands/tts/clear.js
import * as ttsQueue from '../../tts/ttsQueue.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import logger from '../../../lib/logger.js';

export default {
    name: 'clear',
    description: 'Clears all pending events in the TTS event queue.',
    usage: '!tts clear',
    permission: 'moderator',
    execute: async (context) => {
        const { channel, user, replyToId } = context;
        const channelNameNoHash = channel.substring(1);

        await ttsQueue.clearQueue(channelNameNoHash);
        enqueueMessage(channel, `TTS queue has been CLEARED.`, { replyToId });
        logger.info(`ChatVibes [${channelNameNoHash}]: TTS queue cleared by ${user.username}.`);
    },
};