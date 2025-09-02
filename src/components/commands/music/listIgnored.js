// src/components/commands/music/listIgnored.js
import { getMusicState } from '../../music/musicState.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import logger from '../../../lib/logger.js';
// Permission is handled by the main command handler in music.js for subcommands

export default {
    name: 'listIgnoredMusic', // Internal name
    description: 'Lists users currently ignored by music generation.',
    usage: '!music ignored',
    permission: 'moderator', // This permission is checked by the main !music command handler
    execute: async (context) => {
        const { channel, replyToId } = context;
        const channelNameNoHash = channel.substring(1);

        // Note: Permission check for 'moderator' is already handled by the caller (handlers/music.js)
        // before this execute function is called, because 'ignored' is a subcommand.

        try {
            const musicState = await getMusicState(channelNameNoHash);
            const ignoredUsers = musicState.ignoredUsers || [];

            if (ignoredUsers.length === 0) {
                enqueueMessage(channel, `No users are currently on the music ignore list.`, { replyToId });
            } else {
                let response = `Music ignored users: `;
                const MAX_USERS_PER_MSG = 15;
                let currentBatch = [];

                for (let i = 0; i < ignoredUsers.length; i++) {
                    currentBatch.push(ignoredUsers[i]);
                    if (currentBatch.length >= MAX_USERS_PER_MSG || i === ignoredUsers.length - 1) {
                        if (i === ignoredUsers.length - 1 && currentBatch.length < MAX_USERS_PER_MSG && response !== `Music ignored users: `) {
                            enqueueMessage(channel, response + currentBatch.join(', '), { replyToId });
                        } else {
                            enqueueMessage(channel, response + currentBatch.join(', '), { replyToId });
                        }
                        currentBatch = [];
                        if (i < ignoredUsers.length - 1) response = "More music ignored: ";
                    }
                }
            }
        } catch (error) {
            logger.error({ err: error, channelName: channelNameNoHash }, 'Error fetching ignored users for music.');
            enqueueMessage(channel, `Error fetching music ignored list.`, { replyToId });
        }
    },
};