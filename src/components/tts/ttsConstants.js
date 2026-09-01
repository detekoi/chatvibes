// src/components/tts/ttsConstants.js
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import config from '../../config/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ttsConfig = JSON.parse(readFileSync(join(__dirname, 'tts-config.json'), 'utf8'));

export const DEFAULT_TTS_SETTINGS = {
    engineEnabled: true,
    mode: 'command', // A channel that never chose one starts in command mode; the dashboard writes this at first sign-in
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
    // A reward that does not skip Twitch's request queue is redeemed as
    // .add + unfulfilled, and waiting for the streamer to accept it means a
    // channel that never works its queue hears nothing from that reward at all.
    // Announcing on .add is the default because that silence is indistinguishable
    // from the bot being broken; a channel that would rather be able to reject a
    // redemption before it is spoken switches this off.
    announceUnfulfilledRedemptions: true,
    botRespondsInChat: true, // Whether the bot sends chat responses (default: true = interactive mode)
    // Channel overrides for the built-in acronym dictionary, keyed by the
    // lowercased match. An empty value switches off the built-in of that name.
    // Like ignoredUserIds this has a default, so hydration always yields an
    // object and callers never have to guard before reading it.
    pronunciations: {},
    pronunciationEnabled: true,
    profanityFilterEnabled: false, // Opt-in: off unless a channel turns it on
    // TTS ignore list, keyed by immutable platform account ID. See src/lib/ignoreList.js
    // for the key format and why login names are not used.
    ignoredUserIds: {},
    // It's good practice to initialize userPreferences in default settings
    // userPreferences: {}, // Will be handled by ttsState.js if it needs to be part of base default
};

// All valid emotions (speech-2.8-turbo full set + "neutral" as user-facing auto-detect alias)
export const VALID_EMOTIONS = ttsConfig.VALID_EMOTIONS;

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

export const DOC_LINKS = {
    voices: 'https://docs.wildcat.chat/wildcatttsdocs.html#voices',
    languageBoost: 'https://docs.wildcat.chat/wildcatttsdocs.html#language-boost',
};
