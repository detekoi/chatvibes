import { createTtsSettingCommand } from './createTtsSettingCommand.js';
import { SPEED_STEPS, stepByWord } from '../../tts/styleBuilder.js';
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
    scope: 'user',
    propertyKey: 'cmd.property.speedPreference',
    description: `Sets your personal TTS speed (${TTS_SPEED_MIN} to ${TTS_SPEED_MAX}, 1.0 is normal). Use 'reset' for channel default.`,
    usage: '!tts speed <number|word|reset>',
    readCurrent: async (context) => {
        const prefs = await getGlobalUserPreferences(context.user['user-id']);
        return prefs.speed;
    },
    resetSetting: async (context) => clearGlobalUserPreference(context.user['user-id'], 'speed'),
    setSetting: async (context, val) => setGlobalUserPreference(context.user['user-id'], 'speed', val, context.user.username),
    // A step word (slow, very-fast, low, high) or a number. The number is what is stored.
    parseFn: (str) => stepByWord(SPEED_STEPS, str)?.value ?? parseFloat(str),
    validateFn: (val) => !isNaN(val) && val >= TTS_SPEED_MIN && val <= TTS_SPEED_MAX,
    hintKey: 'cmd.hint.speedSteps',
    hintParams: { min: TTS_SPEED_MIN, max: TTS_SPEED_MAX, list: SPEED_STEPS.map(step => step.key.replace('_', '-')).join(', ') },
    showChannelDefaultWhenUnset: true,
    logSet: (context, val) => `[${context.channel.substring(1)}] User ${context.user.username} set speed preference to ${val}.`,
    logReset: (context) => `[${context.channel.substring(1)}] User ${context.user.username} reset speed preference.`
});
