// src/components/commands/tts/listCommands.js
import { enqueueMessage } from '../../../lib/chatSender.js';

export default {
    name: 'listCommands', // This will be mapped to 'commands' and 'help'
    description: 'Provides a link to the full list of TTS commands.',
    usage: '!tts commands (or !tts help)',
    permission: 'everyone',
    execute: async (context) => {
        const { channel, replyToId } = context;
        const docLink = 'https://docs.wildcat.chat/wildcatttsdocs.html#commands';
        enqueueMessage(channel, context.t('cmd.commands.link', { docLink }), { replyToId });
    },
};
