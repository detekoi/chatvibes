// src/components/commands/tts/bits.js

import { setBitsConfig, getTtsState } from '../../tts/ttsState.js';
import { enqueueMessage } from '../../../lib/ircSender.js';

export default {
    name: 'bits',
    description: 'Configure Bits-for-TTS. Usage: !tts bits <on|off|min amount>',
    usage: '!tts bits <on|off|min amount>',
    permission: 'moderator',
    execute: async (context) => {
        const { channel, user, args } = context;
        const channelNameNoHash = channel.substring(1);
        const action = args[0]?.toLowerCase();

        const currentConfig = await getTtsState(channelNameNoHash);

        if (!action) {
            enqueueMessage(channel, `@${user['display-name']}, Bits-for-TTS is currently ${currentConfig.bitsModeEnabled ? 'ON' : 'OFF'} with a minimum of ${currentConfig.bitsMinimumAmount || 100} bits. Use !tts bits <on|off|min amount>.`);
            return;
        }

        let enabled = currentConfig.bitsModeEnabled;
        let minAmount = currentConfig.bitsMinimumAmount || 100;

        if (action === 'on') {
            enabled = true;
            await setBitsConfig(channelNameNoHash, { enabled, minimumAmount: minAmount });
            enqueueMessage(channel, `@${user['display-name']}, Bits-for-TTS has been ENABLED.`);
        } else if (action === 'off') {
            enabled = false;
            await setBitsConfig(channelNameNoHash, { enabled, minimumAmount: minAmount });
            enqueueMessage(channel, `@${user['display-name']}, Bits-for-TTS has been DISABLED.`);
        } else if (action === 'min') {
            const newMin = parseInt(args[1], 10);
            if (isNaN(newMin) || newMin < 1) {
                enqueueMessage(channel, `@${user['display-name']}, Please provide a valid minimum bit amount (e.g., !tts bits min 100).`);
                return;
            }
            minAmount = newMin;
            await setBitsConfig(channelNameNoHash, { enabled, minimumAmount: minAmount });
            enqueueMessage(channel, `@${user['display-name']}, Minimum Bits for TTS set to ${minAmount}.`);
        } else {
            enqueueMessage(channel, `@${user['display-name']}, Invalid command. Use !tts bits <on|off|min amount>.`);
        }
    },
};