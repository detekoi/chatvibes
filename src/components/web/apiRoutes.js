// src/components/web/apiRoutes.js
// All /api/* REST route handlers, JWT middleware, CORS, and rate limiting.

import { Router, json as expressJson } from 'express';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import logger from '../../lib/logger.js';
import config from '../../config/index.js';
import { isChannelAllowed } from '../../lib/allowList.js';
import { handleSecretCleanup } from './cleanupEndpoint.js';

import {
    getTtsState,
    setTtsState,
    addIgnoredUser,
    removeIgnoredUser,
    addBannedWord,
    removeBannedWord,
} from '../tts/ttsState.js';

import {
    VALID_EMOTIONS,
    VALID_LANGUAGE_BOOSTS,
    TTS_PITCH_MIN,
    TTS_PITCH_MAX,
    TTS_SPEED_MIN,
    TTS_SPEED_MAX,
} from '../tts/ttsConstants.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || config.secrets.jwtSecret;
const BODY_SIZE_LIMIT = '1mb';

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

const ALLOWED_ORIGINS = new Set([
    'http://localhost:5002',
    'http://127.0.0.1:5002',
    'https://tts.wildcat.chat',
    'https://chatvibestts.web.app',
    'https://chatvibestts.firebaseapp.com',
]);

export function applyCors(req, res) {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
        res.setHeader('Access-Control-Allow-Origin', 'https://tts.wildcat.chat');
    }
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
}

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

const apiRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    // Correctly extract IP when behind a proxy (like Cloud Run)
    keyGenerator: req =>
        req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress,
});

// ---------------------------------------------------------------------------
// JWT middleware
// ---------------------------------------------------------------------------

/**
 * Channel-scoped JWT guard.
 * Expects the route to have a :channel param (set by Express via the route definition).
 * Sets req.channelName and req.userLogin on success.
 */
async function verifyChannelAccess(req, res, next) {
    const channelName = req.params.channel?.toLowerCase();

    if (!channelName) {
        return res.status(400).json({ success: false, error: 'Channel name not found in URL' });
    }

    if (!isChannelAllowed(channelName)) {
        return res.status(403).json({ success: false, error: 'Forbidden: Channel is not allowed to use this service' });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Authorization token is required' });
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).json({ success: false, error: 'Bearer token is missing' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET_KEY, {
            audience: ['wildcat-tts-api', 'chatvibes-api'],
            issuer: ['wildcat-tts-auth', 'chatvibes-auth'],
        });

        if (!decoded?.userLogin) {
            return res.status(401).json({ success: false, error: 'Token missing required userLogin claim' });
        }

        const userLogin = decoded.userLogin.toLowerCase();
        if (userLogin !== channelName) {
            return res.status(403).json({ success: false, error: 'Forbidden: You do not have permission to modify this channel' });
        }

        req.channelName = channelName;
        req.userLogin = userLogin;
        next();
    } catch (error) {
        logger.error({ err: error }, 'JWT verification failed');
        if (error instanceof jwt.TokenExpiredError) {
            return res.status(401).json({ success: false, error: 'Token has expired' });
        }
        if (error instanceof jwt.JsonWebTokenError) {
            return res.status(401).json({ success: false, error: 'Invalid token' });
        }
        return res.status(500).json({ success: false, error: 'Internal server error during token verification' });
    }
}

/**
 * Light-weight JWT check used by /api/tts/test — validates the token is
 * genuine but does not enforce channel ownership.
 */
