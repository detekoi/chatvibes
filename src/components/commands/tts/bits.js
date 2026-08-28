// src/components/commands/tts/bits.js

import { setBitsConfig, getTtsState } from '../../tts/ttsState.js';
import { enqueueMessage } from '../../../lib/chatSender.js';

export default {
    name: 'bitsconfig',
    description: 'Configure Bits → TTS. Usage: !tts bitsconfig <on|off|min amount>',
    usage: '!tts bitsconfig <on|off|min amount>',
    permission: 'moderator',
    execute: async (context) => {
        const { channel, /* user */ _, args, replyToId } = context;
        const channelNameNoHash = channel.substring(1);
        const action = args[0]?.toLowerCase();

        const currentConfig = await getTtsState(channelNameNoHash);

        if (!action) {
            enqueueMessage(channel, context.t('cmd.bits.current', { state: context.t(currentConfig.bitsModeEnabled ? 'cmd.onOff.on' : 'cmd.onOff.off'), minimum: currentConfig.bitsMinimumAmount || 100 }), { replyToId });
            return;
        }

        let enabled = currentConfig.bitsModeEnabled;
        let minAmount = currentConfig.bitsMinimumAmount || 100;

        if (action === 'on') {
            enabled = true;
            await setBitsConfig(channelNameNoHash, { enabled, minimumAmount: minAmount });
            enqueueMessage(channel, context.t('cmd.bits.enabled'), { replyToId });
        } else if (action === 'off') {
            enabled = false;
            await setBitsConfig(channelNameNoHash, { enabled, minimumAmount: minAmount });
            enqueueMessage(channel, context.t('cmd.bits.disabled'), { replyToId });
        } else if (action === 'min') {
            const newMin = parseInt(args[1], 10);
            if (isNaN(newMin) || newMin < 1) {
                enqueueMessage(channel, context.t('cmd.bits.needAmount'), { replyToId });
                return;
            }
            minAmount = newMin;
            await setBitsConfig(channelNameNoHash, { enabled, minimumAmount: minAmount });
            enqueueMessage(channel, context.t('cmd.bits.minSet', { minimum: minAmount }), { replyToId });
        } else {
            enqueueMessage(channel, context.t('cmd.bits.invalid'), { replyToId });
        }
    },
};