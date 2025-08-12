// src/config/loader.js
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

const projectRoot = process.cwd();
const envPath = path.resolve(projectRoot, '.env');

if (fs.existsSync(envPath)) {
  console.log(`[ConfigLoader] Loading .env file from: ${envPath}`);
  dotenv.config({ path: envPath });
}

function loadConfig() {
    const requiredEnvVars = [
        'TWITCH_BOT_USERNAME', 
        'TWITCH_CLIENT_ID',
        'TWITCH_CLIENT_SECRET',
        'TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME', 
        'REPLICATE_API_TOKEN',
    ];

    const missingEnvVars = requiredEnvVars.filter(key => !(key in process.env));

    if (missingEnvVars.length > 0) {
        throw new Error(
            `Missing required environment variables: ${missingEnvVars.join(', ')}`
        );
    }
    // TWITCH_CHANNELS check can remain for local dev convenience

    const allowedChannels = (process.env.ALLOWED_CHANNELS || '')
        .split(',')
        .map(ch => ch.trim().toLowerCase())
        .filter(Boolean);

    const config = {
        twitch: {
            username: process.env.TWITCH_BOT_USERNAME,
            channels: process.env.TWITCH_CHANNELS
                ? process.env.TWITCH_CHANNELS.split(',').map(ch => ch.trim().toLowerCase()).filter(ch => ch)
                : [], // In prod, this will be populated by channelManager
            clientId: process.env.TWITCH_CLIENT_ID,
            clientSecret: process.env.TWITCH_CLIENT_SECRET,
        },
        security: {
            allowedChannels,
        },
        tts: {
            defaultVoiceId: process.env.TTS_DEFAULT_VOICE_ID || 'Friendly_Person',
            defaultEmotion: process.env.TTS_DEFAULT_EMOTION || 'auto',
            defaultPitch: parseInt(process.env.TTS_DEFAULT_PITCH, 10) || 0, 
            defaultSpeed: parseFloat(process.env.TTS_DEFAULT_SPEED) || 1.0, 
            replicateApiToken: process.env.REPLICATE_API_TOKEN,
            replicateModel: process.env.REPLICATE_TTS_MODEL_NAME || "minimax/speech-02-turbo",
            defaultEnglishNormalization: false,
            },
        app: {
            logLevel: process.env.LOG_LEVEL || 'info',
            prettyLog: process.env.PINO_PRETTY_LOGGING === 'true',
            nodeEnv: process.env.NODE_ENV || 'development',
        },
        secrets: {
            twitchBotRefreshTokenName: process.env.TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME,
            allowedChannelsSecretName: process.env.ALLOWED_CHANNELS_SECRET_NAME,
        }
    };

    if (!config.tts.replicateApiToken && config.app.nodeEnv !== 'test') {
        console.error('[ConfigLoader] REPLICATE_API_TOKEN is not set. TTS functionality WILL FAIL.');
        // Potentially throw new Error('Missing REPLICATE_API_TOKEN.');
    }
    if (!config.tts.replicateModel && config.app.nodeEnv !== 'test') {
        console.warn('[ConfigLoader] REPLICATE_TTS_MODEL_NAME is not set. Using default "minimax/speech-02-turbo".');
    }
    return config;
}

export default loadConfig();