import { createTtsSettingCommand } from './createTtsSettingCommand.js';
import {
    setGlobalUserPreference,
    clearGlobalUserPreference,
    getGlobalUserPreferences
} from '../../tts/ttsState.js';
import { VALID_EMOTIONS } from '../../tts/ttsConstants.js';

export default createTtsSettingCommand({
    name: 'emotion',
    property: 'emotion preference',
    description: `Sets your preferred TTS emotion. Valid emotions: ${VALID_EMOTIONS.join(', ')}. Use 'auto' or 'reset' to use channel default.`,
    usage: '!tts emotion <emotion_name|auto|reset>',
    readCurrent: async (context) => {
        const prefs = await getGlobalUserPreferences(context.user.username, context.user['user-id']);
        return prefs.emotion;
    },
    resetSetting: async (context) => clearGlobalUserPreference(context.user.username, 'emotion', context.user['user-id']),
    setSetting: async (context, val) => setGlobalUserPreference(context.user.username, 'emotion', val, context.user['user-id']),
    validateFn: (val) => VALID_EMOTIONS.includes(val),
    validationHint: `Valid options are: ${VALID_EMOTIONS.join(', ')}.`,
    formatCurrent: (val, usage) => val
        ? `Your current TTS emotion is set to: ${val}. Usage: ${usage}`
        : `You haven't set a specific TTS emotion. The channel default will be used. Usage: ${usage}`,
    formatSet: (val) => `Your TTS emotion has been set to: ${val}.`,
    formatReset: () => `Your TTS emotion preference has been reset. The channel default will now be used.`,
    logSet: (context, val) => `[${context.channel.substring(1)}] User ${context.user.username} set emotion preference to ${val}.`,
    logReset: (context) => `[${context.channel.substring(1)}] User ${context.user.username} reset emotion preference.`,
    resetAliases: ['reset', 'auto']
});