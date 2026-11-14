// "!tts defaultstyle <text>": the channel's speaking style, used for every viewer who
// set neither a style nor an emotion. See styleCommand.js.
import { createStyleCommand } from './styleCommand.js';
import { getTtsState, setTtsState } from '../../tts/ttsState.js';

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
    read: async (context) => (await getTtsState(context.channel.substring(1))).style,
    write: (context, style) => setTtsState(context.channel.substring(1), 'style', style),
    clear: (context) => setTtsState(context.channel.substring(1), 'style', ''),
});
