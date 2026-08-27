import { createTtsSettingCommand } from './createTtsSettingCommand.js';
import {
    setChannelDefaultLanguage,
    resetChannelDefaultLanguage,
    getTtsState
} from '../../tts/ttsState.js';
import { VALID_LANGUAGE_BOOSTS, DEFAULT_TTS_SETTINGS, DOC_LINKS } from '../../tts/ttsConstants.js';

const docLink = DOC_LINKS.languageBoost;

export default createTtsSettingCommand({
    name: 'defaultlanguage',
    scope: 'channel',
    propertyKey: 'cmd.property.languageBoost',
    description: `Sets the channel's default TTS language boost. Use 'reset' for system default. Valid options: ${docLink}`,
    usage: '!tts defaultlanguage <language|reset>',
    permission: 'moderator',
    readCurrent: async (context) => {
        const config = await getTtsState(context.channel.substring(1));
        return config.languageBoost ?? DEFAULT_TTS_SETTINGS.languageBoost;
    },
    resetSetting: async (context) => resetChannelDefaultLanguage(context.channel.substring(1)),
    setSetting: async (context, val) => setChannelDefaultLanguage(context.channel.substring(1), val),
    validateFn: (val) => VALID_LANGUAGE_BOOSTS.some(l => l.toLowerCase() === val.toLowerCase()),
    transformFn: (val) => VALID_LANGUAGE_BOOSTS.find(l => l.toLowerCase() === val.toLowerCase()),
    hintKey: 'cmd.hint.languages',
    hintParams: { docLink },
    currentKey: 'cmd.defaultlanguage.current',
    messageParams: { docLink },
    resetValue: DEFAULT_TTS_SETTINGS.languageBoost,
    logSet: (context, val) => `[${context.channel.substring(1)}] Channel default language boost set to ${val}.`,
    logReset: (context) => `[${context.channel.substring(1)}] Channel default language boost reset to ${DEFAULT_TTS_SETTINGS.languageBoost}.`,
    resetAliases: ['reset', 'automatic', 'auto', 'none']
});