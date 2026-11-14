// src/components/tts/voiceResolver.js
// The voice catalog, and the bridge from a stored MiniMax voice ID to a Gemini voice.
//
// gemini-voices.json comes from scripts/sync-gemini-voices.js. minimax-to-gemini-voices.json
// is the reviewed mapping of the 475 MiniMax voices. A document that still holds a MiniMax
// ID (before the backfill, or in a persisted queue item) resolves through the map here.

import { createRequire } from 'module';
import config from '../../config/index.js';
import logger from '../../lib/logger.js';

const require = createRequire(import.meta.url);
const { voices: CATALOG } = require('./gemini-voices.json');

let LEGACY_MAP = {};
try {
    LEGACY_MAP = require('./minimax-to-gemini-voices.json');
} catch {
    logger.warn('minimax-to-gemini-voices.json is missing. Stored MiniMax voice IDs will use the default voice.');
}

const BY_ID = new Map(CATALOG.map(voice => [voice.id.toLowerCase(), voice]));
// The map's keys as people may have stored them: exact first, then without case.
const LEGACY_BY_LOWER = new Map(Object.entries(LEGACY_MAP).map(([id, row]) => [id.toLowerCase(), row]));

/** Used when the configured default is not in the catalog. */
const LAST_RESORT_VOICE = 'puck';

/** Every voice of the catalog: `{ id, name, studio, language, gender, pitch, description, … }`. */
export function getVoiceCatalog() {
    return CATALOG;
}

/** The catalog entry of a Gemini voice ID (any letter case), or null. */
export function getGeminiVoice(voiceId) {
    if (typeof voiceId !== 'string') return null;
    return BY_ID.get(voiceId.trim().toLowerCase()) ?? null;
}

/** True when the ID is a MiniMax voice that the map knows. */
export function isLegacyVoiceId(voiceId) {
    return typeof voiceId === 'string' && !getGeminiVoice(voiceId) && LEGACY_BY_LOWER.has(voiceId.trim().toLowerCase());
}

export function getDefaultVoiceId() {
    const configured = resolveKnown(config.tts?.defaultVoiceId);
    return configured?.voice ?? LAST_RESORT_VOICE;
}

const isEnglish = tag => typeof tag !== 'string' || tag.toLowerCase().startsWith('en');

/**
 * The language that a voice brings with it, as a hint for the speech model, or null.
 * A library voice is a native speaker of one language. A studio voice speaks every
 * language and brings none. English is never a hint: it is what the model assumes.
 */
function nativeLanguage(voice) {
    return voice.studio || isEnglish(voice.language) ? null : voice.language;
}

function resolveKnown(voiceId) {
    const gemini = getGeminiVoice(voiceId);
    if (gemini) return { voice: gemini.id, voiceStyle: '', language: nativeLanguage(gemini), legacy: false };
    if (typeof voiceId !== 'string') return null;
    const row = LEGACY_BY_LOWER.get(voiceId.trim().toLowerCase());
    const target = row && getGeminiVoice(row.voice);
    if (target) {
        // A MiniMax voice had a language of its own. Many of them (Cantonese, Thai, ...)
        // map to a studio voice, which has none, so the language comes from the map row.
        const language = isEnglish(row.languageCode) ? nativeLanguage(target) : row.languageCode;
        return { voice: target.id, voiceStyle: row.style || '', language, legacy: true };
    }
    return null;
}

/**
 * The Gemini voice to synthesise with for whatever ID is stored.
 *
 * @param {string} storedVoiceId A Gemini ID, a MiniMax ID, or anything else
 * @returns {{voice: string, voiceStyle: string, language: string|null, legacy: boolean, fallback: boolean}}
 *   `voiceStyle` is the manner the mapping adds for a MiniMax voice that no Gemini voice
 *   has by itself. `language` is the BCP-47 hint that the voice brings, or null.
 *   `fallback` is true when the ID was unknown and the default was used.
 */
export function resolveVoice(storedVoiceId) {
    const known = resolveKnown(storedVoiceId);
    if (known) return { ...known, fallback: false };
    return { voice: getDefaultVoiceId(), voiceStyle: '', language: null, legacy: false, fallback: true };
}
