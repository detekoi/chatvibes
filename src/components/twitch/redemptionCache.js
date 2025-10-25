// src/components/twitch/redemptionCache.js
// In-memory cache for tracking pending Channel Points redemptions

import logger from '../../lib/logger.js';

// Map structure: redemption_id -> { userInput, userName, timestamp, channelName }
const redemptionCache = new Map();

// TTL for cache entries (24 hours in milliseconds)
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Add a redemption to the cache
 * @param {string} redemptionId - The Twitch redemption ID
 * @param {string} userInput - The user's input text
 * @param {string} userName - The username who redeemed
 * @param {string} channelName - The channel where redemption occurred
 */
export function addRedemption(redemptionId, userInput, userName, channelName) {
    const entry = {
        userInput,
        userName,
        channelName,
        timestamp: Date.now()
    };
    
    redemptionCache.set(redemptionId, entry);
    
    logger.debug({
        redemptionId,
        userName,
        channelName,
        textPreview: userInput?.substring(0, 30)
    }, 'Added redemption to cache');
}

/**
 * Get a redemption from the cache
 * @param {string} redemptionId - The Twitch redemption ID
 * @returns {object|null} The cached redemption data or null if not found
 */
export function getRedemption(redemptionId) {
    return redemptionCache.get(redemptionId) || null;
}

/**
 * Remove a redemption from the cache
 * @param {string} redemptionId - The Twitch redemption ID
 * @returns {boolean} True if the redemption was found and removed
 */
export function removeRedemption(redemptionId) {
    const existed = redemptionCache.has(redemptionId);
    redemptionCache.delete(redemptionId);
    
    if (existed) {
        logger.debug({ redemptionId }, 'Removed redemption from cache');
    }
    
    return existed;
}

/**
 * Clean up old entries from the cache to prevent memory leaks
 * Removes entries older than CACHE_TTL_MS
 */
export function pruneOldEntries() {
    const now = Date.now();
    let prunedCount = 0;
    
    for (const [redemptionId, entry] of redemptionCache.entries()) {
        if (now - entry.timestamp > CACHE_TTL_MS) {
            redemptionCache.delete(redemptionId);
            prunedCount++;
        }
    }
    
    if (prunedCount > 0) {
        logger.info({ prunedCount, remainingEntries: redemptionCache.size }, 'Pruned old redemption cache entries');
    }
}

/**
 * Get the current size of the cache
 * @returns {number} The number of entries in the cache
 */
export function getCacheSize() {
    return redemptionCache.size;
}

/**
 * Clear all entries from the cache
 * Useful for testing or manual cleanup
 */
export function clearCache() {
    const size = redemptionCache.size;
    redemptionCache.clear();
    logger.info({ clearedEntries: size }, 'Cleared redemption cache');
}

// Set up periodic pruning every 6 hours
// Using setInterval with unref() to prevent blocking graceful shutdown
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const pruneInterval = setInterval(pruneOldEntries, PRUNE_INTERVAL_MS);
pruneInterval.unref();

logger.info('Redemption cache initialized with automatic pruning every 6 hours');

