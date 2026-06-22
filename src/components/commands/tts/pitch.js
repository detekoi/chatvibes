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
    property: 'pitch preference',
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
    validationHint: `Must be an integer between ${TTS_PITCH_MIN} and ${TTS_PITCH_MAX}.`,
    formatCurrent: (val, usage) => `Your current pitch preference: ${val ?? 'Channel Default'}. Usage: ${usage}`,
    formatSet: (val) => `Your TTS pitch preference set to ${val}.`,
    formatReset: () => `Your TTS pitch preference has been reset to the channel default.`,
    logSet: (context, val) => `[${context.channel.substring(1)}] User ${context.user.username} set pitch preference to ${val}.`,
    logReset: (context) => `[${context.channel.substring(1)}] User ${context.user.username} reset pitch preference.`
});