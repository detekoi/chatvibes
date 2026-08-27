/**
 * Message catalogs for everything the bot says or writes.
 *
 * Locale resolution is deliberately **channel-level**: announcements, chat
 * replies and emote descriptions are all heard or seen by the whole channel,
 * so a viewer's personal `languageBoost` override must not change them. That
 * keeps this out of `ttsQueue.enqueue`'s per-message resolution entirely, and
 * leaves the profanity filter that deliberately lives there untouched.
 */

import { createRequire } from 'module';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { formatMessage } from './format.js';
import logger from '../lib/logger.js';

const require = createRequire(import.meta.url);
const MESSAGES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'messages');

const locales = require('./locales.json');
const { DEFAULT_LOCALE, AUTO_VALUES, LANGUAGE_BOOSTS, TWITCH_BROADCASTER_LANGUAGE } = locales;

const AUTO = new Set(AUTO_VALUES);

const LANGUAGE_BOOSTS_BY_BCP47 = new Set(
    Object.values(LANGUAGE_BOOSTS).map(v => v.bcp47)
);

// Catalogs are loaded on first use and kept for the process lifetime. A bot
// instance serves a handful of locales, not all 40, so eager-loading would be
// waste; `null` records a miss so a missing file is not stat'd on every message.
const catalogs = new Map();
const translators = new Map();

function loadCatalog(locale) {
    if (catalogs.has(locale)) return catalogs.get(locale);

    const file = path.join(MESSAGES_DIR, `${locale}.json`);
    let catalog = null;
    if (existsSync(file)) {
        try {
            catalog = require(file);
        } catch (err) {
            logger.error({ err, locale }, 'i18n: catalog failed to parse — falling back');
        }
    }
    catalogs.set(locale, catalog);
    return catalog;
}

/**
 * Lookup order: the locale, its base language (`pt-BR` -> `pt`), then English.
 * A key missing everywhere returns the key itself, which is visible in output
 * and greppable rather than silently empty.
 */
function lookup(key, locale) {
    const chain = [locale];
    const base = locale.split('-')[0];
    if (base !== locale) chain.push(base);
    if (!chain.includes(DEFAULT_LOCALE)) chain.push(DEFAULT_LOCALE);

    for (const tag of chain) {
        const pattern = loadCatalog(tag)?.[key];
        if (typeof pattern === 'string') return pattern;
    }
    return null;
}

/**
 * A bound `t(key, params)` for one locale.
 * @param {string} [locale] BCP-47 tag. Unknown or falsy resolves to English.
 * @returns {(key: string, params?: object) => string}
 */
export function getTranslator(locale = DEFAULT_LOCALE) {
    const tag = typeof locale === 'string' && locale ? locale : DEFAULT_LOCALE;
    let t = translators.get(tag);
    if (t) return t;

    t = (key, params = {}) => {
        const pattern = lookup(key, tag);
        if (pattern === null) {
            logger.warn({ key, locale: tag }, 'i18n: missing message key');
            return key;
        }
        try {
            return formatMessage(pattern, params, tag);
        } catch (err) {
            // A malformed pattern must never take down a chat reply or an
            // announcement. CI validates every catalog, so this is defence in
            // depth for a hand-edited file that skipped it.
            logger.error({ err, key, locale: tag }, 'i18n: message failed to format');
            return key;
        }
    };
    translators.set(tag, t);
    return t;
}

/** True when a languageBoost carries no language (`auto`/`Automatic`/`None`). */
export function isAutoLanguageBoost(languageBoost) {
    return !languageBoost || AUTO.has(String(languageBoost));
}

/**
 * `languageBoost` -> BCP-47. Returns null for `auto` and anything unrecognised,
 * so callers can tell "no language chosen" from "English chosen".
 */
export function localeFromLanguageBoost(languageBoost) {
    if (isAutoLanguageBoost(languageBoost)) return null;
    return LANGUAGE_BOOSTS[String(languageBoost)]?.bcp47 ?? null;
}

/**
 * The locale for everything a channel emits.
 *
 * `announcementLocale` wins when set, so a channel can run an English voice
 * with Spanish announcements or the reverse. Otherwise it derives from
 * `languageBoost` — which is a MiniMax synthesis hint, not a locale, and
 * defaults to `auto`, hence the English fallback.
 *
 * @param {object} channelConfig A config from getTtsState.
 * @returns {string} A BCP-47 tag, never null.
 */
export function resolveChannelLocale(channelConfig) {
    const explicit = channelConfig?.announcementLocale;
    if (explicit && LANGUAGE_BOOSTS_BY_BCP47.has(explicit)) return explicit;
    return localeFromLanguageBoost(channelConfig?.languageBoost) ?? DEFAULT_LOCALE;
}

/** Twitch `broadcaster_language` -> languageBoost, or null when there is no target. */
export function languageBoostFromTwitch(broadcasterLanguage) {
    if (!broadcasterLanguage) return null;
    return TWITCH_BROADCASTER_LANGUAGE[String(broadcasterLanguage).toLowerCase()] ?? null;
}

/** Every supported BCP-47 tag, for the catalog validator and the UI picker. */
export function supportedLocales() {
    return [...LANGUAGE_BOOSTS_BY_BCP47];
}

export { DEFAULT_LOCALE, LANGUAGE_BOOSTS };
export const _internals = { loadCatalog, lookup, catalogs, translators };
