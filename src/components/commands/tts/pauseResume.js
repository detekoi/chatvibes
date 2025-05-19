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
        const { channel, user, args } = context;
        const channelNameNoHash = channel.substring(1);
        const commandAction = context.command; // 'pause' or 'resume'

        if (commandAction === 'pause') {
            await ttsQueue.pauseQueue(channelNameNoHash);
            enqueueMessage(channel, `@${user['display-name']}, TTS queue is now PAUSED.`);
            logger.info(`ChatVibes [${channelNameNoHash}]: TTS queue paused by ${user.username}.`);
        } else if (commandAction === 'resume') {
            await ttsQueue.resumeQueue(channelNameNoHash);
            enqueueMessage(channel, `@${user['display-name']}, TTS queue is now RESUMED.`);
            logger.info(`ChatVibes [${channelNameNoHash}]: TTS queue resumed by ${user.username}.`);
        } else {
            // Should not be reached if command mapping in tts/index.js is correct
            enqueueMessage(channel, `@${user['display-name']}, Invalid action. Use pause or resume.`);
        }
    },
};