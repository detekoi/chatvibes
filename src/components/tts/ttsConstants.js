// src/components/tts/ttsConstants.js
import config from '../../config/index.js'; 

export const DEFAULT_TTS_SETTINGS = {
    engineEnabled: true,
    mode: 'all',
    ttsPermissionLevel: 'everyone',
    voiceId: config.tts?.defaultVoiceId || 'Friendly_Person',
    speed: config.tts?.defaultSpeed || 1.0,
    volume: 1.0,
    pitch: config.tts?.defaultPitch || 0,
    emotion: config.tts?.defaultEmotion || 'neutral',
    englishNormalization: false,
    allowViewerPreferences: true,
    readFullUrls: false, // Default to reading only domain names for better listening experience
    sampleRate: 32000,
    bitrate: 128000,
    channel: 'mono',
    languageBoost: config.tts?.defaultLanguageBoost || 'auto',
    speakEvents: true,
    botMode: 'anonymous', // 'anonymous' (bot-free), 'authenticated' (bot with chat commands), or 'auto' (authenticated if available, fallback to anonymous)
    // It's good practice to initialize userPreferences and ignoredUsers in default settings
    // userPreferences: {}, // Will be handled by ttsState.js if it needs to be part of base default
    // ignoredUsers: []      // Will be handled by ttsState.js
};


export const VALID_EMOTIONS = [
    "neutral", "happy", "sad", "angry", "fearful", "disgusted", "surprised"
];

export const TTS_PITCH_MIN = -12;
export const TTS_PITCH_MAX = 12;
export const TTS_PITCH_DEFAULT = 0;

export const TTS_SPEED_MIN = 0.5;
export const TTS_SPEED_MAX = 2.0;
export const TTS_SPEED_DEFAULT = 1.0;
export const VALID_LANGUAGE_BOOSTS = [
    "auto", "Chinese", "Chinese,Yue", "English", "Arabic",
    "Russian", "Spanish", "French", "Portuguese", "German", "Turkish",
    "Dutch", "Ukrainian", "Vietnamese", "Indonesian", "Japanese",
    "Italian", "Korean", "Thai", "Polish", "Romanian", "Greek",
    "Czech", "Finnish", "Hindi"
];

export const BOT_MODE_ANONYMOUS = 'anonymous'; // Bot-free: read-only IRC connection (justinfan)
export const BOT_MODE_AUTHENTICATED = 'authenticated'; // Bot with chat commands: requires OAuth
export const BOT_MODE_AUTO = 'auto'; // Try authenticated, fallback to anonymous

export const VALID_BOT_MODES = [
    BOT_MODE_ANONYMOUS,
    BOT_MODE_AUTHENTICATED,
    BOT_MODE_AUTO
];
