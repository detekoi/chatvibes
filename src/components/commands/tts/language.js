import { createTtsSettingCommand } from './createTtsSettingCommand.js';
import {
    setGlobalUserPreference,
    clearGlobalUserPreference,
    getGlobalUserPreferences
} from '../../tts/ttsState.js';
import { VALID_LANGUAGE_BOOSTS, DOC_LINKS } from '../../tts/ttsConstants.js';

const docLink = DOC_LINKS.languageBoost;

export default createTtsSettingCommand({
    name: 'language',
    scope: 'user',
    propertyKey: 'cmd.property.languagePreference',
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
    hintKey: 'cmd.hint.languages',
    hintParams: { docLink },
    showChannelDefaultWhenUnset: true,
    resetKey: 'cmd.language.reset',
    logSet: (context, val) => `[${context.channel.substring(1)}] User ${context.user.username} set language preference to ${val}.`,
    logReset: (context) => `[${context.channel.substring(1)}] User ${context.user.username} reset language preference.`,
    resetAliases: ['reset', 'automatic', 'auto', 'none']
});