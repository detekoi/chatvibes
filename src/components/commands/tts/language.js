import { createTtsSettingCommand } from './createTtsSettingCommand.js';
import {
    setGlobalUserPreference,
    clearGlobalUserPreference,
    getGlobalUserPreferences
} from '../../tts/ttsState.js';
import { VALID_LANGUAGE_BOOSTS } from '../../tts/ttsConstants.js';

const docLink = 'https://docs.wildcat.chat/wildcatttsdocs.html#language-boost';

export default createTtsSettingCommand({
    name: 'language',
    property: 'language preference',
    description: `Sets your preferred TTS language boost. Use 'auto', 'none', or 'reset' for channel default. See !tts languageslist or ${docLink} for options.`,
    usage: `!tts language <language_name|auto|none|reset> (Full list: ${docLink})`,
    readCurrent: async (context) => {
        const prefs = await getGlobalUserPreferences(context.user.username, context.user['user-id']);
        return prefs.languageBoost;
    },
    resetSetting: async (context) => clearGlobalUserPreference(context.user.username, 'languageBoost', context.user['user-id']),
    setSetting: async (context, val) => setGlobalUserPreference(context.user.username, 'languageBoost', val, context.user['user-id']),
    validateFn: (val) => VALID_LANGUAGE_BOOSTS.some(l => l.toLowerCase() === val.toLowerCase()),
    transformFn: (val) => VALID_LANGUAGE_BOOSTS.find(l => l.toLowerCase() === val.toLowerCase()),
    validationHint: `See available languages: ${docLink}`,
    formatCurrent: (val, usage) => `Your current language preference: ${val ?? 'Channel Default'}. Usage: ${usage}`,
    formatSet: (val) => `Your TTS language preference set to ${val}.`,
    formatReset: () => `Your TTS language preference has been reset to the channel default (Automatic/None).`,
    logSet: (context, val) => `[${context.channel.substring(1)}] User ${context.user.username} set language preference to ${val}.`,
    logReset: (context) => `[${context.channel.substring(1)}] User ${context.user.username} reset language preference.`,
    resetAliases: ['reset', 'automatic', 'auto', 'none']
});