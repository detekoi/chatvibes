// src/components/commands/tts/bits.js

import { setBitsConfig, getTtsState } from '../../tts/ttsState.js';
import { enqueueMessage } from '../../../lib/ircSender.js';

export default {
    name: 'bits',
    description: 'Configure Bits-for-TTS. Usage: !tts bits <on|off|min amount>',
    usage: '!tts bits <on|off|min amount>',
    permission: 'moderator',
    execute: async (context) => {
        const { channel, /* user */ _, args, replyToId } = context;
        const channelNameNoHash = channel.substring(1);
        const action = args[0]?.toLowerCase();

        const currentConfig = await getTtsState(channelNameNoHash);

        if (!action) {
            enqueueMessage(channel, `Bits-for-TTS is currently ${currentConfig.bitsModeEnabled ? 'ON' : 'OFF'} with a minimum of ${currentConfig.bitsMinimumAmount || 100} bits. Use !tts bits <on|off|min amount>.`, { replyToId });
            return;
        }

        let enabled = currentConfig.bitsModeEnabled;
        let minAmount = currentConfig.bitsMinimumAmount || 100;

        if (action === 'on') {
            enabled = true;
            await setBitsConfig(channelNameNoHash, { enabled, minimumAmount: minAmount });
            enqueueMessage(channel, `Bits-for-TTS has been ENABLED.`, { replyToId });
        } else if (action === 'off') {
            enabled = false;
            await setBitsConfig(channelNameNoHash, { enabled, minimumAmount: minAmount });
            enqueueMessage(channel, `Bits-for-TTS has been DISABLED.`, { replyToId });
        } else if (action === 'min') {
            const newMin = parseInt(args[1], 10);
            if (isNaN(newMin) || newMin < 1) {
                enqueueMessage(channel, `Please provide a valid minimum bit amount (e.g., !tts bits min 100).`, { replyToId });
                return;
            }
            minAmount = newMin;
            await setBitsConfig(channelNameNoHash, { enabled, minimumAmount: minAmount });
            enqueueMessage(channel, `Minimum Bits for TTS set to ${minAmount}.`, { replyToId });
        } else {
            enqueueMessage(channel, `Invalid command. Use !tts bits <on|off|min amount>.`, { replyToId });
        }
    },
};