// src/components/commands/tts/pronounce.js
// View and edit the channel's pronunciation dictionary.
//
// The bot ships a built-in list of Twitch acronyms; this command layers a
// channel's own entries on top. Setting an entry to an empty value via `off`
// switches off a built-in without losing the ability to get it back.
import { enqueueMessage } from '../../../lib/chatSender.js';
import {
    getTtsState,
    setPronunciation,
    removePronunciation,
    clearPronunciations,
} from '../../tts/ttsState.js';
import {
    normalizeMatchKey,
    validateSay,
    buildEffectiveMap,
    getPronunciationRules,
    PRONUNCIATION_LIMITS,
    PRONUNCIATION_DEFAULTS,
} from '../../../lib/textRewrite/pronunciation.js';
import { applyRewrites } from '../../../lib/textRewrite/replaceEngine.js';
import logger from '../../../lib/logger.js';

const USAGE = '!tts pronounce <word> = <how to say it> | list | remove <word> | off <word> | test <text> | defaults';

// Twitch caps a message at 500 characters, so a channel with a long dictionary
// cannot have it listed in chat. Show a slice and point at the dashboard.
const LIST_LIMIT = 10;

export default {
    name: 'pronounce',
    description: 'View or edit how the TTS voice says specific words and acronyms.',
    usage: USAGE,
    permission: 'moderator',
    execute: async (context) => {
        const { channel, user, args, replyToId } = context;
        const channelName = channel.replace('#', '').toLowerCase();
        const { t } = context;
        const reply = msg => enqueueMessage(channel, msg, { replyToId });

        if (args.length === 0) {
            reply(t('cmd.pronounce.usage', { usage: USAGE }));
            return;
        }

        const subAction = args[0].toLowerCase();
        const rest = args.slice(1).join(' ').trim();

        try {
            const ttsConfig = await getTtsState(channelName);
            const channelEntries = ttsConfig.pronunciations || {};

            if (subAction === 'list') {
                const keys = Object.keys(channelEntries).sort();
                if (keys.length === 0) {
                    reply(t('cmd.pronounce.noneCustom', { count: PRONUNCIATION_DEFAULTS.length }));
                    return;
                }
                const shown = keys.slice(0, LIST_LIMIT).map(k => {
                    const v = channelEntries[k];
                    return v === '' ? t('cmd.pronounce.entryOff', { word: k }) : t('cmd.pronounce.entry', { word: k, say: v });
                }).join(', ');
                const more = keys.length > LIST_LIMIT ? t('cmd.pronounce.listMore', { count: keys.length - LIST_LIMIT }) : '';
                reply(t('cmd.pronounce.list', { entries: shown, more }));
                return;
            }

            if (subAction === 'defaults') {
                if (PRONUNCIATION_DEFAULTS.length === 0) {
                    reply(t('cmd.pronounce.noDefaults'));
                    return;
                }
                const names = PRONUNCIATION_DEFAULTS.map(e => e.match).join(', ');
                reply(t('cmd.pronounce.defaults', { count: PRONUNCIATION_DEFAULTS.length, names: names.slice(0, 400) }));
                return;
            }

            if (subAction === 'test') {
                if (!rest) {
                    reply(t('cmd.pronounce.testUsage'));
                    return;
                }
                // Shows the expansion without spending a TTS call on it.
                const rules = getPronunciationRules(ttsConfig);
                const result = rules ? applyRewrites(rest, rules) : rest;
                reply(result === rest ? t('cmd.pronounce.testNoChange', { text: rest }) : t('cmd.pronounce.testResult', { text: result }));
                return;
            }

            if (subAction === 'remove' || subAction === 'rm' || subAction === 'del') {
                const match = normalizeMatchKey(rest);
                if (!match) {
                    reply(t('cmd.pronounce.removeUsage'));
                    return;
                }
                if (!Object.hasOwn(channelEntries, match)) {
                    reply(t('cmd.pronounce.notCustom', { word: match }));
                    return;
                }
                const ok = await removePronunciation(channelName, match);
                if (!ok) {
                    reply(t('cmd.pronounce.removeFailed'));
                    return;
                }
                const builtIn = PRONUNCIATION_DEFAULTS.find(e => e.match === match);
                logger.info({ channel: channelName, match, user: user.username }, 'Pronunciation removed via command');
                reply(builtIn
                    ? t('cmd.pronounce.removedRestored', { word: match, say: builtIn.say })
                    : t('cmd.pronounce.removed', { word: match }));
                return;
            }

            if (subAction === 'off') {
                const match = normalizeMatchKey(rest);
                if (!match) {
                    reply(t('cmd.pronounce.offUsage'));
                    return;
                }
                if (!PRONUNCIATION_DEFAULTS.some(e => e.match === match)) {
                    reply(t('cmd.pronounce.notBuiltIn', { word: match }));
                    return;
                }
                const ok = await setPronunciation(channelName, match, '');
                reply(ok
                    ? t('cmd.pronounce.switchedOff', { word: match })
                    : t('cmd.pronounce.updateFailed'));
                return;
            }

            if (subAction === 'clear') {
                if (user.username?.toLowerCase() !== channelName) {
                    reply(t('cmd.pronounce.clearDenied'));
                    return;
                }
                const ok = await clearPronunciations(channelName);
                reply(ok ? t('cmd.pronounce.cleared') : t('cmd.pronounce.clearFailed'));
                return;
            }

            // Anything else is an add or update: !tts pronounce <word> = <say>
            const whole = args.join(' ');
            const eqIndex = whole.indexOf('=');
            if (eqIndex === -1) {
                reply(t('cmd.pronounce.usage', { usage: USAGE }));
                return;
            }

            const match = normalizeMatchKey(whole.slice(0, eqIndex));
            if (!match) {
                reply(t('cmd.pronounce.badWord', { max: PRONUNCIATION_LIMITS.MAX_MATCH_LENGTH }));
                return;
            }

            const say = validateSay(whole.slice(eqIndex + 1));
            if (!say.ok) {
                reply(t('cmd.pronounce.badSay', { reason: t(say.reasonKey, say.reasonParams) }));
                return;
            }

            // The cap counts stored entries; updating an existing key is always
            // allowed. hasOwn rather than `in`, which also sees Object.prototype
            // members: "constructor" is a legal match key and would otherwise
            // look like an existing entry and skip the cap check.
            const isNew = !Object.hasOwn(channelEntries, match);
            if (isNew && Object.keys(channelEntries).length >= PRONUNCIATION_LIMITS.MAX_CUSTOM_ENTRIES) {
                reply(t('cmd.pronounce.limitReached', { max: PRONUNCIATION_LIMITS.MAX_CUSTOM_ENTRIES }));
                return;
            }

            const ok = await setPronunciation(channelName, match, say.value);
            if (!ok) {
                reply(t('cmd.pronounce.saveFailed'));
                return;
            }

            logger.info({ channel: channelName, match, say: say.value, user: user.username }, 'Pronunciation set via command');
            // hasOwn, not a bare lookup: "constructor" resolves through
            // Object.prototype and would falsely report a built-in override.
            const overrides = Object.hasOwn(buildEffectiveMap({}), match) && isNew;
            reply(overrides
                ? t('cmd.pronounce.savedOverride', { word: match, say: say.value })
                : t('cmd.pronounce.saved', { word: match, say: say.value }));
        } catch (error) {
            logger.error({ err: error, channel: channelName, args }, 'Error in !tts pronounce');
            reply(t('cmd.pronounce.error'));
        }
    },
};
