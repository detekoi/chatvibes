// src/components/tts/styleBuilder.js
// Gemini TTS has no speed, pitch or emotion numbers. It takes one free-text style for
// the turn. This module turns the stored settings into that text.
//
// The stored fields keep their old shape (emotion key, numeric speed and pitch), so no
// data migration is needed: a number is converted to a step every time it is read.

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ttsConfig = require('./tts-config.json');

export const STYLE_MAX_LENGTH = ttsConfig.STYLE.MAX_LENGTH;
export const STYLE_PRESETS = ttsConfig.STYLE_PRESETS;
export const SPEED_STEPS = ttsConfig.SPEED_STEPS;
export const PITCH_STEPS = ttsConfig.PITCH_STEPS;

function stepFor(steps, value, fallbackKey = 'normal') {
    // Number(null) and Number('') are 0, which is not a speed or a pitch anyone chose.
    const number = value === null || value === undefined || value === '' ? NaN : Number(value);
    if (!Number.isFinite(number)) return steps.find(step => step.key === fallbackKey);
    return steps.find(step => step.upTo === null || number <= step.upTo);
}

/** The step that a stored speed (0.5 to 2.0) belongs to. */
export function speedStep(speed) {
    // A speed of 0 or less is not a valid stored value.
    return stepFor(SPEED_STEPS, Number(speed) > 0 ? speed : null);
}

/** The step that a stored pitch (-12 to 12) belongs to. */
export function pitchStep(pitch) {
    return stepFor(PITCH_STEPS, pitch);
}

/**
 * A step by the word a user types (`slow`, `very-fast`, `very_low`), or null.
 * @param {Array} steps SPEED_STEPS or PITCH_STEPS
 * @param {string} word
 */
export function stepByWord(steps, word) {
    const key = String(word ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    return steps.find(step => step.key === key) ?? null;
}

/**
 * Clean a style that a person typed. The style is an instruction to the model and is
 * never spoken, so this only keeps it short and on one line. Returns '' for nothing usable.
 */
export function sanitizeStyle(text) {
    if (typeof text !== 'string') return '';
    return text
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f<>{}]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, STYLE_MAX_LENGTH)
        .trim();
}

/**
 * The style text for one clip.
 *
 * A custom style replaces the emotion preset. The manner of a mapped MiniMax voice
 * (voiceStyle) goes first, and the pace and pitch words go last.
 *
 * @param {{style?: string, voiceStyle?: string, emotion?: string, speed?: number, pitch?: number}} settings
 * @returns {string} '' when the clip needs no style
 */
export function buildStyle({ style, voiceStyle, emotion, speed, pitch } = {}) {
    const custom = sanitizeStyle(style);
    const parts = [
        sanitizeStyle(voiceStyle),
        // An own-property test: `constructor` is not an emotion.
        custom || (Object.hasOwn(STYLE_PRESETS, emotion) ? STYLE_PRESETS[emotion] : ''),
        speedStep(speed)?.style,
        pitchStep(pitch)?.style,
    ];
    return parts.filter(Boolean).join(', ');
}
