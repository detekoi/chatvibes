// src/components/commands/tts/toggleEngine.js
import { setTtsState, getTtsState } from '../../tts/ttsState.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import logger from '../../../lib/logger.js';

export default {
    name: 'toggleEngine', // This will be mapped from 'on', 'off', 'enable', 'disable'
    description: 'Enables or disables the TTS engine.',
    usage: '!tts <on|off|enable|disable>',
    permission: 'moderator', // Mod only
    execute: async (context) => {
        const { channel, user, args } = context;
        const channelNameNoHash = channel.substring(1);
        const commandAction = context.command; // The actual command used e.g., 'on', 'off'

        let enable = false;
        if (['on', 'enable'].includes(commandAction)) {
            enable = true;
        } else if (['off', 'disable'].includes(commandAction)) {
            enable = false;
        } else {
            // Should not happen if routing is correct, but as a fallback
            enqueueMessage(channel, `@${user['display-name']}, Invalid action. Use on/off/enable/disable.`);
            return;
        }

        const success = await setTtsState(channelNameNoHash, 'engineEnabled', enable);

        if (success) {
            enqueueMessage(channel, `@${user['display-name']}, TTS engine has been ${enable ? 'ENABLED' : 'DISABLED'}.`);
            logger.info(`ChatVibes [${channelNameNoHash}]: TTS engine ${enable ? 'enabled' : 'disabled'} by ${user.username}.`);
        } else {
            enqueueMessage(channel, `@${user['display-name']}, Could not change TTS engine state.`);
        }
    },
};