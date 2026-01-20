// src/components/commands/tts/languagesList.js
import { enqueueMessage } from '../../../lib/chatSender.js';

export default {
    name: 'languageslist',
    description: 'Provides a link to the documentation section for available TTS language boost options.',
    usage: '!tts languageslist',
    permission: 'everyone',
    execute: async (context) => {
        const { channel, replyToId } = context;
        // Point to the new section in your existing documentation URL
        const docLink = 'https://docs.wildcat.chat/wildcatttsdocs.html#language-boost'; 
        enqueueMessage(channel, `You can find the list of available language boost options here: ${docLink}`, { replyToId });
    },
};