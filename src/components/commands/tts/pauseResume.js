// src/components/commands/tts/pauseResume.js
import * as ttsQueue from '../../tts/ttsQueue.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import logger from '../../../lib/logger.js';

export default {
    name: 'pauseResume', // Mapped from 'pause' and 'resume'
    description: 'Pauses or resumes the TTS event queue.',
    usage: '!tts <pause|resume>',
    permission: 'moderator',
    execute: async (context) => {
        const { channel, user, replyToId } = context;
        const channelNameNoHash = channel.substring(1);
        const commandAction = context.command; // 'pause' or 'resume'

        if (commandAction === 'pause') {
            await ttsQueue.pauseQueue(channelNameNoHash);
            enqueueMessage(channel, `TTS queue is now PAUSED.`, { replyToId });
            logger.info(`ChatVibes [${channelNameNoHash}]: TTS queue paused by ${user.username}.`);
        } else if (commandAction === 'resume') {
            await ttsQueue.resumeQueue(channelNameNoHash);
            enqueueMessage(channel, `TTS queue is now RESUMED.`, { replyToId });
            logger.info(`ChatVibes [${channelNameNoHash}]: TTS queue resumed by ${user.username}.`);
        } else {
            // Should not be reached if command mapping in tts/index.js is correct
            enqueueMessage(channel, `Invalid action. Use pause or resume.`, { replyToId });
        }
    },
};