// src/lib/emotes/emoteCache.js
// L1 (in-memory Map) + L2 (Firestore) cache for emote descriptions.
// Responsibilities: init, get, set, invalidate, manual-override, query by name.
import { Firestore } from '@google-cloud/firestore';
import logger from '../logger.js';
import { DEFAULT_LOCALE } from '../../i18n/index.js';

const EMOTE_DESCRIPTIONS_COLLECTION = 'emoteDescriptions';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// L1 in-memory cache: cache key -> { description, cachedAt, manuallySet }
const descriptionCache = new Map();

/**
 * Cache key and Firestore document id for one emote in one language.
 *
 * English keeps the bare emote id, which is what every document written before
 * descriptions were localized already uses. That makes those documents correct
 * rather than stale — no backfill, and an English channel keeps every
 * description it had cached.
 */
function descriptionKey(emoteId, locale = DEFAULT_LOCALE) {
    return locale === DEFAULT_LOCALE ? emoteId : `${emoteId}:${locale}`;
}

/** The emote id back out of a cache key. Inverse of descriptionKey. */
function baseEmoteId(key) {
    const colon = key.lastIndexOf(':');
    return colon === -1 ? key : key.slice(0, colon);
}

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
 * @param {string} [locale] BCP-47 tag; descriptions are generated per language.
 * @returns {Promise<string | null>}
 */
export async function getCachedDescription(emoteId, locale = DEFAULT_LOCALE) {
    const key = descriptionKey(emoteId, locale);
    // L1: in-memory cache
    const cached = descriptionCache.get(key);
    if (cached && (Date.now() - cached.cachedAt) < CACHE_TTL_MS) {
        return cached.description;
    }
    if (cached) {
        descriptionCache.delete(key);
    }

    // L2: Firestore persistent cache
    if (emoteDescriptionsDb) {
        try {
            const doc = await emoteDescriptionsDb
                .collection(EMOTE_DESCRIPTIONS_COLLECTION)
                .doc(key)
                .get();
            if (doc.exists) {
                const data = doc.data();
                if (data.description) {
                    // Populate L1 from L2 hit, preserving manuallySet flag
                    descriptionCache.set(key, { description: data.description, cachedAt: Date.now(), manuallySet: data.manuallySet || false });
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
 * @param {string} [locale] BCP-47 tag the description was generated in.
 */
export function cacheDescription(emoteId, description, emoteName, ownerId, locale = DEFAULT_LOCALE) {
    const key = descriptionKey(emoteId, locale);
    // L1: in-memory (only update if not manually set)
    const existing = descriptionCache.get(key);
    if (existing?.manuallySet) {
        logger.debug({ emoteId, emoteName }, 'Skipping AI cache write — manual description in place');
        return;
    }
    descriptionCache.set(key, { description, cachedAt: Date.now(), manuallySet: false });

    // L2: Firestore fire-and-forget.
    // Note: payload omits `manuallySet` so that merge:true preserves any existing
    // manuallySet:true flag in Firestore (set via `!tts emote set`).
    if (emoteDescriptionsDb) {
        const data = { description, emoteName: emoteName || null, locale, updatedAt: Firestore.FieldValue.serverTimestamp() };
        if (ownerId !== undefined) data.ownerId = ownerId;
        emoteDescriptionsDb
            .collection(EMOTE_DESCRIPTIONS_COLLECTION)
            .doc(key)
            .set(data, { merge: true })
            .catch(error => logger.warn({ err: error.message, emoteId }, 'Firestore emote description write failed'));
    }
}

/**
 * Invalidate (delete) a cached emote description from both L1 and L2.
 * Used by the `!tts emote regenerate` command.
 * @param {string} emoteId
 * @returns {Promise<boolean>}
 * @param {string} [locale] - BCP-47 tag. Descriptions are stored and generated per language.
 */
export async function invalidateEmoteDescription(emoteId, locale = DEFAULT_LOCALE) {
    const key = descriptionKey(emoteId, locale);
    descriptionCache.delete(key);

    if (emoteDescriptionsDb) {
        try {
            await emoteDescriptionsDb
                .collection(EMOTE_DESCRIPTIONS_COLLECTION)
                .doc(key)
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
 * @param {string} [locale] - BCP-47 tag. Descriptions are stored and generated per language.
 */
export async function setEmoteDescription(emoteId, emoteName, description, ownerId, locale = DEFAULT_LOCALE) {
    const key = descriptionKey(emoteId, locale);
    descriptionCache.set(key, { description, cachedAt: Date.now(), manuallySet: true });

    if (emoteDescriptionsDb) {
        try {
            const data = { description, emoteName, manuallySet: true, locale, updatedAt: Firestore.FieldValue.serverTimestamp() };
            if (ownerId !== undefined) data.ownerId = ownerId;
            await emoteDescriptionsDb
                .collection(EMOTE_DESCRIPTIONS_COLLECTION)
                .doc(key)
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
 * @param {string} [locale] - BCP-47 tag. Descriptions are stored and generated per language.
 */
export async function getStoredEmoteDescription(emoteId, locale = DEFAULT_LOCALE) {
    if (!emoteDescriptionsDb) return null;
    try {
        const doc = await emoteDescriptionsDb
            .collection(EMOTE_DESCRIPTIONS_COLLECTION)
            .doc(descriptionKey(emoteId, locale))
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
 * @param {string} [locale] - BCP-47 tag. Descriptions are stored and generated per language.
 */
export async function findEmoteDescriptionsByName(emoteName, locale = DEFAULT_LOCALE) {
    if (!emoteDescriptionsDb) return [];
    try {
        // Locale is filtered in memory, not in the query: a document written
        // before descriptions were localized carries no `locale` field, so
        // where('locale','==','en') would skip every one of them. One emote name
        // matches a handful of rows, and this needs no composite index.
        const snapshot = await emoteDescriptionsDb
            .collection(EMOTE_DESCRIPTIONS_COLLECTION)
            .where('emoteName', '==', emoteName)
            .get();
        const results = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            if ((data.locale || DEFAULT_LOCALE) !== locale) return;
            results.push({
                // The base id, not the document id: a non-English document is
                // keyed "<emoteId>:<locale>", and returning that would make the
                // next write suffix it a second time.
                emoteId: baseEmoteId(doc.id),
                locale: data.locale || DEFAULT_LOCALE,
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
