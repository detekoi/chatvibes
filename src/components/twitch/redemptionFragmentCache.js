// src/components/twitch/redemptionFragmentCache.js
// Short-lived in-memory cache to correlate chat message fragments with channel point redemptions.
//
// MULTI-INSTANCE NOTE: This cache is local to a single Cloud Run instance, same
// as redemptionCache.js. When the channel.chat.message and channel.channel_points_
// custom_reward_redemption.add EventSub webhooks hit different instances, the
// fragment lookup will miss and we fall back to raw text (pre-fix behavior).
// Cloud Run's default connection reuse means correlated requests usually land on
// the same instance, making this work in practice for most redemptions.
//
// KEY COLLISION NOTE: The composite key {rewardId:userId:channelLogin} does not
// include a per-redemption ID (the chat event doesn't carry one). If the same
// user redeems the same reward twice within TTL, the second write overwrites
// the first. This is acceptable because Twitch rewards typically have cooldowns
// that exceed the TTL, and the worst case is a single redemption falling back to
// raw text.

import logger from '../../lib/logger.js';

// Map structure: "rewardId:userId:channelLogin" -> { fragments, text, timestamp }
const fragmentCache = new Map();

// Short TTL for correlating two near-simultaneous EventSub events
const CACHE_TTL_MS = 10 * 1000; // 10 seconds

/**
 * Generate a deterministic composite key for the cache
 * @param {string} rewardId - The custom reward ID
 * @param {string} userId - The Twitch User ID of the redeemer
 * @param {string} channelLogin - The channel login name
 * @returns {string} The composite cache key
 */
function getCacheKey(rewardId, userId, channelLogin) {
    if (!rewardId || !userId || !channelLogin) return null;
    return `${rewardId}:${userId}:${channelLogin.toLowerCase()}`;
}

/**
 * Store fragments from a chat message event
 * @param {string} rewardId - The custom reward ID
 * @param {string} userId - The Twitch User ID of the redeemer
 * @param {string} channelLogin - The channel login name
 * @param {Array} fragments - The message fragments array
 * @param {string} text - The original message text (for debugging/verification)
 */
export function storeFragments(rewardId, userId, channelLogin, fragments, text) {
    const key = getCacheKey(rewardId, userId, channelLogin);
    if (!key) return;

    fragmentCache.set(key, {
        fragments,
        text,
        timestamp: Date.now()
    });

    logger.debug({ 
        rewardId, 
        userId, 
        channelLogin, 
        fragmentsCount: fragments?.length 
    }, 'Stored fragments for pending redemption');
}

/**
 * Retrieve and consume fragments for a redemption
 * @param {string} rewardId - The custom reward ID
 * @param {string} userId - The Twitch User ID of the redeemer
 * @param {string} channelLogin - The channel login name
 * @returns {Array|null} The message fragments, or null if not found
 */
export function consumeFragments(rewardId, userId, channelLogin) {
    const key = getCacheKey(rewardId, userId, channelLogin);
    if (!key) return null;

    const entry = fragmentCache.get(key);
    if (!entry) return null;

    // Check if expired
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
        fragmentCache.delete(key);
        return null;
    }

    // It's a single-use cache, remove after reading
    fragmentCache.delete(key);
    
    logger.debug({ 
        rewardId, 
        userId, 
        channelLogin 
    }, 'Consumed cached fragments for redemption');

    return entry.fragments;
}

/**
 * Clean up old entries from the cache to prevent memory leaks
 */
export function pruneOldEntries() {
    const now = Date.now();
    let prunedCount = 0;
    
    for (const [key, entry] of fragmentCache.entries()) {
        if (now - entry.timestamp > CACHE_TTL_MS) {
            fragmentCache.delete(key);
            prunedCount++;
        }
    }
    
    if (prunedCount > 0) {
        logger.debug({ prunedCount, remainingEntries: fragmentCache.size }, 'Pruned old redemption fragment cache entries');
    }
}

/**
 * Get the current size of the cache
 */
export function getCacheSize() {
    return fragmentCache.size;
}

/**
 * Clear all entries from the cache
 */
export function clearCache() {
    fragmentCache.clear();
}

// Periodic pruning (e.g. every minute)
const PRUNE_INTERVAL_MS = 60 * 1000;
const pruneInterval = setInterval(pruneOldEntries, PRUNE_INTERVAL_MS);
pruneInterval.unref();
