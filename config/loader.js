// src/config/loader.js
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Assume the process runs from the project root
const projectRoot = process.cwd();
const envPath = path.resolve(projectRoot, '.env');

if (fs.existsSync(envPath)) {
  console.log(`[ConfigLoader] Loading .env file from: ${envPath}`);
  dotenv.config({ path: envPath });
}

function loadConfig() {
    // ... (your existing requiredEnvVars checks) ...

    const config = {
        twitch: {
            username: process.env.TWITCH_BOT_USERNAME,
            channels: process.env.TWITCH_CHANNELS
                ? process.env.TWITCH_CHANNELS.split(',').map(ch => ch.trim().toLowerCase()).filter(ch => ch)
                : [],
            clientId: process.env.TWITCH_CLIENT_ID,
            clientSecret: process.env.TWITCH_CLIENT_SECRET,
        },
        gemini: {
            apiKey: process.env.GEMINI_API_KEY,
            modelId: process.env.GEMINI_MODEL_ID || 'gemini-2.0-flash-001',
        },
        tts: {
            defaultVoiceId: process.env.TTS_DEFAULT_VOICE_ID || 'Friendly_Person',
            defaultEmotion: process.env.TTS_DEFAULT_EMOTION || 'auto',
            replicateApiKey: process.env.REPLICATE_API_KEY,
            replicateModel: process.env.REPLICATE_TTS_MODEL_NAME || "minimax/speech-02-turbo"
        },
        app: {
            streamInfoFetchIntervalMs: (parseInt(process.env.STREAM_INFO_FETCH_INTERVAL_SECONDS, 10) || 120) * 1000,
            logLevel: process.env.LOG_LEVEL || 'info',
            prettyLog: process.env.PINO_PRETTY_LOGGING === 'true',
            nodeEnv: process.env.NODE_ENV || 'development',
            // externalApiTimeout: parseInt(process.env.EXTERNAL_API_TIMEOUT_MS, 10) || 15000, // Example
        },
        secrets: {
            twitchBotRefreshTokenName: process.env.TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME,
            twitchChannelsSecretName: process.env.TWITCH_CHANNELS_SECRET_NAME || null,
            // replicateApiKeySecretName: process.env.REPLICATE_API_KEY_SECRET_NAME || null,
        }
    };

    // Validate Replicate API key presence
    if (!config.tts.replicateApiKey && config.app.nodeEnv !== 'test') {
        console.warn('[ConfigLoader] REPLICATE_API_KEY is not set. TTS functionality will fail.');
        // throw new Error('Missing REPLICATE_API_KEY environment variable.');
    }
    if (!config.tts.replicateModel && config.app.nodeEnv !== 'test') {
        console.warn('[ConfigLoader] REPLICATE_TTS_MODEL_NAME is not set. Using default "minimax/speech-02-turbo".');
    }

    // ... (other validations) ...

    return config;
}

export default loadConfig();