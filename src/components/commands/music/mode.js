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
        const { channel, user, args, replyToId } = context;
        const channelNameNoHash = channel.substring(1);
        const displayName = user['display-name'] || user.username; // reserved for future messages

        if (args.length === 0) {
            const currentConfig = await getMusicState(channelNameNoHash);
            const currentMode = currentConfig.allowedRoles.includes('everyone') ? 'all' : 'mods';
            enqueueMessage(channel, `Current music generation mode: ${currentMode}. Usage: !music mode <all|mods>`, { replyToId });
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
            enqueueMessage(channel, `Invalid mode. Use 'all' or 'mods'.`, { replyToId });
            return;
        }

        if (success) {
            enqueueMessage(channel, `Music generation mode set to: ${newMode} (allows ${newRoles.join(', ')}).`, { replyToId });
            logger.info(`[${channelNameNoHash}] Music mode set to ${newMode} by ${user.username}.`);
        } else {
            enqueueMessage(channel, `Could not set music generation mode.`, { replyToId });
        }
    },
};