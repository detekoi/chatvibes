import { enqueueMessage } from '../../../lib/chatSender.js';
import logger from '../../../lib/logger.js';

/**
 * Builds one of the "read / set / reset a setting" TTS subcommands.
 *
 * Callers describe their messages as catalog keys and parameters rather than as
 * callbacks returning finished English. The two shapes almost all of them need —
 * "your own preference" and "the channel default" — are shared messages taking
 * the property name as a parameter, so eight commands need two messages between
 * them rather than eight near-duplicate pairs.
 *
 * `usage` stays a plain string and is passed through as an opaque parameter. It
 * is the command's syntax line, containing the literal chat command a viewer has
 * to type, and a translator rewriting `!tts language` would break it.
 *
 * @param {object} options
 * @param {'user'|'channel'} options.scope Which shared message family to use.
 * @param {string} options.propertyKey Catalog key for the property's name.
 * @param {string} [options.hintKey] Catalog key for the validation hint.
 * @param {object} [options.hintParams] Parameters for the hint message.
 * @param {string|Function} [options.currentKey] Overrides the shared "current value"
 *     message. A function receives the current value and returns a key, for commands
 *     whose unset case is a different sentence.
 * @param {string} [options.setKey] Overrides the shared "value set" message.
 * @param {string} [options.resetKey] Overrides the shared "value reset" message.
 * @param {object} [options.messageParams] Extra parameters for this command's messages.
 * @param {Function} [options.resetValue] Value shown by the reset message, if it names one.
 */
export function createTtsSettingCommand({
    name,
    scope = 'user',
    propertyKey,
    description,
    usage,
    permission = 'everyone',
    readCurrent,
    resetSetting,
    setSetting,
    parseFn = (str) => str,
    validateFn,
    transformFn = (val) => val,
    hintKey,
    hintParams = {},
    currentKey,
    setKey,
    resetKey,
    messageParams = {},
    resetValue,
    showChannelDefaultWhenUnset = false,
    logSet,
    logReset,
    resetAliases = ['reset']
}) {
    const computedResetAliases = resetAliases.map(a => a.toLowerCase());
    // Spelled out rather than built by concatenation so the keys are greppable —
    // a test asserts every catalog key is referenced somewhere in the source, and
    // a key assembled at runtime is invisible to it.
    const SHARED = {
        user: {
            current: 'cmd.setting.user.current',
            set: 'cmd.setting.user.set',
            reset: 'cmd.setting.user.reset',
        },
        channel: {
            current: 'cmd.setting.channel.current',
            set: 'cmd.setting.channel.set',
            reset: 'cmd.setting.channel.reset',
        },
    };
    const shared = SHARED[scope];

    return {
        name,
        description,
        usage,
        permission,
        execute: async (context) => {
            // t is bound to the channel's language by commandProcessor, which
            // already read the config to decide whether the bot may reply at all.
            const { channel, args, replyToId, t } = context;
            const property = t(propertyKey);
            const params = { property, usage, ...messageParams };

            if (args.length === 0) {
                const currentVal = await readCurrent(context);
                const value = currentVal ?? (showChannelDefaultWhenUnset ? t('cmd.value.channelDefault') : currentVal);
                // A function key lets a command pick a different sentence for the
                // unset case, where "you have not set one" is a different
                // statement rather than the same one with a blank in it.
                const key = typeof currentKey === 'function' ? currentKey(currentVal) : currentKey;
                enqueueMessage(channel, t(key ?? shared.current, { ...params, value }), { replyToId });
                return;
            }

            const actionOrValue = args[0].toLowerCase();

            if (computedResetAliases.includes(actionOrValue)) {
                const success = await resetSetting(context);
                if (success) {
                    enqueueMessage(channel, t(resetKey ?? shared.reset, { ...params, value: resetValue }), { replyToId });
                    if (logReset) {
                        logger.info(logReset(context));
                    }
                } else {
                    enqueueMessage(channel, t('cmd.setting.resetFailed', params), { replyToId });
                }
                return;
            }

            const parsed = parseFn(actionOrValue);
            if (!validateFn(parsed)) {
                enqueueMessage(channel, t('cmd.setting.invalid', { ...params, hint: hintKey ? t(hintKey, hintParams) : '' }), { replyToId });
                return;
            }

            const transformed = transformFn(parsed);
            const success = await setSetting(context, transformed);

            if (success) {
                enqueueMessage(channel, t(setKey ?? shared.set, { ...params, value: transformed }), { replyToId });
                if (logSet) {
                    logger.info(logSet(context, transformed));
                }
            } else {
                enqueueMessage(channel, t('cmd.setting.setFailed', { ...params, value: transformed }), { replyToId });
            }
        }
    };
}
