import { createTtsSettingCommand } from './createTtsSettingCommand.js';
import {
    setGlobalUserPreference,
    clearGlobalUserPreference,
    getGlobalUserPreferences
} from '../../tts/ttsState.js';
import { VALID_EMOTIONS } from '../../tts/ttsConstants.js';

export default createTtsSettingCommand({
    name: 'emotion',
    scope: 'user',
    propertyKey: 'cmd.property.emotionPreference',
    description: `Sets your preferred TTS emotion. Valid emotions: ${VALID_EMOTIONS.join(', ')}. Use 'auto' or 'reset' to use channel default.`,
    usage: '!tts emotion <emotion_name|auto|reset>',
    readCurrent: async (context) => {
        const prefs = await getGlobalUserPreferences(context.user.username, context.user['user-id']);
        return prefs.emotion;
    },
    resetSetting: async (context) => clearGlobalUserPreference(context.user.username, 'emotion', context.user['user-id']),
    setSetting: async (context, val) => setGlobalUserPreference(context.user.username, 'emotion', val, context.user['user-id']),
    validateFn: (val) => VALID_EMOTIONS.includes(val),
    hintKey: 'cmd.hint.emotions',
    hintParams: { list: VALID_EMOTIONS.join(', ') },
    // Two different sentences rather than one with a blank slot: "you have not
    // set one" is not the same statement as "it is currently X".
    currentKey: (val) => (val ? 'cmd.emotion.current' : 'cmd.emotion.currentUnset'),
    setKey: 'cmd.emotion.set',
    resetKey: 'cmd.emotion.reset',
    logSet: (context, val) => `[${context.channel.substring(1)}] User ${context.user.username} set emotion preference to ${val}.`,
    logReset: (context) => `[${context.channel.substring(1)}] User ${context.user.username} reset emotion preference.`,
    resetAliases: ['reset', 'auto']
});