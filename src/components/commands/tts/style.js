// "!tts style <text>": a viewer's own speaking style. See styleCommand.js.
import { createStyleCommand } from './styleCommand.js';
import { getGlobalUserPreferences, updateGlobalUserPreferences } from '../../tts/ttsState.js';
import { styleForEmotion } from '../../tts/styleBuilder.js';

export default createStyleCommand({
    name: 'style',
    description: 'Sets how your TTS voice speaks, in your own words. Use off to remove it.',
    usage: '!tts style <text|off>',
    permission: 'everyone',
    keys: {
        current: 'cmd.style.current',
        currentUnset: 'cmd.style.currentUnset',
        set: 'cmd.style.set',
        reset: 'cmd.style.reset',
        failed: 'cmd.style.failed',
    },
    // An old record can still hold an emotion. It reads as its style words, and each
    // write removes it in the same request, so that it cannot come back into effect.
    read: async (context) => {
        const prefs = await getGlobalUserPreferences(context.user['user-id']);
        return prefs.style || styleForEmotion(prefs.emotion, { viewer: true }) || undefined;
    },
    write: (context, style) => updateGlobalUserPreferences(
        context.user['user-id'], { set: { style }, clear: ['emotion'] }, context.user.username),
    clear: (context) => updateGlobalUserPreferences(context.user['user-id'], { clear: ['style', 'emotion'] }),
});
