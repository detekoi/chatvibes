// src/components/commands/tts/toggleEvents.js
import { setTtsState, getTtsState } from '../../tts/ttsState.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import logger from '../../../lib/logger.js';

export default {
    name: 'toggleEvents', // Mapped from 'events'
    description: 'Toggles TTS for events like subscriptions, cheers, etc.',
    usage: '!tts events <on|off>',
    permission: 'moderator',
    execute: async (context) => {
        const { channel, user, args } = context;
        const channelNameNoHash = channel.substring(1);

        if (args.length === 0) {
            const currentState = await getTtsState(channelNameNoHash);
            enqueueMessage(channel, `@${user['display-name']}, TTS for events is currently ${currentState.speakEvents ? 'ON' : 'OFF'}. Use '!tts events <on|off>'.`);
            return;
        }

        const action = args[0].toLowerCase();
        let enableEvents;

        if (action === 'on') {
            enableEvents = true;
        } else if (action === 'off') {
            enableEvents = false;
        } else {
            enqueueMessage(channel, `@${user['display-name']}, Invalid argument. Use 'on' or 'off'.`);
            return;
        }

        const success = await setTtsState(channelNameNoHash, 'speakEvents', enableEvents);

        if (success) {
            enqueueMessage(channel, `@${user['display-name']}, TTS for events has been turned ${enableEvents ? 'ON' : 'OFF'}.`);
            logger.info(`ChatVibes [${channelNameNoHash}]: TTS events ${enableEvents ? 'enabled' : 'disabled'} by ${user.username}.`);
        } else {
            enqueueMessage(channel, `@${user['display-name']}, Could not toggle TTS for events.`);
        }
    },
};