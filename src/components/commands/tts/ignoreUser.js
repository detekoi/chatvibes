// src/components/commands/tts/ignoreUser.js
import { addIgnoredUser, removeIgnoredUser, getTtsState } from '../../tts/ttsState.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
// Removed helixClient and userExists for this simplified version, add back if used for other checks
import logger from '../../../lib/logger.js';

export default {
    name: 'ignore',
    description: 'Adds or removes a user from the TTS ignore list. Usage: !tts ignore <add|del> <username>',
    usage: '!tts ignore <add|del> <username>',
    permission: 'moderator', // This ensures only mods/broadcasters execute this command
    execute: async (context) => {
        const { channel, user, args } = context;
        const channelNameNoHash = channel.substring(1);
        const action = args[0]?.toLowerCase();
        const targetUsername = args[1]?.toLowerCase().replace(/^@/, ''); // User to be ignored/unignored
        const invokingUserDisplayName = user['display-name'] || user.username;

        if (!action || !targetUsername || !['add', 'del'].includes(action)) {
            enqueueMessage(channel, `@${invokingUserDisplayName}, Usage: !tts ignore <add|del> <username>`);
            return;
        }

        // Since the command permission is 'moderator', we know 'user' is a mod or broadcaster here.
        // They can add or remove anyone.

        let success;
        if (action === 'add') {
            // Optional: Check if targetUsername is a valid Twitch user using getUsersByLogin if desired
            success = await addIgnoredUser(channelNameNoHash, targetUsername);
            enqueueMessage(channel, `@${invokingUserDisplayName}, ${success ? `${targetUsername} will now be ignored by TTS.` : `Could not add ${targetUsername} to ignore list.`}`);
        } else if (action === 'del') {
            success = await removeIgnoredUser(channelNameNoHash, targetUsername);
            enqueueMessage(channel, `@${invokingUserDisplayName}, ${success ? `${targetUsername} will no longer be ignored by TTS.` : `${targetUsername} was not on the ignore list or could not be removed.`}`);
        }
    },
};