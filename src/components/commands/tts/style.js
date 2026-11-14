// "!tts style <text>": a viewer's own speaking style. See styleCommand.js.
import { createStyleCommand } from './styleCommand.js';
import { getGlobalUserPreferences, setGlobalUserPreference, clearGlobalUserPreference } from '../../tts/ttsState.js';

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
    read: async (context) => (await getGlobalUserPreferences(context.user['user-id'])).style,
    write: (context, style) => setGlobalUserPreference(context.user['user-id'], 'style', style, context.user.username),
    clear: (context) => clearGlobalUserPreference(context.user['user-id'], 'style'),
});
