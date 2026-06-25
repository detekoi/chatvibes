// src/components/tts/ttsConstants.js
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import config from '../../config/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ttsConfig = JSON.parse(readFileSync(join(__dirname, 'tts-config.json'), 'utf8'));

export const DEFAULT_TTS_SETTINGS = {
    engineEnabled: true,
    mode: 'all',
    ttsPermissionLevel: 'everyone',
    voiceId: config.tts?.defaultVoiceId || 'Friendly_Person',
    speed: config.tts?.defaultSpeed || ttsConfig.SPEED.DEFAULT,
    volume: 1.0,
    pitch: config.tts?.defaultPitch || ttsConfig.PITCH.DEFAULT,
    emotion: config.tts?.defaultEmotion || 'neutral',
    englishNormalization: false,
    allowViewerPreferences: true,
    readFullUrls: false, // Default to reading only domain names for better listening experience
    sampleRate: 32000,
    bitrate: 128000,
    channel: 'mono',
    languageBoost: config.tts?.defaultLanguageBoost || 'auto',
    speakEvents: true,
    botRespondsInChat: true, // Whether the bot sends chat responses (default: true = interactive mode)
    // It's good practice to initialize userPreferences and ignoredUsers in default settings
    // userPreferences: {}, // Will be handled by ttsState.js if it needs to be part of base default
    // ignoredUsers: []      // Will be handled by ttsState.js
};

// All valid emotions (speech-2.8-turbo full set + "neutral" as user-facing auto-detect alias)
export const VALID_EMOTIONS = ttsConfig.VALID_EMOTIONS;

// Emotion aliases for normalizing user input (e.g. "mad" → "angry")
export const EMOTION_ALIASES = ttsConfig.EMOTION_ALIASES;

// Emotions safe for the Wavespeed/speech-02-turbo fallback path (no calm/fluent)
export const LEGACY_SAFE_EMOTIONS = ttsConfig.LEGACY_SAFE_EMOTIONS;

export const TTS_PITCH_MIN = ttsConfig.PITCH.MIN;
export const TTS_PITCH_MAX = ttsConfig.PITCH.MAX;
export const TTS_PITCH_DEFAULT = ttsConfig.PITCH.DEFAULT;

export const TTS_SPEED_MIN = ttsConfig.SPEED.MIN;
export const TTS_SPEED_MAX = ttsConfig.SPEED.MAX;
export const TTS_SPEED_DEFAULT = ttsConfig.SPEED.DEFAULT;

// Full language boost list (speech-2.8-turbo, 40 languages)
export const VALID_LANGUAGE_BOOSTS = ttsConfig.VALID_LANGUAGE_BOOSTS;

// Languages safe for the Wavespeed/speech-02-turbo fallback path (25 languages)
export const LEGACY_SAFE_LANGUAGE_BOOSTS = ttsConfig.LEGACY_SAFE_LANGUAGE_BOOSTS;

/**
 * Normalizes emotion input using aliases from tts-config.json.
 * Resolves synonyms (e.g. "mad" → "angry", "auto" → "neutral") and lowercases.
 * @param {string|null|undefined} emotion - Raw emotion value
 * @returns {string} - Canonical emotion token, defaults to "neutral"
 */
export function normalizeEmotion(emotion) {
    if (!emotion) return 'neutral';
    const lower = emotion.toLowerCase().trim();
    if (VALID_EMOTIONS.includes(lower)) return lower;
    return EMOTION_ALIASES[lower] || 'neutral';
}

export const DOC_LINKS = {
    voices: 'https://docs.wildcat.chat/wildcatttsdocs.html#voices',
    languageBoost: 'https://docs.wildcat.chat/wildcatttsdocs.html#language-boost',
};
