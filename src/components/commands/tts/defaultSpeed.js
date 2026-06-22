import { createTtsSettingCommand } from './createTtsSettingCommand.js';
import {
    setChannelDefaultSpeed,
    resetChannelDefaultSpeed,
    getTtsState
} from '../../tts/ttsState.js';
import {
    TTS_SPEED_MIN,
    TTS_SPEED_MAX,
    TTS_SPEED_DEFAULT
} from '../../tts/ttsConstants.js';

export default createTtsSettingCommand({
    name: 'defaultspeed',
    property: 'speed',
    description: `Sets the channel's default TTS speed (${TTS_SPEED_MIN} to ${TTS_SPEED_MAX}, 1.0 is normal). Use 'reset' for default (${TTS_SPEED_DEFAULT}).`,
    usage: '!tts defaultspeed <value|reset>',
    permission: 'moderator',
    readCurrent: async (context) => {
        const config = await getTtsState(context.channel.substring(1));
        return config.speed ?? TTS_SPEED_DEFAULT;
    },
    resetSetting: async (context) => resetChannelDefaultSpeed(context.channel.substring(1)),
    setSetting: async (context, val) => setChannelDefaultSpeed(context.channel.substring(1), val),
    parseFn: (str) => parseFloat(str),
    validateFn: (val) => !isNaN(val) && val >= TTS_SPEED_MIN && val <= TTS_SPEED_MAX,
    validationHint: `Must be a number between ${TTS_SPEED_MIN} and ${TTS_SPEED_MAX}.`,
    formatCurrent: (val, usage) => `Current default speed: ${val}. Usage: ${usage}`,
    formatSet: (val) => `Channel default TTS speed set to ${val}.`,
    formatReset: () => `Channel default TTS speed reset to ${TTS_SPEED_DEFAULT}.`,
    logSet: (context, val) => `[${context.channel.substring(1)}] Channel default speed set to ${val}.`,
    logReset: (context) => `[${context.channel.substring(1)}] Channel default speed reset to ${TTS_SPEED_DEFAULT}.`
});
