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
//      the non-English profanity lists are in play.
//
//   2. Replacement happens in a single pass. Substituted text is never
//      re-scanned, so a rule that expands to a word another rule matches does
//      not cascade: "lfg" -> "lets fucking go" cannot then be re-expanded by
//      some future "go" rule.

import { URL_REGEX } from '../urlProcessor.js';

// Private Use Area sentinels. A URL is swapped for MASK_OPEN + index +
// MASK_CLOSE while the rules run. Digits alone would be ambiguous: a message
// like "I have 3 cats https://x.com" would see the restore pass match the
// literal "3" and splice a URL into the wrong place. These code points cannot
// appear in Twitch chat, and they are neither \p{L} nor \p{N}, so they read as
// word boundaries to the matcher.
const MASK_OPEN = '\uE000';
const MASK_CLOSE = '\uE001';

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
 * @returns {{re: RegExp, map: Map<string, string>, size: number, caseSensitive: boolean} | null}
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

    const alternation = [...map.keys()]
        .sort((a, b) => b.length - a.length)
        .map(escapeLiteral)
        .join('|');

    const flags = caseSensitive ? 'gu' : 'giu';
    const re = new RegExp(
        `(?<![\\p{L}\\p{N}_])(?:${alternation})(?![\\p{L}\\p{N}_])`,
        flags
    );

    return { re, map, size: map.size, caseSensitive };
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

    const urls = [];
    // A fresh regex each call: URL_REGEX carries the g flag, and a shared
    // instance would leak lastIndex between messages.
    const urlRe = new RegExp(URL_REGEX.source, URL_REGEX.flags);
    const masked = text.replace(urlRe, match => {
        urls.push(match);
        return `${MASK_OPEN}${urls.length - 1}${MASK_CLOSE}`;
    });

    // lastIndex is reset explicitly: the rule set is memoized and reused across
    // messages, and a stale lastIndex would skip the start of a string.
    rules.re.lastIndex = 0;
    const rewritten = masked.replace(rules.re, match => {
        const key = rules.caseSensitive ? match : match.toLowerCase();
        return rules.map.get(key) ?? match;
    });

    if (!urls.length) return rewritten;

    const restoreRe = new RegExp(`${MASK_OPEN}(\\d+)${MASK_CLOSE}`, 'g');
    return rewritten.replace(restoreRe, (whole, i) => urls[Number(i)] ?? whole);
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
