// src/components/commands/tts/language.js
import {
    setUserLanguagePreference,
    clearUserLanguagePreference,
    getUserLanguagePreference
} from '../../tts/ttsState.js';
import { VALID_LANGUAGE_BOOSTS } from '../../tts/ttsConstants.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import logger from '../../../lib/logger.js';

const docLink = 'https://detekoi.github.io/chatvibesdocs.html#language-boost';

export default {
    name: 'language', // Also mapped to 'lang'
    description: `Sets your preferred TTS language boost. Use 'auto', 'none', or 'reset' for channel default. See !tts languageslist or ${docLink} for options.`,
    usage: `!tts language <language_name|auto|none|reset> (Full list: ${docLink})`,
    permission: 'everyone',
    execute: async (context) => {
        const { channel, user, args } = context;
        const channelNameNoHash = channel.substring(1);
        const username = user.username;
        const displayName = user['display-name'] || username;

        if (args.length === 0) {
            const currentLang = await getUserLanguagePreference(channelNameNoHash, username);
            // Updated message to include the docLink
            enqueueMessage(channel, `@${displayName}, Your current language preference: ${currentLang ?? 'Channel Default'}. Usage: ${this.usage}. See valid options: ${docLink}`);
            return;
        }

        const requestedLang = args[0].toLowerCase();
        let success;

        if (['reset', 'default', 'automatic', 'auto', 'none'].includes(requestedLang)) {
            success = await clearUserLanguagePreference(channelNameNoHash, username);
            if (success) {
                enqueueMessage(channel, `@${displayName}, Your TTS language preference has been reset to the channel default (Automatic/None).`);
            } else {
                enqueueMessage(channel, `@${displayName}, Could not reset your language preference.`);
            }
        } else {
            const foundLang = VALID_LANGUAGE_BOOSTS.find(l => l.toLowerCase() === requestedLang);
            if (!foundLang) {
                // Updated message to include the docLink
                enqueueMessage(channel, `@${displayName}, Invalid language. See available languages: ${docLink}`);
                return;
            }
            success = await setUserLanguagePreference(channelNameNoHash, username, foundLang);
            if (success) {
                enqueueMessage(channel, `@${displayName}, Your TTS language preference set to ${foundLang}.`);
            } else {
                enqueueMessage(channel, `@${displayName}, Could not set your language preference to ${foundLang}.`);
            }
        }
    },
};