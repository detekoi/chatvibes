import { createTtsSettingCommand } from './createTtsSettingCommand.js';
import {
    setChannelDefaultEmotion,
    resetChannelDefaultEmotion,
    getTtsState,
    setTtsState
} from '../../tts/ttsState.js';
import {
    VALID_EMOTIONS,
    DEFAULT_TTS_SETTINGS
} from '../../tts/ttsConstants.js';

export default createTtsSettingCommand({
    name: 'defaultemotion',
    scope: 'channel',
    propertyKey: 'cmd.property.emotion',
    description: `Sets the channel's default TTS emotion. Valid: ${VALID_EMOTIONS.join(', ')}. Use 'reset' for system default.`,
    usage: '!tts defaultemotion <emotion|reset>',
    permission: 'moderator',
    readCurrent: async (context) => {
        const config = await getTtsState(context.channel.substring(1));
        return config.emotion ?? DEFAULT_TTS_SETTINGS.emotion;
    },
    resetSetting: async (context) => resetChannelDefaultEmotion(context.channel.substring(1)),
    // A custom style replaces the emotion preset, so choosing an emotion removes the style.
    setSetting: async (context, val) => {
        const saved = await setChannelDefaultEmotion(context.channel.substring(1), val);
        if (saved) await setTtsState(context.channel.substring(1), 'style', '');
        return saved;
    },
    validateFn: (val) => VALID_EMOTIONS.includes(val),
    hintKey: 'cmd.hint.emotionsDefault',
    hintParams: { list: VALID_EMOTIONS.join(', ') },
    resetValue: DEFAULT_TTS_SETTINGS.emotion,
    logSet: (context, val) => `[${context.channel.substring(1)}] Channel default emotion set to ${val}.`,
    logReset: (context) => `[${context.channel.substring(1)}] Channel default emotion reset to ${DEFAULT_TTS_SETTINGS.emotion}.`
});
