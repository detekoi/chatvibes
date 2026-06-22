import { createTtsSettingCommand } from './createTtsSettingCommand.js';
import {
    setGlobalUserPreference,
    clearGlobalUserPreference,
    getGlobalUserPreferences
} from '../../tts/ttsState.js';
import {
    TTS_SPEED_MIN,
    TTS_SPEED_MAX
} from '../../tts/ttsConstants.js';

export default createTtsSettingCommand({
    name: 'speed',
    property: 'speed preference',
    description: `Sets your personal TTS speed (${TTS_SPEED_MIN} to ${TTS_SPEED_MAX}, 1.0 is normal). Use 'reset' for channel default.`,
    usage: '!tts speed <value|reset>',
    readCurrent: async (context) => {
        const prefs = await getGlobalUserPreferences(context.user.username, context.user['user-id']);
        return prefs.speed;
    },
    resetSetting: async (context) => clearGlobalUserPreference(context.user.username, 'speed', context.user['user-id']),
    setSetting: async (context, val) => setGlobalUserPreference(context.user.username, 'speed', val, context.user['user-id']),
    parseFn: (str) => parseFloat(str),
    validateFn: (val) => !isNaN(val) && val >= TTS_SPEED_MIN && val <= TTS_SPEED_MAX,
    validationHint: `Must be a number between ${TTS_SPEED_MIN} and ${TTS_SPEED_MAX}.`,
    formatCurrent: (val, usage) => `Your current speed preference: ${val ?? 'Channel Default'}. Usage: ${usage}`,
    formatSet: (val) => `Your TTS speed preference set to ${val}.`,
    formatReset: () => `Your TTS speed preference has been reset to the channel default.`,
    logSet: (context, val) => `[${context.channel.substring(1)}] User ${context.user.username} set speed preference to ${val}.`,
    logReset: (context) => `[${context.channel.substring(1)}] User ${context.user.username} reset speed preference.`
});
