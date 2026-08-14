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
        const reply = msg => enqueueMessage(channel, msg, { replyToId });

        if (args.length === 0) {
            reply(`Usage: ${USAGE}`);
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
                    reply(`No custom pronunciations. ${PRONUNCIATION_DEFAULTS.length} built-in entries are active. Add one with: !tts pronounce <word> = <how to say it>`);
                    return;
                }
                const shown = keys.slice(0, LIST_LIMIT).map(k => {
                    const v = channelEntries[k];
                    return v === '' ? `${k} (off)` : `${k} -> ${v}`;
                }).join(', ');
                const more = keys.length > LIST_LIMIT ? ` ...and ${keys.length - LIST_LIMIT} more (see the dashboard)` : '';
                reply(`Custom pronunciations: ${shown}${more}`);
                return;
            }

            if (subAction === 'defaults') {
                if (PRONUNCIATION_DEFAULTS.length === 0) {
                    reply('No built-in pronunciations are configured.');
                    return;
                }
                const names = PRONUNCIATION_DEFAULTS.map(e => e.match).join(', ');
                reply(`Built-in (${PRONUNCIATION_DEFAULTS.length}): ${names.slice(0, 400)}`);
                return;
            }

            if (subAction === 'test') {
                if (!rest) {
                    reply('Usage: !tts pronounce test <text>');
                    return;
                }
                // Shows the expansion without spending a TTS call on it.
                const rules = getPronunciationRules(ttsConfig);
                const result = rules ? applyRewrites(rest, rules) : rest;
                reply(result === rest ? `No change: "${rest}"` : `Would say: "${result}"`);
                return;
            }

            if (subAction === 'remove' || subAction === 'rm' || subAction === 'del') {
                const match = normalizeMatchKey(rest);
                if (!match) {
                    reply('Usage: !tts pronounce remove <word>');
                    return;
                }
                if (!Object.hasOwn(channelEntries, match)) {
                    reply(`"${match}" is not a custom pronunciation for this channel.`);
                    return;
                }
                const ok = await removePronunciation(channelName, match);
                if (!ok) {
                    reply('Could not remove that pronunciation. Try again shortly.');
                    return;
                }
                const builtIn = PRONUNCIATION_DEFAULTS.find(e => e.match === match);
                logger.info({ channel: channelName, match, user: user.username }, 'Pronunciation removed via command');
                reply(builtIn
                    ? `Removed "${match}". The built-in is back: "${builtIn.say}".`
                    : `Removed "${match}".`);
                return;
            }

            if (subAction === 'off') {
                const match = normalizeMatchKey(rest);
                if (!match) {
                    reply('Usage: !tts pronounce off <word>');
                    return;
                }
                if (!PRONUNCIATION_DEFAULTS.some(e => e.match === match)) {
                    reply(`"${match}" is not a built-in. Use "!tts pronounce remove ${match}" for a custom entry.`);
                    return;
                }
                const ok = await setPronunciation(channelName, match, '');
                reply(ok
                    ? `Built-in "${match}" switched off. Restore it with: !tts pronounce remove ${match}`
                    : 'Could not update that pronunciation. Try again shortly.');
                return;
            }

            if (subAction === 'clear') {
                if (user.username?.toLowerCase() !== channelName) {
                    reply('Only the broadcaster can clear the whole dictionary.');
                    return;
                }
                const ok = await clearPronunciations(channelName);
                reply(ok ? 'All custom pronunciations cleared. Built-ins are still active.' : 'Could not clear the dictionary.');
                return;
            }

            // Anything else is an add or update: !tts pronounce <word> = <say>
            const whole = args.join(' ');
            const eqIndex = whole.indexOf('=');
            if (eqIndex === -1) {
                reply(`Usage: ${USAGE}`);
                return;
            }

            const match = normalizeMatchKey(whole.slice(0, eqIndex));
            if (!match) {
                reply('That word cannot be used. Use letters, digits, apostrophes or hyphens, up to ' +
                    `${PRONUNCIATION_LIMITS.MAX_MATCH_LENGTH} characters, and no dots.`);
                return;
            }

            const say = validateSay(whole.slice(eqIndex + 1));
            if (!say.ok) {
                reply(`The spoken form ${say.reason}.`);
                return;
            }

            // The cap counts stored entries; updating an existing key is always
            // allowed. hasOwn rather than `in`, which also sees Object.prototype
            // members: "constructor" is a legal match key and would otherwise
            // look like an existing entry and skip the cap check.
            const isNew = !Object.hasOwn(channelEntries, match);
            if (isNew && Object.keys(channelEntries).length >= PRONUNCIATION_LIMITS.MAX_CUSTOM_ENTRIES) {
                reply(`This channel already has ${PRONUNCIATION_LIMITS.MAX_CUSTOM_ENTRIES} custom pronunciations. Remove one first.`);
                return;
            }

            const ok = await setPronunciation(channelName, match, say.value);
            if (!ok) {
                reply('Could not save that pronunciation. Try again shortly.');
                return;
            }

            logger.info({ channel: channelName, match, say: say.value, user: user.username }, 'Pronunciation set via command');
            // hasOwn, not a bare lookup: "constructor" resolves through
            // Object.prototype and would falsely report a built-in override.
            const overrides = Object.hasOwn(buildEffectiveMap({}), match) && isNew;
            reply(overrides
                ? `"${match}" will now be said as "${say.value}" (overriding the built-in).`
                : `"${match}" will now be said as "${say.value}".`);
        } catch (error) {
            logger.error({ err: error, channel: channelName, args }, 'Error in !tts pronounce');
            reply('Something went wrong handling that pronunciation command.');
        }
    },
};
