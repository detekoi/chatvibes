// src/components/commands/tts/permission.js
import { setTtsState, getTtsState } from '../../tts/ttsState.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import logger from '../../../lib/logger.js';

export default {
    name: 'permission',
    description: 'Sets whether TTS reads messages from everyone or only mods when in "all" mode.',
    usage: '!tts permission <everyone|all|mods>',
    permission: 'moderator',
    execute: async (context) => {
        const { channel, user, args } = context;
        const channelNameNoHash = channel.substring(1);
        const displayName = user['display-name'] || user.username;

        const currentConfig = await getTtsState(channelNameNoHash);

        if (args.length === 0) {
            const currentPermission = currentConfig.ttsPermissionLevel || 'everyone';
            enqueueMessage(channel, `@${displayName}, TTS message permission is currently set to: ${currentPermission}. Usage: ${context.command.usage}`);
            return;
        }

        let newPermission = args[0].toLowerCase();

        // Alias 'all' to 'everyone'
        if (newPermission === 'all') {
            newPermission = 'everyone';
        }

        if (newPermission !== 'everyone' && newPermission !== 'mods') {
            enqueueMessage(channel, `@${displayName}, Invalid permission level. Use 'everyone' (or 'all') or 'mods'.`);
            return;
        }

        const success = await setTtsState(channelNameNoHash, 'ttsPermissionLevel', newPermission);

        if (success) {
            enqueueMessage(channel, `@${displayName}, TTS will now only read messages from: ${newPermission}.`);
            logger.info(`[${channelNameNoHash}] TTS permission level set to '${newPermission}' by ${user.username}.`);
        } else {
            enqueueMessage(channel, `@${displayName}, Could not set the TTS permission level.`);
        }
    },
};