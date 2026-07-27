// src/lib/clientIp.js
// Client IP extraction for requests that do not pass through Express.

/**
 * Resolves the client IP for a raw Node request (e.g. a WebSocket upgrade),
 * which never gets Express's `req.ip`.
 *
 * Mirrors `app.set('trust proxy', 1)` from server.js: exactly one hop in front
 * of us is trusted, so the client address is the LAST entry in X-Forwarded-For.
 * Any earlier entries were supplied by the caller and must not be trusted —
 * reading the first entry instead lets a client choose its own rate-limit
 * bucket by sending a forged X-Forwarded-For.
 *
 * @param {import('http').IncomingMessage} req
 * @returns {string|undefined} The client IP, or undefined if it cannot be determined.
 */
export function getClientIp(req) {
    const forwarded = req.headers?.['x-forwarded-for'];
    if (typeof forwarded === 'string') {
        const hops = forwarded.split(',').map(hop => hop.trim()).filter(Boolean);
        if (hops.length > 0) {
            return hops[hops.length - 1];
        }
    }
    return req.socket?.remoteAddress;
}
