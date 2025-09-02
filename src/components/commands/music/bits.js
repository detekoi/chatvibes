// src/components/commands/music/bits.js

import { setBitsConfigMusic, getMusicState } from '../../music/musicState.js';
import { enqueueMessage } from '../../../lib/ircSender.js';

export default {
    name: 'bits',
    description: 'Configures Bits-for-Music. When enabled, users must cheer with their prompt. Usage: !music bits <on|off|min amount>',
    usage: '!music bits <on|off|min amount>',
    permission: 'moderator',
    execute: async (context) => {
        const { channel, user, args, replyToId } = context;
        const channelNameNoHash = channel.substring(1);
        const action = args[0]?.toLowerCase();

        const currentConfig = await getMusicState(channelNameNoHash);

        if (!action) {
            enqueueMessage(channel, `Bits-for-Music is currently ${currentConfig.bitsModeEnabled ? 'ON' : 'OFF'} with a minimum of ${currentConfig.bitsMinimumAmount || 100} bits. Use !music bits <on|off|min amount>.`, { replyToId });
            return;
        }

        let enabled = currentConfig.bitsModeEnabled;
        let minAmount = currentConfig.bitsMinimumAmount || 100;

        if (action === 'on') {
            enabled = true;
            await setBitsConfigMusic(channelNameNoHash, { enabled, minimumAmount: minAmount });
            enqueueMessage(channel, `Bits-for-Music has been ENABLED. Users must now cheer with their prompt to generate music.`, { replyToId });
        } else if (action === 'off') {
            enabled = false;
            await setBitsConfigMusic(channelNameNoHash, { enabled, minimumAmount: minAmount });
            enqueueMessage(channel, `Bits-for-Music has been DISABLED.`, { replyToId });
        } else if (action === 'min') {
            const newMin = parseInt(args[1], 10);
            if (isNaN(newMin) || newMin < 1) {
                enqueueMessage(channel, `Please provide a valid minimum bit amount (e.g., !music bits min 100).`, { replyToId });
                return;
            }
            minAmount = newMin;
            await setBitsConfigMusic(channelNameNoHash, { enabled: enabled, minimumAmount: minAmount }); // Pass existing 'enabled' state
            enqueueMessage(channel, `Minimum Bits for Music set to ${minAmount}.`, { replyToId });
        } else {
            enqueueMessage(channel, `Invalid command. Use !music bits <on|off|min amount>.`, { replyToId });
        }
    },
};