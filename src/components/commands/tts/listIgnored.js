// src/components/commands/tts/listIgnored.js
import { getTtsState } from '../../tts/ttsState.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import logger from '../../../lib/logger.js';

export default {
    name: 'listIgnored', // Mapped to 'ignored'
    description: 'Lists users currently ignored by TTS.',
    usage: '!tts ignored',
    permission: 'moderator', // Or 'everyone' if you want anyone to see
    execute: async (context) => {
        const { channel, replyToId } = context;
        const channelNameNoHash = channel.substring(1);

        try {
            const ttsConfig = await getTtsState(channelNameNoHash);
            const ignoredUsers = ttsConfig.ignoredUsers || [];

            if (ignoredUsers.length === 0) {
                enqueueMessage(channel, `No users are currently on the TTS ignore list.`, { replyToId });
            } else {
                // Paginate if the list is too long for one message
                let response = `Ignored users: `;
                const MAX_USERS_PER_MSG = 15;
                let currentBatch = [];

                for (let i = 0; i < ignoredUsers.length; i++) {
                    currentBatch.push(ignoredUsers[i]);
                    if (currentBatch.length >= MAX_USERS_PER_MSG || i === ignoredUsers.length - 1) {
                        if (i === ignoredUsers.length -1 && currentBatch.length < MAX_USERS_PER_MSG && response !== `Ignored users: `){
                             enqueueMessage(channel, response + currentBatch.join(', '), { replyToId });
                        } else {
                             enqueueMessage(channel, response + currentBatch.join(', '), { replyToId });
                        }
                        currentBatch = [];
                        if (i < ignoredUsers.length -1) response = "More ignored: "; // For subsequent messages
                    }
                }
            }
        } catch (error) {
            logger.error({ err: error, channelName: channelNameNoHash }, 'Error fetching ignored users for TTS.');
            enqueueMessage(channel, `Error fetching ignored list.`, { replyToId });
        }
    },
};