function verifyAnyValidToken(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Authorization token is required' });
    }

    const token = authHeader.split(' ')[1];
    try {
        jwt.verify(token, JWT_SECRET_KEY, {
            audience: ['wildcat-tts-api', 'chatvibes-api'],
            issuer: ['wildcat-tts-auth', 'chatvibes-auth'],
        });
        next();
    } catch {
        return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

async function validateTtsSetting(key, value) {
    switch (key) {
        case 'engineEnabled':
        case 'speakEvents':
        case 'bitsModeEnabled':
        case 'readFullUrls':
        case 'allowViewerPreferences':
        case 'botRespondsInChat':
        case 'englishNormalization':
            return typeof value === 'boolean';
        case 'mode':
            return ['all', 'command', 'bits_points_only'].includes(value);
        case 'ttsPermissionLevel':
            return ['everyone', 'mods', 'vip'].includes(value);
        case 'emotion':
            return VALID_EMOTIONS.includes(value.toLowerCase());
        case 'languageBoost':
            return VALID_LANGUAGE_BOOSTS.includes(value);
        case 'pitch': {
            const pitch = parseInt(value, 10);
            return !isNaN(pitch) && pitch >= TTS_PITCH_MIN && pitch <= TTS_PITCH_MAX;
        }
        case 'speed': {
            const speed = parseFloat(value);
            return !isNaN(speed) && speed >= TTS_SPEED_MIN && speed <= TTS_SPEED_MAX;
        }
        case 'bitsMinimumAmount': {
            const amount = parseInt(value, 10);
            return !isNaN(amount) && amount >= 0;
        }
        case 'voiceId':
            return typeof value === 'string' && value.length > 0;
        default:
            if (key.startsWith('voiceVolumes.')) {
                const volume = parseFloat(value);
                return !isNaN(volume) && volume > 0 && volume <= 10;
            }
            if (key === 'bannedWords') {
                return Array.isArray(value) && value.every(w => typeof w === 'string');
            }
            logger.warn(`Unknown TTS setting key: ${key}`);
            return false;
    }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleVoicesEndpoint(req, res) {
    try {
        const { getAvailableVoices } = await import('../tts/ttsService.js');
        const voiceList = await getAvailableVoices();

        if (voiceList && voiceList.length > 0) {
            return res.json({ success: true, voices: voiceList.map(v => v.id || v) });
        }
    } catch (error) {
        logger.error({ err: error }, 'Failed to fetch voices from TTS service');
    }

    // Fallback voices (Wavespeed defaults)
    const fallbackVoices = [
        'Friendly_Person', 'Wise_Woman', 'Deep_Voice_Man', 'Calm_Woman',
        'Casual_Guy', 'Lively_Girl', 'Patient_Man', 'Young_Knight',
        'Determined_Man', 'Lovely_Girl', 'Decent_Boy', 'Elegant_Man',
    ];
    return res.json({ success: true, voices: fallbackVoices });
}

async function handleTtsTest(req, res) {
    const { text, voiceId, pitch, speed, volume, emotion, languageBoost, englishNormalization } = req.body;

    if (!text) {
        return res.status(400).json({ success: false, error: 'Text is required' });
    }

    try {
        const { generateSpeech } = await import('../tts/ttsService.js');
        const audioUrl = await generateSpeech(text, voiceId, {
            pitch, speed, volume, emotion, languageBoost, englishNormalization,
        });
        return res.json({ success: true, audioUrl });
    } catch (error) {
        logger.error({ err: error }, 'TTS Test generation failed');
        return res.status(500).json({ success: false, error: error.message || 'Failed to generate audio' });
    }
}

async function handleTtsSettingsGet(req, res) {
    const settings = await getTtsState(req.channelName);
    const payload = {
        ...settings,
        englishNormalization: settings.englishNormalization !== undefined ? settings.englishNormalization : false,
    };
    return res.json({ success: true, settings: payload });
}

async function handleTtsSettingsPut(req, res) {
    const { key, value } = req.body;

    if (!await validateTtsSetting(key, value)) {
        return res.status(400).json({ success: false, error: `Invalid setting: ${key} = ${value}` });
    }

    const success = await setTtsState(req.channelName, key, value);
    return success
        ? res.json({ success: true, message: 'Setting updated successfully' })
        : res.status(500).json({ success: false, error: 'Failed to update setting' });
}

async function handleTtsIgnorePost(req, res) {
    const { username } = req.body;
    if (!username) return res.status(400).json({ success: false, error: 'Username required' });

    const success = await addIgnoredUser(req.channelName, username);
    return success
        ? res.json({ success: true, message: `User ${username} added to ignore list` })
        : res.status(500).json({ success: false, error: 'Failed to add user to ignore list' });
}

async function handleTtsIgnoreDelete(req, res) {
    const { username } = req.body;
    if (!username) return res.status(400).json({ success: false, error: 'Username required' });

    const success = await removeIgnoredUser(req.channelName, username);
    return success
        ? res.json({ success: true, message: `User ${username} removed from ignore list` })
        : res.status(500).json({ success: false, error: 'Failed to remove user from ignore list' });
}

async function handleTtsBannedWordsPost(req, res) {
    const { word } = req.body;
    if (!word || typeof word !== 'string' || !word.trim()) {
        return res.status(400).json({ success: false, error: 'Word or phrase required' });
    }

    const success = await addBannedWord(req.channelName, word);
    return success
        ? res.json({ success: true, message: 'Word/phrase added to banned list' })
        : res.status(500).json({ success: false, error: 'Failed to add word to banned list' });
}

async function handleTtsBannedWordsDelete(req, res) {
    const { word } = req.body;
    if (!word || typeof word !== 'string' || !word.trim()) {
        return res.status(400).json({ success: false, error: 'Word or phrase required' });
    }

    const success = await removeBannedWord(req.channelName, word);
    return success
        ? res.json({ success: true, message: 'Word/phrase removed from banned list' })
        : res.status(500).json({ success: false, error: 'Failed to remove word from banned list' });
}

async function handleEventSubSetup(req, res) {
    const { channelLogin, userId } = req.body;

    if (!channelLogin) {
        return res.status(400).json({ success: false, error: 'Missing channelLogin' });
    }

    logger.info({ channelLogin, userId }, 'Setting up EventSub subscriptions');

    try {
        const { subscribeChannelToTtsEvents } = await import('../twitch/twitchSubs.js');
        const result = await subscribeChannelToTtsEvents(userId, {
            subscribe: true,
            resubscribe: true,
            giftSub: true,
            cheer: true,
            raid: true,
            follow: true,
        });

        logger.info({
            channelLogin, userId,
            successful: result.successful.length,
            failed: result.failed.length,
        }, 'EventSub setup completed');

        return res.json({
            success: true,
            message: 'EventSub subscriptions configured',
            channelLogin, userId,
            successful: result.successful,
            failed: result.failed,
        });
    } catch (error) {
        logger.error({ err: error }, 'Error in handleEventSubSetup');
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * Creates and returns the Express Router for all /api/* endpoints.
 * Mount this at /api in the main Express app.
 */
export function createApiRouter() {
    const router = Router();

    // CORS on every response
    router.use((req, res, next) => {
        applyCors(req, res);
        if (req.method === 'OPTIONS') {
            return res.status(204).end();
        }
        next();
    });

    // Rate limiting
    router.use(apiRateLimiter);

    // Parse JSON bodies (1 MB limit) for all API routes
    router.use(expressJson({ limit: BODY_SIZE_LIMIT }));

    // ── Public ────────────────────────────────────────────────────────────
    router.get('/voices', handleVoicesEndpoint);

    // ── Lightly-protected (valid JWT, no channel check) ───────────────────
    router.post('/tts/test', verifyAnyValidToken, handleTtsTest);

    // ── System / admin ────────────────────────────────────────────────────
    router.post('/setup-eventsub', handleEventSubSetup);
    router.post('/admin/secret-cleanup', handleSecretCleanup);

    // ── Channel-scoped (full JWT + ownership) ─────────────────────────────
    router.get('/tts/settings/channel/:channel', verifyChannelAccess, handleTtsSettingsGet);
    router.put('/tts/settings/channel/:channel', verifyChannelAccess, handleTtsSettingsPut);

    router.post('/tts/ignore/channel/:channel', verifyChannelAccess, handleTtsIgnorePost);
    router.delete('/tts/ignore/channel/:channel', verifyChannelAccess, handleTtsIgnoreDelete);

    router.post('/tts/banned-words/channel/:channel', verifyChannelAccess, handleTtsBannedWordsPost);
    router.delete('/tts/banned-words/channel/:channel', verifyChannelAccess, handleTtsBannedWordsDelete);

    // ── Catch-all 404 ─────────────────────────────────────────────────────
    router.use((_req, res) => {
        res.status(404).json({ success: false, error: 'API endpoint not found' });
    });

    return router;
}
