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
    ];

    const missingEnvVars = requiredEnvVars.filter(key => !(key in process.env));

    if (missingEnvVars.length > 0) {
        throw new Error(
            `Missing required environment variables: ${missingEnvVars.join(', ')}`
        );
    }
    // TWITCH_CHANNELS check can remain for local dev convenience

    const allowedBroadcasterIds = (process.env.ALLOWED_CHANNELS || '')
        .split(',')
        .map(id => id.trim())
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
            accessToken: null, // Bot's user access token, populated at runtime by loadBotAccessToken()
        },
        security: {
            allowedBroadcasterIds,
        },
        tts: {
            // A Gemini voice ID from gemini-voices.json. A stored MiniMax ID still
            // works: voiceResolver.js maps it.
            defaultVoiceId: process.env.TTS_DEFAULT_VOICE_ID || 'puck',
            defaultEmotion: process.env.TTS_DEFAULT_EMOTION || 'neutral',
            defaultPitch: parseInt(process.env.TTS_DEFAULT_PITCH, 10) || 0,
            defaultSpeed: parseFloat(process.env.TTS_DEFAULT_SPEED) || 1.0,
            defaultLanguageBoost: process.env.TTS_DEFAULT_LANGUAGE_BOOST || 'auto',
            geminiApiKey: process.env.GEMINI_API_KEY,
            geminiEndpoint: process.env.GEMINI_TTS_ENDPOINT || 'https://generativelanguage.googleapis.com/v1beta/interactions',
            geminiModel: process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-lite-tts',
            // Tried once after the main model failed twice. Set it to an empty string to turn it off.
            geminiFallbackModel: process.env.GEMINI_TTS_FALLBACK_MODEL ?? 'gemini-3.8-flash-tts',
        },
        app: {
            logLevel: process.env.LOG_LEVEL || 'info',
            prettyLog: process.env.PINO_PRETTY_LOGGING === 'true',
            nodeEnv: process.env.NODE_ENV || 'development',
        },
        // Multi-instance coordination. Each channel is leased to the instance
        // holding its browser source, which owns the channel's queue and
        // receives the channel's webhooks from the other instances through a
        // Firestore inbox (src/lib/channelOwnership.js). On by default on Cloud
        // Run, off locally so a dev process sharing the production Firestore
        // never takes a channel away from production.
        cluster: {
            channelOwnershipEnabled: process.env.CHANNEL_OWNERSHIP_ENABLED
                ? process.env.CHANNEL_OWNERSHIP_ENABLED === 'true'
                : !!(process.env.K_SERVICE || process.env.K_REVISION || process.env.K_CONFIGURATION),
        },
        secrets: {
            twitchBotRefreshTokenName: process.env.TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME,
            jwtSecret: process.env.JWT_SECRET || process.env.JWT_SECRET_KEY, // Support both env var names
        },
        emote: {
            geminiModel: process.env.EMOTE_GEMINI_MODEL || 'gemini-flash-lite-latest',
            cdnUrl: 'https://static-cdn.jtvnw.net/emoticons/v2',
            maxGifFrames: 3,       // Number of evenly-spaced frames to sample from animated GIFs
            timeoutMs: 8000,       // Gemini timeout for static emotes
            animatedTimeoutMs: 12000, // Gemini timeout for animated (multi-image) emotes
        },
    };

    if (!config.tts.geminiApiKey && config.app.nodeEnv !== 'test') {
        console.error('[ConfigLoader] GEMINI_API_KEY is not set. TTS functionality WILL FAIL.');
    }
    return config;
}

export default loadConfig();