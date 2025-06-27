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
    emotion: config.tts?.defaultEmotion || 'auto',
    englishNormalization: false,
    sampleRate: 32000,
    bitrate: 128000,
    channel: 'mono',
    languageBoost: config.tts?.defaultLanguageBoost || 'Automatic',
    speakEvents: true,
    // It's good practice to initialize userPreferences and ignoredUsers in default settings
    // userPreferences: {}, // Will be handled by ttsState.js if it needs to be part of base default
    // ignoredUsers: []      // Will be handled by ttsState.js
};


export const VALID_EMOTIONS = [
    "auto", "neutral", "happy", "sad", "angry", "fearful", "disgusted", "surprised"
];

export const TTS_PITCH_MIN = -12;
export const TTS_PITCH_MAX = 12;
export const TTS_PITCH_DEFAULT = 0;

export const TTS_SPEED_MIN = 0.5;
export const TTS_SPEED_MAX = 2.0;
export const TTS_SPEED_DEFAULT = 1.0;
export const VALID_LANGUAGE_BOOSTS = [
    "None", "Automatic", "Chinese", "Chinese,Yue", "English", "Arabic",
    "Russian", "Spanish", "French", "Portuguese", "German", "Turkish",
    "Dutch", "Ukrainian", "Vietnamese", "Indonesian", "Japanese",
    "Italian", "Korean", "Thai", "Polish", "Romanian", "Greek",
    "Czech", "Finnish", "Hindi"
];
