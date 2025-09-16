// src/components/commands/tts/mode.js
import { setTtsState, getTtsState } from '../../tts/ttsState.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import logger from '../../../lib/logger.js';

export default {
    name: 'mode',
    description: 'Sets TTS mode: all chat, commands only, or bits/points only.',
    usage: '!tts mode <all|command|bits|points>',
    permission: 'moderator',
    execute: async (context) => {
        const { channel, user, args, replyToId } = context;
        const channelNameNoHash = channel.substring(1);

        if (args.length === 0) {
            const currentState = await getTtsState(channelNameNoHash);
            enqueueMessage(channel, `Current TTS mode is: ${currentState.mode}. Use '!tts mode <all|command|bits|points>'.`, { replyToId });
            return;
        }

        const rawMode = args[0].toLowerCase();
        let newMode = rawMode;
        if (rawMode === 'bits' || rawMode === 'points' || rawMode === 'bits_points_only') {
            newMode = 'bits_points_only';
        } else if (rawMode !== 'all' && rawMode !== 'command') {
            enqueueMessage(channel, `Invalid mode. Use 'all', 'command', 'bits', or 'points'.`, { replyToId });
            return;
        }

        const success = await setTtsState(channelNameNoHash, 'mode', newMode);

        if (success) {
            enqueueMessage(channel, `TTS mode set to: ${newMode}.`, { replyToId });
            logger.info(`ChatVibes [${channelNameNoHash}]: TTS mode set to ${newMode} by ${user.username}.`);
        } else {
            enqueueMessage(channel, `Could not set TTS mode.`, { replyToId });
        }
    },
};