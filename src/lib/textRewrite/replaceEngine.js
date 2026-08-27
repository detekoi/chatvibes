// src/lib/textRewrite/replaceEngine.js
// Word-boundary text substitution shared by the pronunciation dictionary and
// the profanity filter.
//
// Two properties matter more than anything else here:
//
//   1. Matches are anchored to word boundaries. Chat already reads "lol" as
//      "el oh el" without our help, and the whole feature is worthless if it
//      breaks that or turns "lollipop" into "el oh el-lipop". The anchors use
//      \p{L}\p{N} lookarounds rather than \b, because \b is ASCII-only and
//      would mis-fire on n-tilde, Cyrillic, and Greek, which matters the moment
//      the non-English profanity lists are in play. A change of script counts as
//      a boundary too, so a Latin term matches inside spaceless Japanese text.
//
//   2. Replacement happens in a single pass. Substituted text is never
//      re-scanned, so a rule that expands to a word another rule matches does
//      not cascade: "lfg" -> "lets fucking go" cannot then be re-expanded by
//      some future "go" rule.

import { URL_REGEX } from '../urlProcessor.js';

// Private Use Area code points have no legitimate use in chat and reach the TTS
// API as junk, so they are dropped from incoming text.
const PRIVATE_USE = /[\uE000-\uF8FF]/g;

// Scripts written without spaces between words. A \p{L} lookaround is the
// wrong boundary test for these, because neighbouring characters are letters
// even at a real word edge.
const CONTINUOUS_SCRIPT_CLASS =
    '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Thai}\\p{Script=Lao}\\p{Script=Khmer}\\p{Script=Myanmar}';

const CONTINUOUS_SCRIPT = new RegExp(`[${CONTINUOUS_SCRIPT_CLASS}]`, 'u');

// Boundary assertions for a term written in a spaced script.
//
// The naive form, (?<![\p{L}\p{N}_]), treats every letter as word-internal —
// but Kana and Kanji are letters, so a Latin term sitting directly against
// Japanese text looked word-internal and never matched. Japanese has no spaces,
// so "それkwskで" is how that language actually writes it, and the term would
// have fired only when a viewer happened to add spaces.
//
// These instead reject only a neighbouring letter or digit that is NOT itself
// continuous-script. A change of script is a word boundary in its own right,
// which is what makes "それkwskで" match while "xkwsk" and "kwskx" still do not.
const BOUNDARY_BEFORE = `(?<!(?![${CONTINUOUS_SCRIPT_CLASS}])[\\p{L}\\p{N}_])`;
const BOUNDARY_AFTER = `(?!(?![${CONTINUOUS_SCRIPT_CLASS}])[\\p{L}\\p{N}_])`;

// Word segmentation stands in for the missing boundaries. It is what separates
// "你在操什么" (操 is its own word, filter it) from "操作系统" (操 is the first
// half of "操作", leave it alone). One instance, reused across messages.
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'word' });

/**
 * Offsets at which a word starts or ends. A continuous-script match is only
 * genuine if both its edges land on one.
 * @param {string} text
 * @returns {Set<number>}
 */
function segmentBoundaries(text) {
    const bounds = new Set([0, text.length]);
    for (const { index, segment } of SEGMENTER.segment(text)) {
        bounds.add(index);
        bounds.add(index + segment.length);
    }
    return bounds;
}

/**
 * Escape a literal string for safe use inside a RegExp alternation.
 * Match keys are user-supplied, so an unescaped "." or "(" would either
 * silently widen the match or throw at compile time.
 * @param {string} s
 * @returns {string}
 */
