// src/components/commands/tts/defaultLanguage.js
import {
    setChannelDefaultLanguage,
    resetChannelDefaultLanguage,
    getTtsState
} from '../../tts/ttsState.js';
import { VALID_LANGUAGE_BOOSTS, DEFAULT_TTS_SETTINGS } from '../../tts/ttsConstants.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import logger from '../../../lib/logger.js';

const commandUsage = '!tts defaultlanguage <language|reset>'; // Define usage string
const docLink = 'https://detekoi.github.io/chatvibesdocs.html#language-boost';

export default {
    name: 'defaultlanguage',
    description: `Sets the channel's default TTS language boost. Use 'reset' for system default. Valid options: ${docLink}`,
    usage: commandUsage, // Use the defined usage string
    permission: 'moderator',
    execute: async (context) => {
        const { channel, args, replyToId } = context;
        const channelNameNoHash = channel.substring(1);

        if (args.length === 0) {
            const currentConfig = await getTtsState(channelNameNoHash);
            // Correctly refer to commandUsage defined above, not this.usage
            enqueueMessage(channel, `Current default language boost: ${currentConfig.languageBoost ?? DEFAULT_TTS_SETTINGS.languageBoost}. Usage: ${commandUsage}. Options: ${docLink}`, { replyToId });
            return;
        }

        const actionOrValue = args[0].toLowerCase();
        let success;

        if (['reset', 'automatic', 'auto', 'none'].includes(actionOrValue)) {
            success = await resetChannelDefaultLanguage(channelNameNoHash);
            if (success) {
                enqueueMessage(channel, `Channel default TTS language boost reset to ${DEFAULT_TTS_SETTINGS.languageBoost}.`, { replyToId });
                logger.info(`[${channelNameNoHash}] Channel default language boost reset.`);
            } else {
                enqueueMessage(channel, `Could not reset channel default language boost.`, { replyToId });
            }
        } else {
            const foundLang = VALID_LANGUAGE_BOOSTS.find(l => l.toLowerCase() === actionOrValue);
            if (!foundLang) {
                 // Updated message to include the docLink
                enqueueMessage(channel, `Invalid language. See available languages: ${docLink}`, { replyToId });
                return;
            }
            success = await setChannelDefaultLanguage(channelNameNoHash, foundLang);
            if (success) {
                enqueueMessage(channel, `Channel default TTS language boost set to ${foundLang}.`, { replyToId });
                logger.info(`[${channelNameNoHash}] Channel default language boost set to ${foundLang}.`);
            } else {
                enqueueMessage(channel, `Could not set channel default language boost to ${foundLang}.`, { replyToId });
            }
        }
    },
};