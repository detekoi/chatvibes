// src/components/commands/tts/styleCommand.js
// Builds "!tts style" (a viewer's own style) and "!tts defaultstyle" (the channel's).
//
// The style is free text that tells the voice how to speak: "whispering", "like a
// pirate", "bored and slow". It is an instruction to the speech model and is never
// spoken, and the model reads the message word for word whatever the style says. It
// replaces the emotion preset, which is why setting an emotion clears it.
import { enqueueMessage } from '../../../lib/chatSender.js';
import logger from '../../../lib/logger.js';
import { getTtsState } from '../../tts/ttsState.js';
import { sanitizeStyle, STYLE_MAX_LENGTH } from '../../tts/styleBuilder.js';
import { containsBannedWord } from '../../../lib/bannedWords.js';

const CLEAR_WORDS = new Set(['off', 'reset', 'none', 'clear']);

/**
 * @param {object} options
 * @param {string} options.name
 * @param {string} options.usage Shown untranslated: it is the literal command to type
 * @param {'everyone'|'moderator'} options.permission
 * @param {{current: string, currentUnset: string, set: string, reset: string, failed: string}} options.keys Catalog keys
 * @param {(context: object) => Promise<string|undefined>} options.read
 * @param {(context: object, style: string) => Promise<boolean>} options.write
 * @param {(context: object) => Promise<boolean>} options.clear
 */
export function createStyleCommand({ name, description, usage, permission, keys, read, write, clear }) {
    return {
        name,
        description,
        usage,
        permission,
        execute: async (context) => {
            const { channel, args, replyToId, t, user } = context;
            const channelName = channel.substring(1).toLowerCase();
            const reply = msg => enqueueMessage(channel, msg, { replyToId });

            if (args.length === 0) {
                const current = await read(context);
                reply(current ? t(keys.current, { value: current, usage }) : t(keys.currentUnset, { usage }));
                return;
            }

            if (args.length === 1 && CLEAR_WORDS.has(args[0].toLowerCase())) {
                reply(t(await clear(context) ? keys.reset : keys.failed));
                return;
            }

            const typed = args.join(' ').trim();
            if (typed.length > STYLE_MAX_LENGTH) {
                reply(t('cmd.style.tooLong', { max: STYLE_MAX_LENGTH }));
                return;
            }
            const style = sanitizeStyle(typed);
            if (!style) {
                reply(t(keys.currentUnset, { usage }));
                return;
            }
            const config = await getTtsState(channelName);
            if (containsBannedWord(style, config.bannedWords)) {
                reply(t('cmd.style.blocked'));
                return;
            }

            if (await write(context, style)) {
                logger.info({ channel: channelName, user: user?.username, command: name, style }, 'TTS style set');
                reply(t(keys.set, { value: style }));
            } else {
                reply(t(keys.failed));
            }
        },
    };
}
