import { createTtsSettingCommand } from './createTtsSettingCommand.js';
import {
    setGlobalUserPreference,
    clearGlobalUserPreference,
    getGlobalUserPreferences
} from '../../tts/ttsState.js';
import {
    TTS_PITCH_MIN,
    TTS_PITCH_MAX
} from '../../tts/ttsConstants.js';

export default createTtsSettingCommand({
    name: 'pitch',
    scope: 'user',
    propertyKey: 'cmd.property.pitchPreference',
    description: `Sets your personal TTS pitch (${TTS_PITCH_MIN} to ${TTS_PITCH_MAX}, 0 is normal). Use 'reset' for channel default.`,
    usage: '!tts pitch <value|reset>',
    readCurrent: async (context) => {
        const prefs = await getGlobalUserPreferences(context.user.username, context.user['user-id']);
        return prefs.pitch;
    },
    resetSetting: async (context) => clearGlobalUserPreference(context.user.username, 'pitch', context.user['user-id']),
    setSetting: async (context, val) => setGlobalUserPreference(context.user.username, 'pitch', val, context.user['user-id']),
    parseFn: (str) => parseInt(str, 10),
    validateFn: (val) => !isNaN(val) && val >= TTS_PITCH_MIN && val <= TTS_PITCH_MAX,
    hintKey: 'cmd.hint.integerRange',
    hintParams: { min: TTS_PITCH_MIN, max: TTS_PITCH_MAX },
    showChannelDefaultWhenUnset: true,
    logSet: (context, val) => `[${context.channel.substring(1)}] User ${context.user.username} set pitch preference to ${val}.`,
    logReset: (context) => `[${context.channel.substring(1)}] User ${context.user.username} reset pitch preference.`
});