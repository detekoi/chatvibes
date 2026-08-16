// src/components/web/apiRoutes.js
// All /api/* REST route handlers, JWT middleware, CORS, and rate limiting.

import { Router, json as expressJson } from 'express';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import logger from '../../lib/logger.js';
import config from '../../config/index.js';
import { isChannelAllowed } from '../../lib/allowList.js';
import { handleSecretCleanup } from './cleanupEndpoint.js';
import { extractBearerToken } from '../../lib/authUtils.js';

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
    // No custom keyGenerator: the default keys on req.ip, which Express derives
    // from X-Forwarded-For according to the `trust proxy` setting in server.js.
    // Reading the header directly would let a client pick its own bucket by
    // sending an X-Forwarded-For of its choosing.
});

// ---------------------------------------------------------------------------
// JWT middleware
// ---------------------------------------------------------------------------

/**
 * Channel-scoped JWT guard. Takes the channel from the JSON body's
 * channelLogin field and checks it against the token's userLogin claim.
 * Sets req.channelName and req.userLogin on success.
 */
async function verifyChannelAccessFromBody(req, res, next) {
    const requestedChannel = req.body?.channelLogin;
    const channelName = typeof requestedChannel === 'string' ? requestedChannel.toLowerCase() : undefined;

    if (!channelName) {
        return res.status(400).json({ success: false, error: 'Channel name not found in request' });
    }

    if (!isChannelAllowed(channelName)) {
        return res.status(403).json({ success: false, error: 'Forbidden: Channel is not allowed to use this service' });
    }

    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
        return res.status(401).json({ success: false, error: 'Authorization token is required or missing' });
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

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleEventSubSetup(req, res) {
    // channelLogin was verified against the token by verifyChannelAccessFromBody.
    const channelLogin = req.channelName;

    logger.info({ channelLogin }, 'Setting up EventSub subscriptions');

    try {
        // Resolve the broadcaster ID from the verified login rather than trusting
        // a userId in the body, which would let a caller target another channel.
        // Force refresh to prevent a stale cached ID if the user recently renamed their account.
        const { getBroadcasterIdByLogin } = await import('../twitch/helixClient.js');
        const userId = await getBroadcasterIdByLogin(channelLogin, true);

        if (!userId) {
            return res.status(404).json({ success: false, error: 'Could not resolve Twitch user for this channel' });
        }

        const { subscribeChannelToTtsEvents } = await import('../twitch/twitchSubs.js');
        const result = await subscribeChannelToTtsEvents(userId, {
            subscribe: true,
            resubscribe: true,
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

    // Channel taken from the body's channelLogin and checked against the token.
    // Called server-to-server by the web UI's auth flow.
    router.post('/setup-eventsub', verifyChannelAccessFromBody, handleEventSubSetup);

    // Invoked by Cloud Scheduler.
    router.post('/admin/secret-cleanup', handleSecretCleanup);

    // ── Catch-all 404 ─────────────────────────────────────────────────────
    router.use((_req, res) => {
        res.status(404).json({ success: false, error: 'API endpoint not found' });
    });

    return router;
}