export function escapeLiteral(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a plain {matchKey: replacement} object into a reusable rule set.
 *
 * Keys are sorted longest-first so that overlapping keys resolve to the more
 * specific one: "frfr" wins over "fr", "iykyk" over a hypothetical "yk".
 * Regex alternation is first-match-wins, so sort order is the precedence.
 *
 * @param {Record<string, string>} entries
 * @param {object} [options]
 * @param {boolean} [options.caseSensitive=false]
 * @returns {{re: RegExp, map: Map<string, string>, size: number, caseSensitive: boolean, needsSegmentation: boolean} | null}
 *     Null when there is nothing to match, so callers can skip the pass.
 */
export function compileRules(entries, { caseSensitive = false } = {}) {
    if (!entries) return null;

    const map = new Map();
    for (const [rawKey, rawValue] of Object.entries(entries)) {
        if (typeof rawKey !== 'string' || typeof rawValue !== 'string') continue;
        const key = caseSensitive ? rawKey : rawKey.toLowerCase();
        // An empty replacement would let a message filter down to "", and every
        // caller treats empty text as "nothing to say" and drops the message.
        // Silently dropping is not what a filter is supposed to do.
        if (!key || !rawValue) continue;
        map.set(key, rawValue);
    }

    if (map.size === 0) return null;

    // Lookarounds are applied per alternative rather than around the whole
    // group, because they are wrong for scripts that do not put spaces between
    // words: in "你在操什么" the character before "操" is itself a letter, so a
    // \p{L} lookbehind rejects a match that should have been found. Those terms
    // are matched bare and validated against word segmentation instead.
    let needsSegmentation = false;
    const alternation = [...map.keys()]
        .sort((a, b) => b.length - a.length)
        .map(key => {
            const literal = escapeLiteral(key);
            if (!CONTINUOUS_SCRIPT.test(key)) {
                return `${BOUNDARY_BEFORE}${literal}${BOUNDARY_AFTER}`;
            }
            needsSegmentation = true;
            return literal;
        })
        .join('|');

    const flags = caseSensitive ? 'gu' : 'giu';
    const re = new RegExp(`(?:${alternation})`, flags);

    return { re, map, size: map.size, caseSensitive, needsSegmentation };
}

/**
 * Apply a compiled rule set to text.
 *
 * URL spans are masked out before matching and restored verbatim afterwards,
 * so a dictionary key can never be expanded inside a hostname or path. This
 * only bites when readFullUrls is on (otherwise urlProcessor has already
 * collapsed the URL to "example dot com") but it is cheap insurance.
 *
 * @param {string} text
 * @param {{re: RegExp, map: Map<string, string>, caseSensitive: boolean} | null} rules
 * @returns {string}
 */
export function applyRewrites(text, rules) {
    if (!rules || typeof text !== 'string' || !text) return text;

    const safe = text.replace(PRIVATE_USE, '');

    // A fresh regex each call: URL_REGEX carries the g flag, and a shared
    // instance would leak lastIndex between messages.
    const urlRe = new RegExp(URL_REGEX.source, URL_REGEX.flags);

    // Rules run on the gaps between URLs, and the URLs themselves are copied
    // through untouched.
    //
    // This used to swap each URL for a sentinel-wrapped index and rewrite the
    // whole string in one pass, which put the index in band with the text the
    // rules were matching. A rule whose key was a digit — `!tts pronounce 1 =
    // one` is accepted, since a match key may start with \p{N} — then rewrote
    // the index inside its own placeholder, the restore pass no longer
    // recognised it, and the URL was lost with the sentinels left in the audio.
    // Splitting has no in-band encoding to corrupt.
    let out = '';
    let cursor = 0;
    for (const match of safe.matchAll(urlRe)) {
        out += rewriteSegment(safe.slice(cursor, match.index), rules) + match[0];
        cursor = match.index + match[0].length;
    }
    return out + rewriteSegment(safe.slice(cursor), rules);
}

/**
 * Apply a rule set to one span of non-URL text.
 * @param {string} segment
 * @param {{re: RegExp, map: Map<string, string>, caseSensitive: boolean, needsSegmentation: boolean}} rules
 * @returns {string}
 */
function rewriteSegment(segment, rules) {
    if (!segment) return segment;

    // Computed lazily and at most once per segment: segmentation is only
    // needed if a continuous-script term actually matches, which never happens
    // for an English channel.
    let bounds = null;

    // lastIndex is reset explicitly: the rule set is memoized and reused across
    // messages, and a stale lastIndex would skip the start of a string.
    rules.re.lastIndex = 0;
    return segment.replace(rules.re, (match, offset) => {
        // Terms in a spaced script carry their own lookarounds in the pattern
        // and are already correctly bounded, so they skip this entirely.
        if (rules.needsSegmentation && CONTINUOUS_SCRIPT.test(match)) {
            bounds ??= segmentBoundaries(segment);
            if (!bounds.has(offset) || !bounds.has(offset + match.length)) {
                return match;
            }
        }
        const key = rules.caseSensitive ? match : match.toLowerCase();
        return rules.map.get(key) ?? match;
    });
}

/**
 * Merge several rule sources into one compiled set. Later sources win on key
 * collisions. Used to overlay a channel's custom entries onto the built-ins,
 * and to union two profanity languages when a viewer's language differs from
 * the channel's.
 * @param {...Record<string, string>} sources
 * @returns {{re: RegExp, map: Map<string, string>, size: number, caseSensitive: boolean} | null}
 */
export function compileMerged(...sources) {
    const merged = Object.assign({}, ...sources.filter(Boolean));
    return compileRules(merged);
}
