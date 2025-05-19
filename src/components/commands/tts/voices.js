// src/components/commands/tts/voices.js
import logger from '../../../lib/logger.js';
import { getAvailableVoices } from '../../tts/ttsService.js';
import { enqueueMessage } from '../../../lib/ircSender.js';

export default {
    name: 'voices',
    description: 'Lists available TTS voices by language.',
    usage: '!tts voices',
    permission: 'everyone',
    execute: async (context) => {
        const { channel, user } = context;
        try {
            const voices = await getAvailableVoices(); // Fetches from cache or refreshes
            if (!voices || voices.length === 0) {
                enqueueMessage(channel, `@${user['display-name']}, Sorry, I couldn't retrieve the voice list right now.`);
                return;
            }

            const voicesByLanguage = voices.reduce((acc, voice) => {
                const lang = voice.language || 'Unknown';
                if (!acc[lang]) {
                    acc[lang] = [];
                }
                acc[lang].push(voice.name);
                return acc;
            }, {});

            let response = `@${user['display-name']}, Available voices (${voices.length} total): `;
            const langSummaries = [];
            for (const lang in voicesByLanguage) {
                langSummaries.push(`${lang} (${voicesByLanguage[lang].length})`);
            }
            // Join summaries, ensuring message isn't too long for Twitch chat
            let summaryText = langSummaries.join(', ');
            if (response.length + summaryText.length > 450) {
                 summaryText = langSummaries.slice(0, 5).join(', ') + '... and more.'; // Limit reported languages if too many
            }
            response += summaryText;

            enqueueMessage(channel, response);

        } catch (error) {
            logger.error({ err: error, channel: channel.substring(1), user: user.username }, 'Error executing !tts voices command');
            enqueueMessage(channel, `@${user['display-name']}, An error occurred while fetching the voice list.`);
        }
    },
};