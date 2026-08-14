// src/lib/profanity/index.js
// Per-language profanity substitution for TTS output.
//
// The word lists are authored and committed rather than generated at runtime.
// languageBoost has a closed set of 40 values, so there is nothing to discover
// at request time: a lookup is enough, and it means no API dependency, no cold
// start, and lists that get reviewed in a diff like any other code.
//
// Substitution rather than bleeping or deletion, because an empty replacement
// can reduce a message to "" and every caller treats empty text as nothing to
// say and drops it silently. A filter that disappears messages is worse than
// no filter.

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { compileRules, compileMerged } from '../textRewrite/replaceEngine.js';
import logger from '../logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {Record<string, {confidence: string, entries: Array<{term: string, replacement: string}>}>} */
const LISTS = JSON.parse(readFileSync(join(__dirname, 'profanityLists.json'), 'utf8'));

// languageBoost "auto" is the default, and we cannot detect a language per
// message, so it falls back to English. Surfaced in the dashboard copy and in
// `!tts profanity status` so it does not read as the feature being broken.
const DEFAULT_LANGUAGE = 'English';

// Compiled rule sets, keyed by the sorted language combination.
const rulesCache = new Map();

/**
 * Resolve a languageBoost value to a list key.
 * @param {string} languageBoost
 * @returns {string|null} Null when there is no list for it.
 */
function resolveLanguage(languageBoost) {
    if (!languageBoost) return DEFAULT_LANGUAGE;
    const value = String(languageBoost);
    if (value === 'auto' || value === 'Automatic' || value === 'None') return DEFAULT_LANGUAGE;
    return LISTS[value] ? value : null;
}

/** Entry array to a plain {term: replacement} map, skipping empty replacements. */
function toMap(entries) {
    const out = {};
    for (const { term, replacement } of entries || []) {
        if (term && replacement) out[term] = replacement;
    }
    return out;
}

/**
 * Compiled profanity rules for one or more languages.
 *
 * Several languages are accepted because a viewer can override languageBoost
 * for their own messages. When the viewer's language differs from the
 * channel's, both lists apply: filtering only on the channel's language would
 * let a viewer speaking another one straight through.
 *
 * @param {string|string[]} languageBoosts
 * @returns {{re: RegExp, map: Map<string, string>, size: number} | null}
 */
export function getProfanityRules(languageBoosts) {
    const requested = Array.isArray(languageBoosts) ? languageBoosts : [languageBoosts];

    const languages = [...new Set(
        requested.map(resolveLanguage).filter(Boolean)
    )].sort();

    if (languages.length === 0) return null;

    const cacheKey = languages.join('|');
    if (rulesCache.has(cacheKey)) return rulesCache.get(cacheKey);

    const maps = languages.map(lang => toMap(LISTS[lang].entries));
    const rules = maps.length === 1 ? compileRules(maps[0]) : compileMerged(...maps);

    logger.debug({ languages, size: rules?.size ?? 0 }, 'Compiled profanity rules');
    rulesCache.set(cacheKey, rules);
    return rules;
}

/**
 * Coverage detail for `!tts profanity status`.
 * @param {string} languageBoost
 * @returns {{language: string, confidence: string, entries: number, isFallback: boolean}}
 */
export function getProfanityListInfo(languageBoost) {
    const language = resolveLanguage(languageBoost);
    if (!language) {
        return { language: String(languageBoost), confidence: 'none', entries: 0, isFallback: false };
    }
    const list = LISTS[language];
    return {
        language,
        confidence: list.confidence,
        entries: list.entries.length,
        // True when the channel is on "auto" and is therefore getting English.
        isFallback: language === DEFAULT_LANGUAGE && resolveLanguage(languageBoost) !== languageBoost,
    };
}

/** Language keys that have a list. Used by the list-integrity test. */
export function getSupportedLanguages() {
    // The file carries a leading _README block explaining the authoring rules.
    return Object.keys(LISTS).filter(key => !key.startsWith('_'));
}

export { LISTS as _LISTS };
