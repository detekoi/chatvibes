// src/lib/textRewrite/pronunciation.js
// Built-in Twitch acronym expansions merged with a channel's custom entries.
//
// The built-in list lives in tts-config.json rather than here because
// `npm run sync-constants` copies that file into the web UI's function bundle,
// which is what keeps the dashboard's validation limits from drifting away
// from the bot's.

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { compileRules } from './replaceEngine.js';
import { URL_REGEX } from '../urlProcessor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ttsConfig = JSON.parse(
    readFileSync(join(__dirname, '../../components/tts/tts-config.json'), 'utf8')
);

export const PRONUNCIATION_LIMITS = ttsConfig.PRONUNCIATION_LIMITS;
export const PRONUNCIATION_DEFAULTS = ttsConfig.PRONUNCIATION_DEFAULTS || [];

/**
 * A channel entry whose value is the empty string switches off the built-in of
 * the same name. Deleting the key instead restores the built-in, so a channel
 * can turn one off without losing the ability to get it back.
 */
export const DISABLED = '';

const DEFAULTS_MAP = Object.freeze(
    Object.fromEntries(PRONUNCIATION_DEFAULTS.map(e => [e.match, e.say]))
);

// Letters and digits to start, then letters, digits, apostrophes, hyphens and
// single spaces. Deliberately excludes "." because Firestore splits field paths
// on it, and a key containing one would silently write to the wrong nesting.
const MATCH_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}'\- ]*$/u;

// C0 and C1 control characters. These reach the TTS API as invalid input and
// come back as error 1042, which the retry loop turns into a Wavespeed
// fallback on every message.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

/**
 * Normalize a user-supplied match key into its canonical stored form.
 * Returns null for anything unusable, so the chat command and the HTTP
 * validator reject on exactly the same rule.
 * @param {string} raw
 * @returns {string | null}
 */
export function normalizeMatchKey(raw) {
    if (typeof raw !== 'string') return null;

    const key = raw
        .replace(CONTROL_CHARS, '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();

    if (!key) return null;
    if (key.length > PRONUNCIATION_LIMITS.MAX_MATCH_LENGTH) return null;
    if (key.startsWith('__')) return null; // Firestore reserves this prefix
    if (key.includes('.')) return null;
    if (!MATCH_PATTERN.test(key)) return null;

    return key;
}

/**
 * Validate and normalize the spoken form.
 * @param {string} raw
 * @returns {{ok: true, value: string} | {ok: false, reason: string}}
 */
export function validateSay(raw) {
    if (typeof raw !== 'string') return { ok: false, reason: 'must be text' };

    const say = raw.replace(CONTROL_CHARS, '').trim().replace(/\s+/g, ' ');

    // An empty spoken form would let a message reduce to "", and every caller
    // treats empty text as nothing to say and drops it. Use the remove or off
    // sub-actions for that instead of smuggling it through as a value.
    if (!say) return { ok: false, reason: 'cannot be empty' };
    if (say.length > PRONUNCIATION_LIMITS.MAX_SAY_LENGTH) {
        return { ok: false, reason: `must be ${PRONUNCIATION_LIMITS.MAX_SAY_LENGTH} characters or fewer` };
    }

    // A URL in the spoken form would be re-expanded by the URL processor on a
    // later pass, or read out character by character. Built without the global
    // flag: a one-shot test has no use for lastIndex, and reusing the shared
    // URL_REGEX export would leave its lastIndex mutated for other callers.
    if (new RegExp(URL_REGEX.source, 'i').test(say)) {
        return { ok: false, reason: 'cannot contain a link' };
    }

    return { ok: true, value: say };
}

/**
 * Overlay a channel's entries on the built-ins.
 * @param {Record<string, string>} [channelEntries]
 * @returns {Record<string, string>}
 */
export function buildEffectiveMap(channelEntries = {}) {
    // Null prototype so that a legal match key which happens to name an
    // Object.prototype member ("constructor") cannot resolve through the chain.
    // Callers are then free to use `in` or a bare lookup on the result.
    const merged = Object.assign(Object.create(null), DEFAULTS_MAP, channelEntries || {});
    for (const key of Object.keys(merged)) {
        if (merged[key] === DISABLED) delete merged[key];
    }
    return merged;
}

// Compiled rules are memoized on the identity of the channel's pronunciations
// object. The Firestore snapshot listener rebuilds the whole config object on
// every write, so a new identity is exactly the signal that the rules are
// stale; keying by channel name instead would serve stale rules forever.
//
// A WeakMap rather than a single slot, because the bot serves many channels at
// once and their messages interleave. A one-entry cache would be invalidated by
// every message from a different channel, recompiling the whole dictionary
// (object merge, longest-first sort, regex build) each time.
let overrideRules = new WeakMap();

// Channels with no overrides of their own all compile to the same rule set, so
// they share one entry instead of one per config object. This is the common
// case by a wide margin.
let defaultRules;
let defaultRulesComputed = false;

/**
 * Compiled rule set for a channel, or null when there is nothing to apply.
 * @param {object} channelConfig A full config from getTtsState.
 * @returns {{re: RegExp, map: Map<string, string>, size: number} | null}
 */
export function getPronunciationRules(channelConfig) {
    if (!channelConfig || channelConfig.pronunciationEnabled === false) return null;

    const source = channelConfig.pronunciations;

    if (!source || Object.keys(source).length === 0) {
        if (!defaultRulesComputed) {
            defaultRules = compileRules(buildEffectiveMap());
            defaultRulesComputed = true;
        }
        return defaultRules;
    }

    const cached = overrideRules.get(source);
    if (cached !== undefined) return cached;

    const rules = compileRules(buildEffectiveMap(source));
    overrideRules.set(source, rules);
    return rules;
}

/** Exported for tests, which need to defeat the memo between cases. */
export function _resetPronunciationMemo() {
    overrideRules = new WeakMap();
    defaultRules = undefined;
    defaultRulesComputed = false;
}
