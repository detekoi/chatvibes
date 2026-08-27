import { createRequire } from 'module';
import emojiRegex from 'emoji-regex';
import { getTranslator, DEFAULT_LOCALE } from '../i18n/index.js';
import logger from './logger.js';

const require = createRequire(import.meta.url);

// emojibase-data ships 26 locales, which covers 22 of the bot's 40 languages.
// The rest fall back to English labels: honest degradation rather than a crash,
// but it does mean a Turkish or Arabic channel hears English emoji names.
const AVAILABLE_LOCALES = new Set([
    'bn', 'da', 'de', 'en', 'en-gb', 'es', 'es-mx', 'et', 'fi', 'fr', 'hi', 'hu',
    'it', 'ja', 'ko', 'lt', 'ms', 'nb', 'nl', 'pl', 'pt', 'ru', 'sv', 'th', 'uk',
    'vi', 'zh', 'zh-hant',
]);

// Each locale's data.json is ~760 KB, so loading all of them up front would cost
// ~16 MB for languages a given instance may never serve. Built on first use and
// kept for the process lifetime; an instance touches a handful in practice.
const labelMaps = new Map();

function resolveDataLocale(locale) {
    const tag = String(locale || DEFAULT_LOCALE);
    if (AVAILABLE_LOCALES.has(tag)) return tag;
    const base = tag.split('-')[0];
    if (AVAILABLE_LOCALES.has(base)) return base;
    return DEFAULT_LOCALE;
}

/**
 * Emoji → label map for a locale, including skin-tone variants (nested under
 * each base emoji's `skins` array) so mixed-tone ZWJ sequences like 👩🏻‍🤝‍👩🏿
 * are covered directly.
 */
function getLabelMap(locale) {
    const dataLocale = resolveDataLocale(locale);
    let map = labelMaps.get(dataLocale);
    if (map) return map;

    map = new Map();
    try {
        // emojibase-data covers Emoji 17 / Unicode 17 / CLDR 48 (updated Nov 2025).
        const data = require(`emojibase-data/${dataLocale}/data.json`);
        for (const e of data) {
            map.set(e.emoji, e.label);
            if (e.skins) {
                for (const skin of e.skins) map.set(skin.emoji, skin.label);
            }
        }
    } catch (err) {
        logger.error({ err, locale, dataLocale }, 'emojiUtils: emoji label data failed to load');
    }
    labelMaps.set(dataLocale, map);
    return map;
}

const listFormatters = new Map();
function joinTones(tones, locale) {
    if (tones.length < 2) return tones[0] ?? '';
    let formatter = listFormatters.get(locale);
    if (!formatter) {
        try {
            formatter = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' });
        } catch {
            formatter = new Intl.ListFormat(DEFAULT_LOCALE, { style: 'long', type: 'conjunction' });
        }
        listFormatters.set(locale, formatter);
    }
    return formatter.format(tones);
}

// Skin tone modifiers. Detecting a tone by codepoint rather than by the label
// text is what makes this work in every locale: the label separator ": " is a
// CLDR convention and holds everywhere, but the words after it are translated
// ("tono de piel", "薄い肌色", "тон кожи"), so the previous
// `modifier.includes('skin tone')` test silently failed outside English and the
// raw colon form was spoken.
const SKIN_TONE = /[\u{1F3FB}-\u{1F3FF}]/u;

/**
 * Reformat a label like "waving hand: medium skin tone" into natural spoken
 * form: "medium skin tone waving hand".
 *
 * Only reordered when the emoji actually carries a tone modifier. Testing the
 * colon alone would be wrong: "family: man, woman, boy" is a colon label that is
 * not a tone, and reordering it mangles the description.
 */
function formatLabel(label, emoji, locale) {
    const colonIdx = label.indexOf(': ');
    if (colonIdx === -1) return label;
    if (!SKIN_TONE.test(emoji)) return label;

    const base = label.slice(0, colonIdx);
    const modifier = label.slice(colonIdx + 2);
    return `${joinTones(modifier.split(', '), locale)} ${base}`;
}

/**
 * Replaces unicode emojis in a string with parenthetical text descriptions.
 * For example: "Hello 🔥" becomes "Hello (fire emoji)".
 *
 * @param {string} text - The input text containing emojis
 * @param {string} [locale] - BCP-47 tag for the labels and the wrapper wording.
 * @returns {string} - The text with emojis replaced by descriptions
 */
export function replaceEmojisWithText(text, locale = DEFAULT_LOCALE) {
    if (!text || typeof text !== 'string') return text;

    const regex = emojiRegex();

    // Collect all emoji matches with their positions
    const matches = [];
    let m;
    while ((m = regex.exec(text)) !== null) {
        matches.push({ emoji: m[0], index: m.index, length: m[0].length });
    }

    if (matches.length === 0) return text;

    const emojiToLabel = getLabelMap(locale);
    const t = getTranslator(locale);

    // Build output by walking through the text, collapsing consecutive identical emojis
    let result = '';
    let textCursor = 0;
    let i = 0;

    while (i < matches.length) {
        const match = matches[i];

        // Append any text before this emoji
        result += text.slice(textCursor, match.index);

        // Count consecutive runs of the same emoji (adjacent, no non-whitespace between them)
        let count = 1;
        let lookahead = i + 1;
        let endPos = match.index + match.length;
        while (lookahead < matches.length) {
            const gap = text.slice(endPos, matches[lookahead].index);
            // Allow only whitespace (or nothing) between consecutive identical emojis
            if (gap.trim() === '' && matches[lookahead].emoji === match.emoji) {
                count++;
                endPos = matches[lookahead].index + matches[lookahead].length;
                lookahead++;
            } else {
                break;
            }
        }

        // Try exact match first, then strip skin tone modifiers (U+1F3FB–U+1F3FF)
        // to fall back to the base ZWJ sequence (preserving variation selectors so
        // sequences like 🙅‍♂️ still match their emojibase keys), then as a last
        // resort also strip variation selectors (U+FE0F).
        const skinStripped = match.emoji.replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '');
        const label = emojiToLabel.get(match.emoji)
            || emojiToLabel.get(skinStripped)
            || emojiToLabel.get(skinStripped.replace(/\u{FE0F}/gu, ''));
        if (label) {
            const description = formatLabel(label, match.emoji, locale);
            const pad = result.length > 0 && !result.endsWith(' ') ? ' ' : '';
            result += pad + t('emoji.wrap', { count, description });
        } else {
            // No mapping — keep original emoji(s)
            result += text.slice(match.index, endPos);
        }

        textCursor = endPos;
        i = lookahead;
    }

    // Append any remaining text after the last emoji
    result += text.slice(textCursor);

    return result;
}

/**
 * Strips all unicode emojis from a string, collapsing leftover whitespace.
 * Used when emoteMode is 'skip' so emoji aren't read aloud at all.
 *
 * @param {string} text - The input text potentially containing emojis
 * @returns {string} - The text with all emojis removed
 */
export function stripEmojis(text) {
    if (!text || typeof text !== 'string') return text;
    const regex = emojiRegex();
    return text.replace(regex, '').replace(/\s{2,}/g, ' ').trim();
}

export const _internals = { formatLabel, resolveDataLocale, labelMaps };
