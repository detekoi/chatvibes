// src/components/commands/tts/ignoreUser.js
import { addIgnoredUser, removeIgnoredUser, getTtsState } from '../../tts/ttsState.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
// Removed helixClient and userExists for this simplified version, add back if used for other checks
import logger from '../../../lib/logger.js';

export default {
    name: 'ignore',
    description: 'Adds self to TTS ignore list. Mods can add/remove any user. Usage: !tts ignore <add|del|delete|rem|remove> <username>',
    usage: '!tts ignore add <username> | !tts ignore <del|delete|rem|remove> <username (mod only)>',
    permission: 'everyone', 
    execute: async (context) => {
        const { channel, user, args } = context;
        const channelNameNoHash = channel.substring(1).toLowerCase();
        let action = args[0]?.toLowerCase();
        const targetUsernameRaw = args[1]; // Keep raw for message feedback if needed
        const targetUsername = targetUsernameRaw?.toLowerCase().replace(/^@/, '');
        const invokingUsernameLower = user.username.toLowerCase();
        const invokingUserDisplayName = user['display-name'] || user.username;

        // Determine invoker's status
        const isBroadcaster = user.badges?.broadcaster === '1' || invokingUsernameLower === channelNameNoHash;
        const isModByTag = user.mod === true || user.mod === '1';
        const isModByBadge = user.badges?.moderator === '1';
        const isModOrBroadcaster = isModByTag || isModByBadge || isBroadcaster;

        // Alias mapping for 'del' action
        const deleteAliases = ['delete', 'rem', 'remove'];
        if (action && deleteAliases.includes(action)) {
            action = 'del'; // Normalize action to 'del'
        }

        if (!action || !targetUsername || !['add', 'del'].includes(action)) {
            enqueueMessage(channel, `@${invokingUserDisplayName}, Invalid action. Usage: !tts ignore add ${invokingUsernameLower} OR (mods only) !tts ignore <add|del|delete|rem|remove> <username>`);
            return;
        }

        if (action === 'add') {
            // Case 1: User is adding themselves
            if (targetUsername === invokingUsernameLower) {
                const success = await addIgnoredUser(channelNameNoHash, targetUsername);
                enqueueMessage(channel, `@${invokingUserDisplayName}, ${success ? `You will now be ignored by TTS.` : `Could not add you to the ignore list.`}`);
            }
            // Case 2: Mod/Broadcaster is adding someone else (or themselves, which is also fine)
            else if (isModOrBroadcaster) {
                const success = await addIgnoredUser(channelNameNoHash, targetUsername);
                enqueueMessage(channel, `@${invokingUserDisplayName}, ${success ? `${targetUsername} will now be ignored by TTS.` : `Could not add ${targetUsername} to ignore list.`}`);
            }
            // Case 3: Non-mod trying to add someone else
            else {
                enqueueMessage(channel, `@${invokingUserDisplayName}, You can only add yourself to the ignore list. Mods can add others.`);
            }
        } else if (action === 'del') {
            // Only mods/broadcasters can delete
            if (isModOrBroadcaster) {
                const success = await removeIgnoredUser(channelNameNoHash, targetUsername);
                enqueueMessage(channel, `@${invokingUserDisplayName}, ${success ? `${targetUsername} will no longer be ignored by TTS.` : `${targetUsername} was not on the ignore list or could not be removed.`}`);
            } else {
                enqueueMessage(channel, `@${invokingUserDisplayName}, Only moderators can remove users from the TTS ignore list.`);
            }
        }
    },
};
