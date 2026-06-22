import { createTtsSettingCommand } from './createTtsSettingCommand.js';
import {
    setChannelDefaultEmotion,
    resetChannelDefaultEmotion,
    getTtsState
} from '../../tts/ttsState.js';
import {
    VALID_EMOTIONS,
    DEFAULT_TTS_SETTINGS
} from '../../tts/ttsConstants.js';

export default createTtsSettingCommand({
    name: 'defaultemotion',
    property: 'emotion',
    description: `Sets the channel's default TTS emotion. Valid: ${VALID_EMOTIONS.join(', ')}. Use 'reset' for system default.`,
    usage: '!tts defaultemotion <emotion|reset>',
    permission: 'moderator',
    readCurrent: async (context) => {
        const config = await getTtsState(context.channel.substring(1));
        return config.emotion ?? DEFAULT_TTS_SETTINGS.emotion;
    },
    resetSetting: async (context) => resetChannelDefaultEmotion(context.channel.substring(1)),
    setSetting: async (context, val) => setChannelDefaultEmotion(context.channel.substring(1), val),
    validateFn: (val) => VALID_EMOTIONS.includes(val),
    validationHint: `Valid emotions are: ${VALID_EMOTIONS.join(', ')}.`,
    formatCurrent: (val, usage) => `Current default emotion: ${val}. Usage: ${usage}`,
    formatSet: (val) => `Channel default TTS emotion set to ${val}.`,
    formatReset: () => `Channel default TTS emotion reset to ${DEFAULT_TTS_SETTINGS.emotion}.`,
    logSet: (context, val) => `[${context.channel.substring(1)}] Channel default emotion set to ${val}.`,
    logReset: (context) => `[${context.channel.substring(1)}] Channel default emotion reset to ${DEFAULT_TTS_SETTINGS.emotion}.`
});
