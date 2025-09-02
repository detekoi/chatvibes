// src/components/commands/tts/language.js
import {
    setUserLanguagePreference,
    clearUserLanguagePreference,
    getUserLanguagePreference
} from '../../tts/ttsState.js';
import { VALID_LANGUAGE_BOOSTS } from '../../tts/ttsConstants.js';
import { enqueueMessage } from '../../../lib/ircSender.js';

const docLink = 'https://detekoi.github.io/chatvibesdocs.html#language-boost';

export default {
    name: 'language', // Also mapped to 'lang'
    description: `Sets your preferred TTS language boost. Use 'auto', 'none', or 'reset' for channel default. See !tts languageslist or ${docLink} for options.`,
    usage: `!tts language <language_name|auto|none|reset> (Full list: ${docLink})`,
    permission: 'everyone',
    execute: async (context) => {
        const { channel, user, args, replyToId } = context;
        const channelNameNoHash = channel.substring(1);
        const username = user.username;

        if (args.length === 0) {
            const currentLang = await getUserLanguagePreference(channelNameNoHash, username);
            // Updated message to include the docLink
            enqueueMessage(channel, `Your current language preference: ${currentLang ?? 'Channel Default'}. Usage: !tts language <language_name|auto|none|reset>. See valid options: ${docLink}`, { replyToId });
            return;
        }

        const requestedLang = args[0].toLowerCase();
        let success;

        if (['reset', 'default', 'automatic', 'auto', 'none'].includes(requestedLang)) {
            success = await clearUserLanguagePreference(channelNameNoHash, username);
            if (success) {
                enqueueMessage(channel, `Your TTS language preference has been reset to the channel default (Automatic/None).`, { replyToId });
            } else {
                enqueueMessage(channel, `Could not reset your language preference.`, { replyToId });
            }
        } else {
            const foundLang = VALID_LANGUAGE_BOOSTS.find(l => l.toLowerCase() === requestedLang);
            if (!foundLang) {
                // Updated message to include the docLink
                enqueueMessage(channel, `Invalid language. See available languages: ${docLink}`, { replyToId });
                return;
            }
            success = await setUserLanguagePreference(channelNameNoHash, username, foundLang);
            if (success) {
                enqueueMessage(channel, `Your TTS language preference set to ${foundLang}.`, { replyToId });
            } else {
                enqueueMessage(channel, `Could not set your language preference to ${foundLang}.`, { replyToId });
            }
        }
    },
};