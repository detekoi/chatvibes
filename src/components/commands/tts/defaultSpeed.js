import { createTtsSettingCommand } from './createTtsSettingCommand.js';
import { SPEED_STEPS, stepByWord } from '../../tts/styleBuilder.js';
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
    scope: 'channel',
    propertyKey: 'cmd.property.speed',
    description: `Sets the channel's default TTS speed (${TTS_SPEED_MIN} to ${TTS_SPEED_MAX}, 1.0 is normal). Use 'reset' for default (${TTS_SPEED_DEFAULT}).`,
    usage: '!tts defaultspeed <number|word|reset>',
    permission: 'moderator',
    readCurrent: async (context) => {
        const config = await getTtsState(context.channel.substring(1));
        return config.speed ?? TTS_SPEED_DEFAULT;
    },
    resetSetting: async (context) => resetChannelDefaultSpeed(context.channel.substring(1)),
    setSetting: async (context, val) => setChannelDefaultSpeed(context.channel.substring(1), val),
    // A step word (slow, very-fast, low, high) or a number. The number is what is stored.
    multiWord: true,
    parseFn: (str) => stepByWord(SPEED_STEPS, str)?.value ?? parseFloat(str),
    validateFn: (val) => !isNaN(val) && val >= TTS_SPEED_MIN && val <= TTS_SPEED_MAX,
    hintKey: 'cmd.hint.speedSteps',
    hintParams: { min: TTS_SPEED_MIN, max: TTS_SPEED_MAX, list: SPEED_STEPS.map(step => step.key.replace('_', '-')).join(', ') },
    resetValue: TTS_SPEED_DEFAULT,
    logSet: (context, val) => `[${context.channel.substring(1)}] Channel default speed set to ${val}.`,
    logReset: (context) => `[${context.channel.substring(1)}] Channel default speed reset to ${TTS_SPEED_DEFAULT}.`
});
