// src/components/commands/music/ignoreUser.js
import { addIgnoredUserMusic, removeIgnoredUserMusic, getMusicState } from '../../music/musicState.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import { hasPermission } from '../commandProcessor.js';
import logger from '../../../lib/logger.js';

export default {
    name: 'ignore',
    description: 'Adds/removes users from the music generation ignore list. Mods can manage any user; users can add themselves.',
    usage: '!music ignore <username> | !music ignore <add|del|delete|rem|remove> <username>',
    permission: 'everyone',
    execute: async (context) => {
        const { channel, user, args } = context;
        const channelNameNoHash = channel.substring(1).toLowerCase();
        let action = args[0]?.toLowerCase();
        let targetUsernameRaw = args[1];
        let targetUsername = targetUsernameRaw?.toLowerCase().replace(/^@/, '');
        const invokingUsernameLower = user.username.toLowerCase();
        const invokingUserDisplayName = user['display-name'] || user.username;

        const isModOrBroadcaster = hasPermission('moderator', user, channelNameNoHash);

        // Handle "!music ignore <username>" as "!music ignore add <username>"
        if (args.length === 1 && !['add', 'del', 'delete', 'rem', 'remove', 'ignored'].includes(action)) { // Added 'ignored' to prevent it from being treated as username
            targetUsernameRaw = action; // The first arg is the username
            targetUsername = targetUsernameRaw.toLowerCase().replace(/^@/, '');
            action = 'add'; // Default action is 'add'
        } else if (action && ['delete', 'rem', 'remove'].includes(action)) {
            action = 'del'; // Normalize delete actions
        }

        if (!action || !targetUsername || !['add', 'del'].includes(action)) {
            let usageMsg = `@${invokingUserDisplayName}, Usage: !music ignore <your_username_to_ignore_yourself>, OR !music ignore add <username_to_ignore_yourself_or_other_if_mod>, OR (mods only) !music ignore <del|remove> <username_to_unignore>. You can also use '!music ignored' (mods only).`;
             if (args.length === 0 || (args.length ===1 && args[0].toLowerCase() === "help")) { // More helpful message for just "!music ignore" or "!music ignore help"
                 const musicState = await getMusicState(channelNameNoHash);
                 const isSelfIgnored = musicState.ignoredUsers.includes(invokingUsernameLower);
                 usageMsg = `@${invokingUserDisplayName}, ${isSelfIgnored ? 'You are currently being ignored by music generation.' : 'You are not currently ignored.'} To ignore yourself: '!music ignore ${invokingUsernameLower}'. Mods: '!music ignore add/del <user>' or '!music ignored'.`;
            }
            enqueueMessage(channel, usageMsg);
            return;
        }


        if (action === 'add') {
            if (targetUsername === invokingUsernameLower) {
                const success = await addIgnoredUserMusic(channelNameNoHash, targetUsername);
                enqueueMessage(channel, `@${invokingUserDisplayName}, ${success ? `You will now be ignored by music generation.` : `Could not add you to the music ignore list.`}`);
            } else if (isModOrBroadcaster) {
                const success = await addIgnoredUserMusic(channelNameNoHash, targetUsername);
                enqueueMessage(channel, `@${invokingUserDisplayName}, ${success ? `${targetUsername} will now be ignored by music generation.` : `Could not add ${targetUsername} to the music ignore list.`}`);
            } else {
                enqueueMessage(channel, `@${invokingUserDisplayName}, You can only add yourself to the music ignore list. Mods can add others. Try '!music ignore ${invokingUsernameLower}'.`);
            }
        } else if (action === 'del') {
            if (isModOrBroadcaster) {
                const success = await removeIgnoredUserMusic(channelNameNoHash, targetUsername);
                enqueueMessage(channel, `@${invokingUserDisplayName}, ${success ? `${targetUsername} will no longer be ignored by music generation.` : `${targetUsername} was not on the music ignore list or could not be removed.`}`);
            } else {
                enqueueMessage(channel, `@${invokingUserDisplayName}, Only moderators can remove users from the music ignore list.`);
            }
        }
    },
};