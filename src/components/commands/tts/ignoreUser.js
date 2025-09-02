// src/components/commands/tts/ignoreUser.js
import { addIgnoredUser, removeIgnoredUser } from '../../tts/ttsState.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
// Removed helixClient and userExists for this simplified version, add back if used for other checks

export default {
    name: 'ignore',
    description: 'Adds self to TTS ignore list. Mods can add/remove any user. Usage: !tts ignore <username> OR !tts ignore <add|del|delete|rem|remove> <username>',
    usage: '!tts ignore <username> | !tts ignore add <username> | !tts ignore <del|delete|rem|remove> <username (mod only)>',
    permission: 'everyone',
    execute: async (context) => {
        const { channel, user, args, replyToId } = context;
        const channelNameNoHash = channel.substring(1).toLowerCase();
        let action = args[0]?.toLowerCase();
        let targetUsernameRaw = args[1];
        let targetUsername = targetUsernameRaw?.toLowerCase().replace(/^@/, '');
        const invokingUsernameLower = user.username.toLowerCase();
        const invokingUserDisplayName = user['display-name'] || user.username;

        // Determine invoker's status
        const isBroadcaster = user.badges?.broadcaster === '1' || invokingUsernameLower === channelNameNoHash;
        const isModByTag = user.mod === true || user.mod === '1';
        const isModByBadge = user.badges?.moderator === '1';
        const isModOrBroadcaster = isModByTag || isModByBadge || isBroadcaster;

        // Handle "!tts ignore <username>" as "!tts ignore add <username>"
        if (args.length === 1 && !['add', 'del', 'delete', 'rem', 'remove'].includes(action)) {
            targetUsernameRaw = action; // The first arg is the username
            targetUsername = targetUsernameRaw.toLowerCase().replace(/^@/, '');
            action = 'add'; // Default action is 'add'
        } else if (action && ['delete', 'rem', 'remove'].includes(action)) {
            action = 'del'; // Normalize delete actions
        }


        if (!action || !targetUsername || !['add', 'del'].includes(action)) {
            let usageMsg = `Usage: !tts ignore <username_to_ignore_yourself>, OR !tts ignore add <username_to_ignore_yourself_or_other_if_mod>, OR (mods only) !tts ignore <del|remove> <username_to_unignore>`;
            if (args.length === 0) {
                 usageMsg = `You can ignore yourself with '!tts ignore ${invokingUsernameLower}'. Mods can use '!tts ignore add <user>' or '!tts ignore del <user>'.`;
            }
            enqueueMessage(channel, usageMsg, { replyToId });
            return;
        }

        if (action === 'add') {
            // Case 1: User is adding themselves
            if (targetUsername === invokingUsernameLower) {
                const success = await addIgnoredUser(channelNameNoHash, targetUsername);
                enqueueMessage(channel, `${success ? `You will now be ignored by TTS.` : `Could not add you to the ignore list.`}`, { replyToId });
            }
            // Case 2: Mod/Broadcaster is adding someone else (or themselves, which is also fine)
            else if (isModOrBroadcaster) {
                const success = await addIgnoredUser(channelNameNoHash, targetUsername);
                enqueueMessage(channel, `${success ? `${targetUsername} will now be ignored by TTS.` : `Could not add ${targetUsername} to ignore list.`}`, { replyToId });
            }
            // Case 3: Non-mod trying to add someone else
            else {
                enqueueMessage(channel, `You can only add yourself or another user (if you are a mod) to the ignore list. Try '!tts ignore ${invokingUsernameLower}'.`, { replyToId });
            }
        } else if (action === 'del') {
            // Only mods/broadcasters can delete
            if (isModOrBroadcaster) {
                const success = await removeIgnoredUser(channelNameNoHash, targetUsername);
                enqueueMessage(channel, `${success ? `${targetUsername} will no longer be ignored by TTS.` : `${targetUsername} was not on the ignore list or could not be removed.`}`, { replyToId });
            } else {
                enqueueMessage(channel, `Only moderators can remove users from the TTS ignore list.`, { replyToId });
            }
        }
    },
};