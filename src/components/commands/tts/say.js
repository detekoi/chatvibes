// src/components/commands/tts/say.js
import * as ttsQueue from '../../tts/ttsQueue.js';
import { getTtsState } from '../../tts/ttsState.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import logger from '../../../lib/logger.js';

export default {
    name: 'say',
    description: 'Makes the bot say a message using TTS (for testing or specific announcements).',
    usage: '!tts say <message>',
    permission: 'everyone', 
    execute: async (context) => {
        const { channel, user, args, replyToId } = context;
        const channelNameNoHash = channel.substring(1);

        if (args.length === 0) {
            enqueueMessage(channel, `Please provide a message for me to say.`, { replyToId });
            return;
        }

        const messageToSay = args.join(' ');

        const ttsConfig = await getTtsState(channelNameNoHash);
        if (!ttsConfig.engineEnabled) {
            enqueueMessage(channel, `TTS is currently disabled.`, { replyToId });
            return;
        }

        logger.info(`ChatVibes [${channelNameNoHash}]: User ${user.username} requested TTS say: "${messageToSay}"`);

        await ttsQueue.enqueue(channelNameNoHash, {
            text: messageToSay,
            user: user.username,
            type: 'command_say'
        });
        // No confirmation message to chat for !tts say, the speech itself is the confirmation.
    },
};