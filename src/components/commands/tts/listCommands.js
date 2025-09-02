// src/components/commands/tts/listCommands.js
import { enqueueMessage } from '../../../lib/ircSender.js';

export default {
    name: 'listCommands', // This will be mapped to 'commands' and 'help'
    description: 'Provides a link to the full list of TTS commands.',
    usage: '!tts commands (or !tts help)',
    permission: 'everyone',
    execute: async (context) => {
        const { channel, replyToId } = context;
        const docLink = 'https://detekoi.github.io/chatvibesdocs.html#commands';
        enqueueMessage(channel, `You can find the full list of commands here: ${docLink}`, { replyToId });
    },
};
