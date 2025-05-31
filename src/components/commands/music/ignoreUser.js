// src/components/commands/music/ignoreUser.js
import { addIgnoredUserMusic, removeIgnoredUserMusic, getMusicState } from '../../music/musicState.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import { hasPermission } from '../commandProcessor.js'; // Assuming this utility exists and works
import logger from '../../../lib/logger.js';

export default {
    name: 'ignore', // This will be the subcommand name for !music ignore
    description: 'Adds/removes users from the music generation ignore list. Mods can manage any user; users can add themselves.',
    usage: '!music ignore <add|del|delete|rem|remove> <username>',
    permission: 'everyone', // Base permission for '!music ignore' itself, sub-actions are stricter
    execute: async (context) => {
        const { channel, user, args } = context;
        const channelNameNoHash = channel.substring(1).toLowerCase();
        let action = args[0]?.toLowerCase();
        const targetUsernameRaw = args[1];
        const targetUsername = targetUsernameRaw?.toLowerCase().replace(/^@/, '');
        const invokingUsernameLower = user.username.toLowerCase();
        const invokingUserDisplayName = user['display-name'] || user.username;

        const isModOrBroadcaster = hasPermission('moderator', user, channelNameNoHash);

        // Alias mapping for 'del' action
        const deleteAliases = ['delete', 'rem', 'remove'];
        if (action && deleteAliases.includes(action)) {
            action = 'del'; // Normalize action
        }

        if (!action || !targetUsername || !['add', 'del'].includes(action)) {
            // Provide more specific usage if just "!music ignore" is typed.
            if (args.length === 0) {
                 const musicState = await getMusicState(channelNameNoHash);
                 const isSelfIgnored = musicState.ignoredUsers.includes(invokingUsernameLower);
                 let ignoredListMsg = '';
                 if (isModOrBroadcaster && musicState.ignoredUsers.length > 0) {
                     ignoredListMsg = ` Currently ignored: ${musicState.ignoredUsers.join(', ')}.`;
                 } else if (isModOrBroadcaster) {
                    ignoredListMsg = ' No users are currently ignored for music.';
                 }

                enqueueMessage(channel, `@${invokingUserDisplayName}, ${isSelfIgnored ? 'You are currently being ignored by music generation.' : 'You are not currently ignored.'} Usage: !music ignore add ${invokingUsernameLower} | !music ignore add/del <username> (mods).${ignoredListMsg}`);
                return;
            }
            enqueueMessage(channel, `@${invokingUserDisplayName}, Invalid arguments. Usage: ${this.usage}`);
            return;
        }

        if (action === 'add') {
            if (targetUsername === invokingUsernameLower) { // User adding themselves
                const success = await addIgnoredUserMusic(channelNameNoHash, targetUsername);
                enqueueMessage(channel, `@${invokingUserDisplayName}, ${success ? `You will now be ignored by music generation.` : `Could not add you to the music ignore list.`}`);
            } else if (isModOrBroadcaster) { // Mod adding someone else
                const success = await addIgnoredUserMusic(channelNameNoHash, targetUsername);
                enqueueMessage(channel, `@${invokingUserDisplayName}, ${success ? `${targetUsername} will now be ignored by music generation.` : `Could not add ${targetUsername} to the music ignore list.`}`);
            } else { // Non-mod trying to add someone else
                enqueueMessage(channel, `@${invokingUserDisplayName}, You can only add yourself to the music ignore list. Mods can add others.`);
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