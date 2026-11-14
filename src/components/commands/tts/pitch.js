import { createTtsSettingCommand } from './createTtsSettingCommand.js';
import { PITCH_STEPS, stepByWord } from '../../tts/styleBuilder.js';
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
    usage: '!tts pitch <number|word|reset>',
    readCurrent: async (context) => {
        const prefs = await getGlobalUserPreferences(context.user['user-id']);
        return prefs.pitch;
    },
    resetSetting: async (context) => clearGlobalUserPreference(context.user['user-id'], 'pitch'),
    setSetting: async (context, val) => setGlobalUserPreference(context.user['user-id'], 'pitch', val, context.user.username),
    // A step word (slow, very-fast, low, high) or a number. The number is what is stored.
    multiWord: true,
    parseFn: (str) => stepByWord(PITCH_STEPS, str)?.value ?? parseInt(str, 10),
    validateFn: (val) => !isNaN(val) && val >= TTS_PITCH_MIN && val <= TTS_PITCH_MAX,
    hintKey: 'cmd.hint.pitchSteps',
    hintParams: { min: TTS_PITCH_MIN, max: TTS_PITCH_MAX, list: PITCH_STEPS.map(step => step.key.replace('_', '-')).join(', ') },
    showChannelDefaultWhenUnset: true,
    logSet: (context, val) => `[${context.channel.substring(1)}] User ${context.user.username} set pitch preference to ${val}.`,
    logReset: (context) => `[${context.channel.substring(1)}] User ${context.user.username} reset pitch preference.`
});