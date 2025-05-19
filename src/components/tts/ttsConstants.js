// src/components/tts/ttsConstants.js

// Default TTS settings for the application when no channel-specific config is found
export const DEFAULT_TTS_SETTINGS = {
    engineEnabled: true,
    mode: 'command', // 'all' or 'command' (speak all messages or only on command)
    voiceId: 'Friendly_Person', // A sensible default from the MiniMax list
    speed: 1.0,
    volume: 1.0,
    pitch: 0,
    emotion: 'neutral', // Default emotion
    englishNormalization: true, // For better number reading in English
    sampleRate: 32000, // Common sample rate
    bitrate: 128000, // Common bitrate
    channel: 'mono', // Mono is typical for TTS
    languageBoost: 'English', // Default language boost
    speakEvents: true, // Whether to speak Twitch events like subs, cheers by default
};

export const VALID_EMOTIONS = [
    "auto", "neutral", "happy", "sad", "angry", "fearful", "disgusted", "surprised"
];

// The ALL_AVAILABLE_VOICES and PRE_TRAINED_VOICES, SYSTEM_VOICES are now managed dynamically by ttsService.js
// The async getAllAvailableVoices() function is also effectively replaced by getAvailableVoices() in ttsService.js