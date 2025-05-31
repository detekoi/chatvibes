// src/components/commands/music/mode.js
import { setAllowedMusicRoles, getMusicState } from '../../music/musicState.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import logger from '../../../lib/logger.js';

export default {
    name: 'mode',
    description: 'Sets who can use the !music <prompt> command.',
    usage: '!music mode <all|mods>',
    permission: 'moderator',
    execute: async (context) => {
        const { channel, user, args } = context;
        const channelNameNoHash = channel.substring(1);
        const displayName = user['display-name'] || user.username;

        if (args.length === 0) {
            const currentConfig = await getMusicState(channelNameNoHash);
            const currentMode = currentConfig.allowedRoles.includes('everyone') ? 'all' : 'mods';
            enqueueMessage(channel, `@${displayName}, Current music generation mode: ${currentMode}. Usage: ${this.usage}`);
            return;
        }

        const newMode = args[0].toLowerCase();
        let success;
        let newRoles;

        if (newMode === 'all') {
            newRoles = ['everyone'];
            success = await setAllowedMusicRoles(channelNameNoHash, newRoles);
        } else if (newMode === 'mods') {
            newRoles = ['moderator'];
            success = await setAllowedMusicRoles(channelNameNoHash, newRoles);
        } else {
            enqueueMessage(channel, `@${displayName}, Invalid mode. Use 'all' or 'mods'.`);
            return;
        }

        if (success) {
            enqueueMessage(channel, `@${displayName}, Music generation mode set to: ${newMode} (allows ${newRoles.join(', ')}).`);
            logger.info(`[${channelNameNoHash}] Music mode set to ${newMode} by ${user.username}.`);
        } else {
            enqueueMessage(channel, `@${displayName}, Could not set music generation mode.`);
        }
    },
};