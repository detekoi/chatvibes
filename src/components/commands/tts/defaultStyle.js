// "!tts defaultstyle <text>": the channel's speaking style, used for every viewer who
// set no style. See styleCommand.js.
import { createStyleCommand } from './styleCommand.js';
import { getTtsState, setTtsStateFields } from '../../tts/ttsState.js';
import { styleForEmotion } from '../../tts/styleBuilder.js';

export default createStyleCommand({
    name: 'defaultstyle',
    description: 'Sets how the channel\'s TTS voices speak, in your own words. Use off to remove it.',
    usage: '!tts defaultstyle <text|off>',
    permission: 'moderator',
    keys: {
        current: 'cmd.defaultStyle.current',
        currentUnset: 'cmd.defaultStyle.currentUnset',
        set: 'cmd.defaultStyle.set',
        reset: 'cmd.defaultStyle.reset',
        failed: 'cmd.defaultStyle.failed',
    },
    // An old record can still hold an emotion. It reads as its style words, and each
    // write sets it back to neutral in the same request.
    read: async (context) => {
        const config = await getTtsState(context.channel.substring(1));
        return config.style || styleForEmotion(config.emotion) || undefined;
    },
    write: (context, style) => setTtsStateFields(context.channel.substring(1), { style, emotion: 'neutral' }),
    clear: (context) => setTtsStateFields(context.channel.substring(1), { style: '', emotion: 'neutral' }),
});
