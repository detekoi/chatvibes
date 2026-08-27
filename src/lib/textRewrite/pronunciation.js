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
import { resolveChannelLocale, DEFAULT_LOCALE } from '../../i18n/index.js';

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

/**
 * Entries keyed by match, each `{say, only?, except?}`.
 *
 * `only` and `except` are lists of BCP-47 codes scoping where an entry applies;
 * an entry with neither applies everywhere, which is the case for almost all of
 * them. The scoping exists because these are English acronyms matched as whole
 * words, and a few of them *are* whole words in another supported language —
 * "ty" is "you" in Polish, Czech and Slovak, and "af" is "off" in Afrikaans and
 * Dutch. Word-boundary matching cannot help there; that is precisely why they
 * collide.
 *
 * They are scoped with `except` rather than `only: ['en']` on purpose. Twitch
 * acronyms travel across languages — a German channel's chat is still full of
 * "gg" and "brb" — so restricting the defaults to English channels would break
 * the common case. Scope by demonstrated collision, not by origin.
 */
const DEFAULT_ENTRIES = Object.freeze(
    Object.fromEntries(PRONUNCIATION_DEFAULTS.map(e => [
        e.match,
        Object.freeze({ say: e.say, only: e.only, except: e.except }),
    ]))
);

/**
 * A stored value into `{say, only, except}`, or null if unusable.
 *
 * A bare string is the pre-scoping shape and means "applies everywhere". There
 * is no migration: legacy entries stay readable, exactly as with the ignore list.
 */
function normalizeEntry(value) {
    if (typeof value === 'string') return { say: value };
    if (value && typeof value === 'object' && typeof value.say === 'string') {
        return { say: value.say, only: value.only, except: value.except };
    }
    return null;
}

/** Whether a scoped entry fires for this locale. `only` wins over `except`. */
function entryAppliesTo(entry, locale) {
    const tags = [locale, String(locale).split('-')[0]];
    if (Array.isArray(entry.only) && entry.only.length) {
        return entry.only.some(l => tags.includes(l));
    }
    if (Array.isArray(entry.except) && entry.except.length) {
        return !entry.except.some(l => tags.includes(l));
    }
    return true;
}

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
 * Overlay a channel's entries on the built-ins and drop the ones that do not
 * apply to this locale.
 *
 * @param {Record<string, string | {say: string, only?: string[], except?: string[]}>} [channelEntries]
 * @param {string} [locale] BCP-47. Defaults to English, which is what the
 *     pre-scoping behaviour was for every channel.
 * @returns {Record<string, string>} match -> spoken form
 */
export function buildEffectiveMap(channelEntries = {}, locale = DEFAULT_LOCALE) {
    // Null prototype so that a legal match key which happens to name an
    // Object.prototype member ("constructor") cannot resolve through the chain.
    // Callers are then free to use `in` or a bare lookup on the result.
    const merged = Object.assign(Object.create(null), DEFAULT_ENTRIES);

    for (const [key, value] of Object.entries(channelEntries || {})) {
        const entry = normalizeEntry(value);
        // An unusable value must not leave the built-in in place: a channel that
        // wrote a malformed entry meant to change this key, not to keep the
        // default, and silently falling back reads as the write being ignored.
        if (!entry) { delete merged[key]; continue; }
        merged[key] = entry;
    }

    const out = Object.create(null);
    for (const [key, entry] of Object.entries(merged)) {
        if (entry.say === DISABLED) continue;
        if (!entryAppliesTo(entry, locale)) continue;
        out[key] = entry.say;
    }
    return out;
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
//
// Channels with no overrides of their own share a rule set per locale, rather
// than compiling one per config object. This is the common case by a wide
// margin.
//
// Both caches are keyed by locale as well as by source, and that is load-bearing
// rather than tidiness: the entries a channel gets now depend on its language,
// so a cache keyed on the pronunciations object alone would hand every channel
// sharing it whichever language happened to compile first. The profanity module
// already keys its cache on the language combination for the same reason.
let overrideRules = new WeakMap();
let defaultRules = new Map();

/**
 * Compiled rule set for a channel, or null when there is nothing to apply.
 *
 * The locale is derived from the config rather than passed in, so no call site
 * can forget it and silently get English scoping.
 *
 * @param {object} channelConfig A full config from getTtsState.
 * @returns {{re: RegExp, map: Map<string, string>, size: number} | null}
 */
export function getPronunciationRules(channelConfig) {
    if (!channelConfig || channelConfig.pronunciationEnabled === false) return null;

    const locale = resolveChannelLocale(channelConfig);
    const source = channelConfig.pronunciations;

    if (!source || Object.keys(source).length === 0) {
        if (!defaultRules.has(locale)) {
            defaultRules.set(locale, compileRules(buildEffectiveMap({}, locale)));
        }
        return defaultRules.get(locale);
    }

    let byLocale = overrideRules.get(source);
    if (!byLocale) {
        byLocale = new Map();
        overrideRules.set(source, byLocale);
    }
    if (!byLocale.has(locale)) {
        byLocale.set(locale, compileRules(buildEffectiveMap(source, locale)));
    }
    return byLocale.get(locale);
}

/** Exported for tests, which need to defeat the memo between cases. */
export function _resetPronunciationMemo() {
    overrideRules = new WeakMap();
    defaultRules = new Map();
}
