// src/lib/authUtils.js
// Utility functions for authentication and token handling.

/**
 * Extracts a Bearer token from the Authorization header securely.
 * @param {string} authHeader - The Authorization header string.
 * @returns {string|null} The token, or null if missing/malformed.
 */
export function extractBearerToken(authHeader) {
    if (!authHeader || typeof authHeader !== 'string') {
        return null;
    }
    
    if (!authHeader.startsWith('Bearer ')) {
        return null;
    }
    
    const token = authHeader.slice('Bearer '.length).trim();
    return token || null;
}
