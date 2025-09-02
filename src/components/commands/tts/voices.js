// src/components/commands/tts/voices.js
import { enqueueMessage } from '../../../lib/ircSender.js';

export default {
    name: 'voices',
    description: 'Provides a link to the documentation section for available TTS voices.',
    usage: '!tts voices',
    permission: 'everyone',
    execute: async (context) => {
        const { channel, user, replyToId } = context;
        const docLink = 'https://detekoi.github.io/chatvibesdocs.html#voices';
        enqueueMessage(channel, `You can find the list of available voices here: ${docLink}`, { replyToId });
    },
};
