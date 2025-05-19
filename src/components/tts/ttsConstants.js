// src/components/tts/ttsConstants.js
import config from '../../config/index.js'; // Import the main config

export const DEFAULT_TTS_SETTINGS = {
    engineEnabled: true,
    mode: 'command', // 'all' or 'command' (speak all messages or only on command)
    voiceId: config.tts?.defaultVoiceId || 'Friendly_Person', // Use from global config
    speed: 1.0,
    volume: 1.0,
    pitch: 0,
    emotion: config.tts?.defaultEmotion || 'auto', // Use from global config
    englishNormalization: true,
    sampleRate: 32000,
    bitrate: 128000,
    channel: 'mono',
    languageBoost: 'English',
    speakEvents: true,
};

export const VALID_EMOTIONS = [
    "auto", "neutral", "happy", "sad", "angry", "fearful", "disgusted", "surprised"
];