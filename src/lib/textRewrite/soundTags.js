// src/lib/textRewrite/soundTags.js
// Gemini TTS turns a tag such as <laugh> or <scream> into the real sound, and it acts
// on the older (laughs) spelling too. Viewers can type these. A channel can turn
// single tags off (`disabledSoundTags`), and this module removes them from the text
// before synthesis.

import { createRequire } from 'module';
import { URL_REGEX } from '../urlProcessor.js';
import { escapeLiteral } from './replaceEngine.js';

const require = createRequire(import.meta.url);
const { SOUND_TAGS } = require('../../components/tts/tts-config.json');

/** Canonical tag names, in the order of tts-config.json. */
export const SOUND_TAG_NAMES = SOUND_TAGS.map(entry => entry.tag);

const SPELLINGS = new Map(SOUND_TAGS.map(entry => [entry.tag, [entry.tag, ...entry.variants]]));
// Every spelling a moderator can type, pointing at the canonical name.
const CANONICAL = new Map(SOUND_TAGS.flatMap(entry => [entry.tag, ...entry.variants].map(word => [word, entry.tag])));

/** The canonical name of a tag as a person typed it (`<Laughs>`, `laughter`), or null. */
export function canonicalSoundTag(word) {
    // A space, a hyphen and an underscore are the same thing to a person who types a tag.
    const cleaned = String(word ?? '').toLowerCase().replace(/[<>()]/g, ' ').replace(/[\s_-]+/g, ' ').trim();
    return CANONICAL.get(cleaned) ?? CANONICAL.get(cleaned.replace(/ /g, '-')) ?? null;
}

const compiled = new Map();

function patternFor(disabledTags) {
    const names = [...new Set(disabledTags)].filter(name => SPELLINGS.has(name)).sort();
    if (names.length === 0) return null;
    const key = names.join('|');
    if (!compiled.has(key)) {
        const words = names.flatMap(name => SPELLINGS.get(name))
            // A space or a hyphen inside a tag matches either, so <short-pause> is caught too.
            .map(word => escapeLiteral(word).replace(/(?:\\ |\\-| |-)/g, '[\\s-]+'))
            .sort((a, b) => b.length - a.length);
        const inner = `\\s*(?:${words.join('|')})\\s*`;
        compiled.set(key, new RegExp(`<${inner}>|\\(${inner}\\)`, 'giu'));
    }
    return compiled.get(key);
}

/**
 * Remove the sound tags that a channel turned off. Text inside a URL is left alone.
 * @param {string} text
 * @param {unknown} disabledTags Canonical tag names, usually `ttsConfig.disabledSoundTags`
 * @param {{trim?: boolean}} [options] `trim: false` keeps a space at the start and
 *     the end. The card needs it: its text sits next to emotes.
 * @returns {string}
 */
export function stripDisabledSoundTags(text, disabledTags, { trim = true } = {}) {
    if (typeof text !== 'string' || !Array.isArray(disabledTags) || disabledTags.length === 0) return text;
    const pattern = patternFor(disabledTags);
    if (!pattern) return text;

    const clean = part => part.replace(pattern, ' ');
    const urlPattern = new RegExp(URL_REGEX.source, URL_REGEX.flags.includes('g') ? URL_REGEX.flags : `${URL_REGEX.flags}g`);
    let out = '';
    let last = 0;
    for (const match of text.matchAll(urlPattern)) {
        out += clean(text.slice(last, match.index)) + match[0];
        last = match.index + match[0].length;
    }
    out += clean(text.slice(last));
    if (out === text) return text;
    const collapsed = out.replace(/[ \t]{2,}/g, ' ');
    return trim ? collapsed.trim() : collapsed;
}
