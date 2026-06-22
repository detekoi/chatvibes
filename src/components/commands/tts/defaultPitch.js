import { createTtsSettingCommand } from './createTtsSettingCommand.js';
import {
    setChannelDefaultPitch,
    resetChannelDefaultPitch,
    getTtsState
} from '../../tts/ttsState.js';
import {
    TTS_PITCH_MIN,
    TTS_PITCH_MAX,
    TTS_PITCH_DEFAULT
} from '../../tts/ttsConstants.js';

export default createTtsSettingCommand({
    name: 'defaultpitch',
    property: 'pitch',
    description: `Sets the channel's default TTS pitch (${TTS_PITCH_MIN} to ${TTS_PITCH_MAX}, 0 is normal). Use 'reset' for default (${TTS_PITCH_DEFAULT}).`,
    usage: '!tts defaultpitch <value|reset>',
    permission: 'moderator',
    readCurrent: async (context) => {
        const config = await getTtsState(context.channel.substring(1));
        return config.pitch ?? TTS_PITCH_DEFAULT;
    },
    resetSetting: async (context) => resetChannelDefaultPitch(context.channel.substring(1)),
    setSetting: async (context, val) => setChannelDefaultPitch(context.channel.substring(1), val),
    parseFn: (str) => parseInt(str, 10),
    validateFn: (val) => !isNaN(val) && val >= TTS_PITCH_MIN && val <= TTS_PITCH_MAX,
    validationHint: `Must be an integer between ${TTS_PITCH_MIN} and ${TTS_PITCH_MAX}.`,
    formatCurrent: (val, usage) => `Current default pitch: ${val}. Usage: ${usage}`,
    formatSet: (val) => `Channel default TTS pitch set to ${val}.`,
    formatReset: () => `Channel default TTS pitch reset to ${TTS_PITCH_DEFAULT}.`,
    logSet: (context, val) => `[${context.channel.substring(1)}] Channel default pitch set to ${val}.`,
    logReset: (context) => `[${context.channel.substring(1)}] Channel default pitch reset to ${TTS_PITCH_DEFAULT}.`
});