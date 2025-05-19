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
        const actionTriggered = context.command; // This will be 'on', 'off', 'enable', or 'disable'

        let enableTTS;
        if (["on", "enable"].includes(actionTriggered)) {
            enableTTS = true;
        } else if (["off", "disable"].includes(actionTriggered)) {
            enableTTS = false;
        } else {
            // This case should ideally not be reached if routing in tts.js is correct
            logger.error(`toggleEngine called with unexpected action: ${actionTriggered}`);
            enqueueMessage(channel, `@${user['display-name']}, Internal error processing command '${actionTriggered}'.`);
            return;
        }

        const success = await setTtsState(channelNameNoHash, 'engineEnabled', enableTTS);

        if (success) {
            const statusMessage = `TTS engine has been ${enableTTS ? 'ENABLED' : 'DISABLED'}.`;
            enqueueMessage(channel, `@${user['display-name']}, ${statusMessage}`);
            logger.info(`ChatVibes [${channelNameNoHash}]: ${statusMessage} by ${user.username}.`);
        } else {
            enqueueMessage(channel, `@${user['display-name']}, Could not change TTS engine state at this time.`);
        }
    },
};