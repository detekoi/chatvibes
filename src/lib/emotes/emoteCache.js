// src/lib/emotes/emoteCache.js
// L1 (in-memory Map) + L2 (Firestore) cache for emote descriptions.
// Responsibilities: init, get, set, invalidate, manual-override, query by name.
import { Firestore } from '@google-cloud/firestore';
import logger from '../logger.js';

const EMOTE_DESCRIPTIONS_COLLECTION = 'emoteDescriptions';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// L1 in-memory cache: emoteId -> { description, cachedAt, manuallySet }
const descriptionCache = new Map();

// L2 Firestore client (null until initEmoteDescriptionStore() is called)
let emoteDescriptionsDb = null;

/**
 * Initialize the Firestore client for persistent emote description storage.
 * Call once during bot startup.
 * @returns {boolean}
 */
export function initEmoteDescriptionStore() {
    try {
        emoteDescriptionsDb = new Firestore();
        logger.info('Emote description Firestore store initialized');
        return true;
    } catch (error) {
        logger.error({ err: error }, 'Failed to initialize emote description Firestore store');
        return false;
    }
}

/**
 * Check L1 then L2 for a cached description.
 * @param {string} emoteId
 * @returns {Promise<string | null>}
 */
export async function getCachedDescription(emoteId) {
    // L1: in-memory cache
    const cached = descriptionCache.get(emoteId);
    if (cached && (Date.now() - cached.cachedAt) < CACHE_TTL_MS) {
        return cached.description;
    }
    if (cached) {
        descriptionCache.delete(emoteId);
    }

    // L2: Firestore persistent cache
    if (emoteDescriptionsDb) {
        try {
            const doc = await emoteDescriptionsDb
                .collection(EMOTE_DESCRIPTIONS_COLLECTION)
                .doc(emoteId)
                .get();
            if (doc.exists) {
                const data = doc.data();
                if (data.description) {
                    // Populate L1 from L2 hit, preserving manuallySet flag
                    descriptionCache.set(emoteId, { description: data.description, cachedAt: Date.now(), manuallySet: data.manuallySet || false });
                    logger.debug({ emoteId, emoteName: data.emoteName, manuallySet: data.manuallySet || false }, 'Emote description loaded from Firestore cache');
                    return data.description;
                }
            }
        } catch (error) {
            logger.warn({ err: error.message, emoteId }, 'Firestore emote description lookup failed, falling through to Gemini');
        }
    }

    return null;
}

/**
 * Cache a description in L1 and fire-and-forget to L2 (Firestore).
 * Skips the write if a manual description is already in the L1 hot cache.
 * @param {string} emoteId
 * @param {string} description
 * @param {string} [emoteName]
 * @param {string} [ownerId]
 */
export function cacheDescription(emoteId, description, emoteName, ownerId) {
    // L1: in-memory (only update if not manually set)
    const existing = descriptionCache.get(emoteId);
    if (existing?.manuallySet) {
        logger.debug({ emoteId, emoteName }, 'Skipping AI cache write — manual description in place');
        return;
    }
    descriptionCache.set(emoteId, { description, cachedAt: Date.now(), manuallySet: false });

    // L2: Firestore fire-and-forget.
    // Note: payload omits `manuallySet` so that merge:true preserves any existing
    // manuallySet:true flag in Firestore (set via `!tts emote set`).
    if (emoteDescriptionsDb) {
        const data = { description, emoteName: emoteName || null, updatedAt: Firestore.FieldValue.serverTimestamp() };
        if (ownerId !== undefined) data.ownerId = ownerId;
        emoteDescriptionsDb
            .collection(EMOTE_DESCRIPTIONS_COLLECTION)
            .doc(emoteId)
            .set(data, { merge: true })
            .catch(error => logger.warn({ err: error.message, emoteId }, 'Firestore emote description write failed'));
    }
}

/**
 * Invalidate (delete) a cached emote description from both L1 and L2.
 * Used by the `!tts emote regenerate` command.
 * @param {string} emoteId
 * @returns {Promise<boolean>}
 */
export async function invalidateEmoteDescription(emoteId) {
    descriptionCache.delete(emoteId);

    if (emoteDescriptionsDb) {
        try {
            await emoteDescriptionsDb
                .collection(EMOTE_DESCRIPTIONS_COLLECTION)
                .doc(emoteId)
                .delete();
            logger.info({ emoteId }, 'Emote description invalidated from Firestore');
            return true;
        } catch (error) {
            logger.error({ err: error.message, emoteId }, 'Failed to invalidate emote description from Firestore');
            return false;
        }
    }
    return true;
}

/**
 * Manually set an emote description in both L1 and L2.
 * Marks as manuallySet so AI will not overwrite it.
 * Used by the `!tts emote set` command.
 * @param {string} emoteId
 * @param {string} emoteName
 * @param {string} description
 * @param {string} [ownerId]
 * @returns {Promise<boolean>}
 */
export async function setEmoteDescription(emoteId, emoteName, description, ownerId) {
    descriptionCache.set(emoteId, { description, cachedAt: Date.now(), manuallySet: true });

    if (emoteDescriptionsDb) {
        try {
            const data = { description, emoteName, manuallySet: true, updatedAt: Firestore.FieldValue.serverTimestamp() };
            if (ownerId !== undefined) data.ownerId = ownerId;
            await emoteDescriptionsDb
                .collection(EMOTE_DESCRIPTIONS_COLLECTION)
                .doc(emoteId)
                .set(data, { merge: true });
            logger.info({ emoteId, emoteName, description }, 'Emote description manually set in Firestore');
            return true;
        } catch (error) {
            logger.error({ err: error.message, emoteId }, 'Failed to set emote description in Firestore');
            return false;
        }
    }
    return true;
}

/**
 * Get a stored emote description from Firestore by emote ID.
 * @param {string} emoteId
 * @returns {Promise<{description: string, emoteName: string, updatedAt: Date} | null>}
 */
export async function getStoredEmoteDescription(emoteId) {
    if (!emoteDescriptionsDb) return null;
    try {
        const doc = await emoteDescriptionsDb
            .collection(EMOTE_DESCRIPTIONS_COLLECTION)
            .doc(emoteId)
            .get();
        if (doc.exists) {
            const data = doc.data();
            return {
                description: data.description,
                emoteName: data.emoteName || null,
                updatedAt: data.updatedAt?.toDate() || null,
            };
        }
        return null;
    } catch (error) {
        logger.debug({ err: error.message, emoteId }, 'Failed to read emote description from Firestore');
        return null;
    }
}

/**
 * Find emote descriptions by emote name (exact match).
 * @param {string} emoteName
 * @returns {Promise<Array<{emoteId: string, description: string, emoteName: string, ownerId: string|null}>>}
 */
export async function findEmoteDescriptionsByName(emoteName) {
    if (!emoteDescriptionsDb) return [];
    try {
        const snapshot = await emoteDescriptionsDb
            .collection(EMOTE_DESCRIPTIONS_COLLECTION)
            .where('emoteName', '==', emoteName)
            .get();
        const results = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            results.push({
                emoteId: doc.id,
                description: data.description,
                emoteName: data.emoteName,
                ownerId: data.ownerId || null,
            });
        });
        return results;
    } catch (error) {
        logger.debug({ err: error.message, emoteName }, 'Firestore emote name search failed');
        return [];
    }
}

// Exported for testing
export { descriptionCache as _descriptionCache };
