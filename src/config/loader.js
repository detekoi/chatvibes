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
        'TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME',
        'WAVESPEED_API_KEY',
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

    // For Client ID and Secret, prefer environment variables for local dev,
    // but in production these will be loaded from Secret Manager
    // Use the web UI's Client ID for unified authentication
    const clientId = process.env.TWITCH_CLIENT_ID || null;
    const clientSecret = process.env.TWITCH_CLIENT_SECRET || null;

        // Secret Manager paths for production deployment (unified with web UI)
        const clientIdSecretPath = process.env.TWITCH_CLIENT_ID_SECRET_NAME ||
            'projects/906125386407/secrets/twitch-client-id/versions/latest';
        const clientSecretPath = process.env.TWITCH_CLIENT_SECRET_NAME ||
            'projects/906125386407/secrets/twitch-client-secret/versions/latest';

    const config = {
        twitch: {
            username: process.env.TWITCH_BOT_USERNAME,
            channels: process.env.TWITCH_CHANNELS
                ? process.env.TWITCH_CHANNELS.split(',').map(ch => ch.trim().toLowerCase()).filter(ch => ch)
                : [], // In prod, this will be populated by channelManager
            clientId: clientId, // May be null initially, loaded from Secret Manager in production
            clientSecret: clientSecret, // May be null initially, loaded from Secret Manager in production
            clientIdSecretPath: clientIdSecretPath, // Path to Secret Manager secret
            clientSecretPath: clientSecretPath, // Path to Secret Manager secret
            publicUrl: process.env.PUBLIC_URL, // EventSub webhook callback URL
            eventSubSecret: process.env.TWITCH_EVENTSUB_SECRET, // EventSub signature verification secret
        },
        security: {
            allowedChannels,
        },
        tts: {
            defaultVoiceId: process.env.TTS_DEFAULT_VOICE_ID || 'Friendly_Person',
            defaultEmotion: process.env.TTS_DEFAULT_EMOTION || 'neutral',
            defaultPitch: parseInt(process.env.TTS_DEFAULT_PITCH, 10) || 0,
            defaultSpeed: parseFloat(process.env.TTS_DEFAULT_SPEED) || 1.0,
            wavespeedApiKey: process.env.WAVESPEED_API_KEY,
            wavespeedEndpoint: process.env.WAVESPEED_API_ENDPOINT || 'https://api.wavespeed.ai/api/v3/minimax/speech-02-turbo',
            defaultEnglishNormalization: false,
            defaultLanguageBoost: process.env.TTS_DEFAULT_LANGUAGE_BOOST || 'auto',
            },
        app: {
            logLevel: process.env.LOG_LEVEL || 'info',
            prettyLog: process.env.PINO_PRETTY_LOGGING === 'true',
            nodeEnv: process.env.NODE_ENV || 'development',
        },
        secrets: {
            twitchBotRefreshTokenName: process.env.TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME,
            allowedChannelsSecretName: process.env.ALLOWED_CHANNELS_SECRET_NAME,
            jwtSecret: process.env.JWT_SECRET_KEY,
        }
    };

    if (!config.tts.wavespeedApiKey && config.app.nodeEnv !== 'test') {
        console.error('[ConfigLoader] WAVESPEED_API_KEY is not set. TTS functionality WILL FAIL.');
        // Potentially throw new Error('Missing WAVESPEED_API_KEY.');
    }
    if (!config.tts.wavespeedEndpoint && config.app.nodeEnv !== 'test') {
        console.warn('[ConfigLoader] WAVESPEED_API_ENDPOINT is not set. Using default endpoint.');
    }
    return config;
}

export default loadConfig();