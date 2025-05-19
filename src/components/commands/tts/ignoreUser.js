// src/components/commands/tts/ignoreUser.js
import { addIgnoredUser, removeIgnoredUser, getIgnoredUsers, getTtsState } from '../../tts/ttsState.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import { helixClient } from '../../twitch/helixClient.js'; // Assume getHelixClient() is available

async function userExists(username) {
    if (!username) return false;
    try {
        const client = getHelixClient(); // from ChatSage
        const users = await client.getUsersByLogin([username.toLowerCase()]);
        return users && users.length > 0;
    } catch (e) {
        logger.error({ err: e }, `Error checking if user ${username} exists.`);
        return false; // Assume not found on error
    }
}

export default {
    name: 'ignore',
    // ... description, usage ...
    permission: 'moderator', // Base permission
    execute: async (context) => {
        const { channel, user, args, ircClient } = context;
        const channelNameNoHash = channel.substring(1);
        const action = args[0]?.toLowerCase();
        const targetUsername = args[1]?.toLowerCase().replace(/^@/, '');

        // Permission check for self-ignore (if !tts ignore add self)
        const isMod = user.mod === '1' || user.badges?.broadcaster === '1';
        const canManageOwnIgnore = action === 'add' && targetUsername === user.username.toLowerCase();

        if (!isMod && !canManageOwnIgnore && action === 'add') {
             enqueueMessage(channel, `@${user['display-name']}, You can only add yourself to the ignore list. Mods can manage others.`);
            return;
        }
        if (!isMod && (action === 'del' || (action === 'add' && targetUsername !== user.username.toLowerCase()))) {
            enqueueMessage(channel, `@${user['display-name']}, Only moderators can manage the TTS ignore list for others.`);
            return;
        }

        if (!action || !targetUsername || !['add', 'del'].includes(action)) {
            enqueueMessage(channel, `@${user['display-name']}, Usage: !tts ignore <add|del> <username>`);
            return;
        }

        // Further check: Mod cannot ignore another mod or broadcaster unless they are the broadcaster.
        // This requires fetching target user's status if they are not the invoking user.
        if (isMod && targetUsername !== user.username.toLowerCase()) {
            // Fetch target user's info (simplified, needs actual Helix call)
            // const targetUserDetails = await getHelixClient().getUsersByLogin([targetUsername]);
            // const targetIsModOrBroadcaster = targetUserDetails[0] && (targetUserDetails[0].broadcaster_type === 'partner' || targetUserDetails[0].broadcaster_type === 'affiliate' || /* check mod status via API/context */);
            // if (targetIsModOrBroadcaster && user.badges?.broadcaster !== '1') {
            //    enqueueMessage(channel, `@${user['display-name']}, You cannot ignore other moderators or the broadcaster.`);
            //    return;
            // }
        }


        let success;
        if (action === 'add') {
            success = await addIgnoredUser(channelNameNoHash, targetUsername);
            enqueueMessage(channel, `@${user['display-name']}, ${success ? `${targetUsername} will now be ignored by TTS.` : `Could not add ${targetUsername} to ignore list.`}`);
        } else if (action === 'del') {
            success = await removeIgnoredUser(channelNameNoHash, targetUsername);
            enqueueMessage(channel, `@${user['display-name']}, ${success ? `${targetUsername} will no longer be ignored by TTS.` : `${targetUsername} was not on the ignore list.`}`);
        }
    },
};