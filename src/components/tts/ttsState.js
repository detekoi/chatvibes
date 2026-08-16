// src/components/tts/ttsState.js
import { Firestore, FieldValue, FieldPath } from '@google-cloud/firestore';
import logger from '../../lib/logger.js';
import {
    DEFAULT_TTS_SETTINGS,
    VALID_EMOTIONS,
    VALID_LANGUAGE_BOOSTS,
    TTS_PITCH_MIN,
    TTS_PITCH_MAX,
    TTS_PITCH_DEFAULT,
    TTS_SPEED_MIN,
    TTS_SPEED_MAX,
    TTS_SPEED_DEFAULT
} from './ttsConstants.js';
import { getAvailableVoices } from './ttsService.js'; // For validating voice IDs
import { getChannelIdFromName } from '../../lib/allowList.js';

let db;
const TTS_CONFIG_COLLECTION = 'ttsChannelConfigs';
const USER_PREFS_COLLECTION = 'ttsUserPreferences';

// In-memory cache of channel configs
const channelConfigsCache = new Map();
let firestoreListenerUnsubscribe = null;

// YouTube config change listeners
const youtubeConfigChangeListeners = [];

// In-memory cache for global user preferences: key -> { data, cachedAt }
const globalUserPrefsCache = new Map();
const GLOBAL_PREFS_CACHE_TTL_MS = 60 * 1000; // 60 seconds

// The 60s TTL is the staleness bound for dashboard edits and cannot simply be
// raised: the web UI is a separate Firebase Functions app that writes this
// collection directly, so it has no way to invalidate this cache. Bot-side writes
// go through setGlobalUserPreference, which deletes the entry outright.
//
// This cache is keyed by chatter, so on a busy channel it would otherwise grow for
// the lifetime of the process — entries expire on read but a chatter who never
// speaks again is never read, and so never evicted.
const USER_CACHE_MAX_ENTRIES = 5000;

/**
 * Stores an entry, keeping the cache bounded. Expired entries are dropped
 * first; if that is not enough, the oldest entries go (Map preserves insertion
 * order, and entries are only ever inserted, so the first key is the oldest).
 * @param {Map} cache - The cache to write to
 * @param {string} key - Cache key
 * @param {object} value - Entry with a cachedAt timestamp
 * @param {number} ttlMs - Entry lifetime in milliseconds
 */
function setBoundedCacheEntry(cache, key, value, ttlMs) {
    if (cache.size >= USER_CACHE_MAX_ENTRIES && !cache.has(key)) {
        const now = Date.now();
        for (const [k, v] of cache) {
            if (now - v.cachedAt >= ttlMs) cache.delete(k);
        }
        while (cache.size >= USER_CACHE_MAX_ENTRIES) {
            const oldest = cache.keys().next();
            if (oldest.done) break;
            cache.delete(oldest.value);
        }
    }
    cache.set(key, value);
}

/**
 * Resolves a channel identifier (name or numeric ID) to its immutable Twitch User ID.
 * If the identifier is already numeric, it is returned as-is.
 * Otherwise, the in-memory allowList cache is consulted.
 * Falls back to the original string if no mapping is found.
 * @param {string} identifier - Channel name or numeric User ID
 * @returns {string|null}
 */
function resolveChannelId(identifier) {
    if (!identifier) return null;
    // Already a numeric Twitch User ID — return directly
    if (/^\d+$/.test(identifier)) return String(identifier);
    // Look up the channel name in the allowList cache
    return getChannelIdFromName(identifier) || String(identifier);
}

export async function initializeTtsState() {
    if (!db) db = new Firestore();
    logger.info('Initializing TTS State from Firestore...');
    try {
        const snapshot = await db.collection(TTS_CONFIG_COLLECTION).get();
        snapshot.forEach(doc => {
            // Ensure userPreferences field exists
            const data = doc.data();
            // Migration: Convert old botMode to botRespondsInChat
            let botRespondsInChat = data.botRespondsInChat;
            if (botRespondsInChat === undefined && data.botMode !== undefined) {
                // Migrate from old botMode: 'authenticated' -> true, others -> false
                botRespondsInChat = data.botMode === 'authenticated';
            }
            channelConfigsCache.set(doc.id, {
                ...DEFAULT_TTS_SETTINGS,
                ...data,
                botRespondsInChat: botRespondsInChat !== undefined ? botRespondsInChat : false,
                userPreferences: data.userPreferences || {} // Initialize if missing
            });
        });
        logger.info(`Loaded TTS configs for ${channelConfigsCache.size} channels.`);
        _setupFirestoreListener(); // Ensure this is called
    } catch (error) {
        logger.error({ err: error }, 'Failed to initialize TTS state from Firestore.');
    }
}

function _setupFirestoreListener() {
    if (firestoreListenerUnsubscribe) firestoreListenerUnsubscribe();

    firestoreListenerUnsubscribe = db.collection(TTS_CONFIG_COLLECTION)
        .onSnapshot(snapshot => {
            logger.debug('TTS config snapshot received from Firestore listener.');
            snapshot.docChanges().forEach(change => {
                const docId = change.doc.id; // Post-migration: this is the numeric Twitch User ID
                const data = change.doc.data();
                if (change.type === 'added' || change.type === 'modified') {
                    logger.info(`TTS config for ${docId} ${change.type}. Updating cache.`);
                    // Migration: Convert old botMode to botRespondsInChat
                    let botRespondsInChat = data.botRespondsInChat;
                    if (botRespondsInChat === undefined && data.botMode !== undefined) {
                        // Migrate from old botMode: 'authenticated' -> true, others -> false
                        botRespondsInChat = data.botMode === 'authenticated';
                    }
                    const previousConfig = channelConfigsCache.get(docId);
                    const newConfig = {
                        ...DEFAULT_TTS_SETTINGS,
                        ...data,
                        botRespondsInChat: botRespondsInChat !== undefined ? botRespondsInChat : false,
                        userPreferences: data.userPreferences || {} // Ensure userPreferences exists
                    };
                    channelConfigsCache.set(docId, newConfig);

                    // Notify YouTube config change listeners on real config modifications only.
                    // Initial 'added' events from the Firestore snapshot are handled by the
                    // explicit startup scan in initializeYouTubeChat — firing here too would
                    // race and cause duplicate connect/disconnect cycles.
                    if (change.type === 'modified' &&
                        (previousConfig?.youtubeEnabled !== newConfig.youtubeEnabled ||
                        previousConfig?.youtubeHandle !== newConfig.youtubeHandle)) {
                        for (const listener of youtubeConfigChangeListeners) {
                            try {
                                listener(docId, newConfig);
                            } catch (err) {
                                logger.error({ err, channelId: docId }, 'Error in YouTube config change listener');
                            }
                        }
                    }
                } else if (change.type === 'removed') {
                    logger.info(`TTS config for ${docId} removed. Removing from cache.`);
                    // Notify YouTube listeners about removal (youtubeEnabled = false)
                    for (const listener of youtubeConfigChangeListeners) {
                        try {
                            listener(docId, { youtubeEnabled: false });
                        } catch (err) {
                            logger.error({ err, channelId: docId }, 'Error in YouTube config change listener (removal)');
                        }
                    }
                    channelConfigsCache.delete(docId);
                }
            });
        }, err => {
            logger.error({ err }, 'TTS config Firestore listener error.');
        });
}

export async function getTtsState(channelName) {
    const channelId = resolveChannelId(channelName);
    if (channelConfigsCache.has(channelId)) {
        // Ensure userPreferences is part of the returned object
        const cachedConfig = channelConfigsCache.get(channelId);
        return { ...cachedConfig, userPreferences: cachedConfig.userPreferences || {} };
    }
    try {
        const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelId);
        const docSnap = await docRef.get();
        if (docSnap.exists) {
            const data = docSnap.data();
            // Migration: Convert old botMode to botRespondsInChat
            let botRespondsInChat = data.botRespondsInChat;
            if (botRespondsInChat === undefined && data.botMode !== undefined) {
                // Migrate from old botMode: 'authenticated' -> true, others -> false
                botRespondsInChat = data.botMode === 'authenticated';
            }
            const config = {
                ...DEFAULT_TTS_SETTINGS,
                ...data,
                botRespondsInChat: botRespondsInChat !== undefined ? botRespondsInChat : false,
                userPreferences: data.userPreferences || {}
            };
            channelConfigsCache.set(channelId, config);
            return config;
        }
    } catch (error) {
        logger.error({ err: error, channel: channelName }, `Error fetching TTS state for ${channelName} from Firestore.`);
        // A failed read is not evidence the channel is new. Caching defaults here
        // would leave the channel on them until the collection listener next
        // delivers the doc — long enough to speak a message with the wrong
        // settings, and profanityFilterEnabled defaults to off. Serve defaults for
        // this call only and leave the cache for the listener to fill.
        return { ...DEFAULT_TTS_SETTINGS, userPreferences: {} };
    }
    // No document exists - this is a new channel, use defaults (botRespondsInChat: false)
    const defaultConfigCopy = { ...DEFAULT_TTS_SETTINGS, userPreferences: {} };
    channelConfigsCache.set(channelId, defaultConfigCopy);
    return defaultConfigCopy;
}

export async function getChannelTtsConfig(channelName) {
    const fullState = await getTtsState(channelName);
    // Extract only TTS parameters
    const { voiceId, speed, volume, pitch, emotion, englishNormalization, sampleRate, bitrate, channel, languageBoost, voiceVolumes } = fullState;
    return { voiceId, speed, volume, pitch, emotion, languageBoost, englishNormalization, sampleRate, bitrate, channel, voiceVolumes: voiceVolumes || {} };
}

export async function setTtsState(channelName, key, value) {
    const channelId = resolveChannelId(channelName);
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelId);
    try {
        await docRef.set({ [key]: value, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        logger.info(`[${channelName}] TTS state updated: ${key} = ${value}`);
        // Update cache immediately (Firestore listener will also update, but this is faster)
        const currentConfig = channelConfigsCache.get(channelId) || { ...DEFAULT_TTS_SETTINGS };
        channelConfigsCache.set(channelId, { ...currentConfig, [key]: value });
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName, key, value }, 'Failed to set TTS state in Firestore.');
        return false;
    }
}

// --- Global (cross-channel) user preferences ---
export async function getGlobalUserPreferences(username, userId) {
    if (!db) db = new Firestore();
    // Use userId as primary cache key, fall back to username
    const lowerUser = username ? username.toLowerCase() : null;
    const cacheKey = userId || lowerUser;
    if (!cacheKey) return {};
    const cached = globalUserPrefsCache.get(cacheKey);
    if (cached && (Date.now() - cached.cachedAt) < GLOBAL_PREFS_CACHE_TTL_MS) {
        return cached.data;
    }
    try {
        // Try userId first (primary, immutable identifier)
        if (userId) {
            const userIdDoc = await db.collection(USER_PREFS_COLLECTION).doc(userId).get();
            if (userIdDoc.exists) {
                const data = userIdDoc.data() || {};
                setBoundedCacheEntry(globalUserPrefsCache, cacheKey, { data, cachedAt: Date.now() }, GLOBAL_PREFS_CACHE_TTL_MS);
                return data;
            }
        }
        // Fallback to username. Callers may pass a userId with no username, so this
        // leg is skipped rather than assumed — getUserEmoteModePreference delegates
        // here and has always accepted one identifier without the other.
        if (lowerUser) {
            const docRef = db.collection(USER_PREFS_COLLECTION).doc(lowerUser);
            const docSnap = await docRef.get();
            if (docSnap.exists) {
                const data = docSnap.data() || {};
                setBoundedCacheEntry(globalUserPrefsCache, cacheKey, { data, cachedAt: Date.now() }, GLOBAL_PREFS_CACHE_TTL_MS);
                return data;
            }
        }
        // Cache the empty result too to avoid repeated Firestore misses
        setBoundedCacheEntry(globalUserPrefsCache, cacheKey, { data: {}, cachedAt: Date.now() }, GLOBAL_PREFS_CACHE_TTL_MS);
        return {};
    } catch (error) {
        logger.error({ err: error, user: username, userId }, 'Failed to get user preferences from Firestore.');
        return {};
    }
}

export async function setGlobalUserPreference(username, key, value, userId) {
    if (!db) db = new Firestore();
    // Use userId as primary key (immutable), fall back to username for legacy callers
    const docKey = userId || username.toLowerCase();
    const docRef = db.collection(USER_PREFS_COLLECTION).doc(docKey);
    try {
        const writeData = { [key]: value, updatedAt: FieldValue.serverTimestamp() };
        // Store username as metadata for debugging/display purposes
        if (userId && username) writeData.username = username.toLowerCase();
        await docRef.set(writeData, { merge: true });
        logger.info(`Global user preference updated for ${docKey}: ${key} = ${value}`);
        // Invalidate cache so next read picks up the new value
        globalUserPrefsCache.delete(docKey);
        return true;
    } catch (error) {
        logger.error({ err: error, user: docKey, userId, key, value }, 'Failed to set user preference in Firestore.');
        return false;
    }
}

export async function clearGlobalUserPreference(username, key, userId) {
    if (!db) db = new Firestore();
    // Use userId as primary key (immutable), fall back to username for legacy callers
    const docKey = userId || username.toLowerCase();
    const docRef = db.collection(USER_PREFS_COLLECTION).doc(docKey);
    try {
        await docRef.update({ [key]: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
        logger.info(`Cleared global user preference '${key}' for ${docKey}.`);
        // Invalidate cache
        globalUserPrefsCache.delete(docKey);
        return true;
    } catch (error) {
        if (error.code === 5) {
            logger.debug(`No specific preference '${key}' to clear for user ${docKey}.`);
            return true;
        }
        logger.error({ err: error, user: docKey, userId, key }, `Failed to clear user preference '${key}'.`);
        return false;
    }
}

/**
 * Valid emote mode values.
 * - 'read': Read raw emote names aloud
 * - 'skip': Filter out emotes from TTS
 * - 'describe': Use AI to describe emotes visually
 */
export const VALID_EMOTE_MODES = ['read', 'skip', 'describe'];

/**
 * Gets the user's emoteMode preference from global preferences.
 * Uses userId as primary key with username as fallback for backward compatibility.
 * @param {string} username - The username (used as fallback)
 * @param {string} userId - The Twitch User ID (primary key)
 * @returns {Promise<string|null>} - 'read' | 'skip' | 'describe' | null (allows channel default fallback)
 */
export async function getUserEmoteModePreference(username, userId) {
    if (!username && !userId) return null;
    try {
        // emoteMode lives on the same ttsUserPreferences document as every other
        // global preference, so this delegates rather than reading it a second time.
        // It used to keep its own cache and its own userId-then-username lookup,
        // which meant a cold cache cost up to four document reads of one document —
        // two here, two more when the queue resolved the rest of the preferences.
        // Sharing the cache also means a write through setGlobalUserPreference now
        // invalidates emoteMode; the separate cache was never invalidated on write,
        // so a change was ignored for up to a minute.
        const prefs = await getGlobalUserPreferences(username, userId);
        const mode = prefs?.emoteMode;
        return mode !== undefined && VALID_EMOTE_MODES.includes(mode) ? mode : null;
    } catch (error) {
        logger.error({ err: error, user: username, userId }, 'Failed to get emoteMode preference.');
        return null; // No preference set, allows channel default fallback
    }
}

/**

 * Sets the OBS WebSocket token secret name for a channel.
 * @param {string} channelName - The name of the channel.
 * @param {string} secretName - The full resource name of the secret in Secret Manager.
 * @returns {Promise<boolean>}
 */
export async function setObsSocketSecretName(channelName, secretName) {
    const channelId = resolveChannelId(channelName);
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelId);
    try {
        await docRef.set({
            obsSocketSecretName: secretName,
            updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        logger.info(`[${channelName}] OBS WebSocket secret name has been set.`);
        // Update cache
        const currentConfig = await getTtsState(channelId);
        channelConfigsCache.set(channelId, { ...currentConfig, obsSocketSecretName: secretName });
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName }, 'Failed to set OBS socket secret name in Firestore.');
        return false;
    }
}

/**
 * Sets the OBS WebSocket token directly in Firestore for a channel.
 * @param {string} channelName - The name of the channel.
 * @param {string} token - The token string.
 * @returns {Promise<boolean>}
 */
export async function setObsSocketToken(channelName, token) {
    const channelId = resolveChannelId(channelName);
    if (!db) db = new Firestore();
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelId);
    try {
        await docRef.set({
            obsSocketToken: token,
            updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        logger.info(`[${channelName}] OBS WebSocket token has been set (Firestore).`);
        // Update cache
        const currentConfig = await getTtsState(channelId);
        channelConfigsCache.set(channelId, { ...currentConfig, obsSocketToken: token });
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName }, 'Failed to set OBS socket token in Firestore.');
        return false;
    }
}
// --- TTS ignore list (keyed by immutable platform account ID) ---
//
// Stored as a map field rather than an array, so arrayUnion/arrayRemove do not
// apply — the same shape and the same write mechanics as `pronunciations` below.
// See src/lib/ignoreList.js for the key format.

/**
 * Add one account to the channel's ignore list.
 * @param {string} channelName
 * @param {string} key Built by ignoreKey(platform, accountId).
 * @param {string} label Display name, shown by !tts ignored and the dashboard.
 * @returns {Promise<boolean>}
 */
export async function addIgnoredUser(channelName, key, label) {
    const channelId = resolveChannelId(channelName);
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelId);
    try {
        // merge:true deep-merges nested maps key by key, so this touches only
        // the one entry and leaves the rest of the list alone.
        await docRef.set({
            ignoredUserIds: { [key]: label },
            updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });

        const config = await getTtsState(channelId);
        // A fresh object rather than a mutation, so a caller holding the
        // previous config does not observe the change behind its back.
        config.ignoredUserIds = { ...(config.ignoredUserIds || {}), [key]: label };
        channelConfigsCache.set(channelId, config);
        logger.info(`[${channelName}] TTS ignore added: ${key} ("${label}")`);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName, key }, 'Failed to add user to TTS ignore list in Firestore.');
        return false;
    }
}

/**
 * Remove one account from the channel's ignore list.
 * @param {string} channelName
 * @param {string} key Built by ignoreKey(platform, accountId).
 * @returns {Promise<boolean>}
 */
export async function removeIgnoredUser(channelName, key) {
    const channelId = resolveChannelId(channelName);
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelId);
    try {
        // FieldPath segments are taken literally. A dotted string would be
        // parsed as a path instead, and these keys contain a colon separator
        // that would need backtick quoting in that form.
        await docRef.update(new FieldPath('ignoredUserIds', key), FieldValue.delete(),
            'updatedAt', FieldValue.serverTimestamp());

        const config = await getTtsState(channelId);
        const next = { ...(config.ignoredUserIds || {}) };
        delete next[key];
        config.ignoredUserIds = next;
        channelConfigsCache.set(channelId, config);
        logger.info(`[${channelName}] TTS ignore removed: ${key}`);
        return true;
    } catch (error) {
        // 5 is NOT_FOUND: the entry was already gone, which is the desired end state.
        if (error.code === 5) return true;
        logger.error({ err: error, channel: channelName, key }, 'Failed to remove user from TTS ignore list in Firestore.');
        return false;
    }
}

// --- Pronunciation dictionary (channel overrides for the built-in acronyms) ---
//
// Stored as a map field rather than an array, so arrayUnion/arrayRemove do not
// apply. Writes deep-merge a single key; deletes go through a FieldPath.

/**
 * Add or update one channel pronunciation.
 * Pass an empty string as `say` to switch off a built-in of the same name.
 * @param {string} channelName
 * @param {string} match Already normalized by normalizeMatchKey.
 * @param {string} say
 * @returns {Promise<boolean>}
 */
export async function setPronunciation(channelName, match, say) {
    const channelId = resolveChannelId(channelName);
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelId);
    try {
        // merge:true deep-merges nested maps key by key, so this touches only
        // the one entry and leaves the rest of the dictionary alone.
        await docRef.set({
            pronunciations: { [match]: say },
            updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });

        const config = await getTtsState(channelId);
        // A fresh object, not a mutation: getPronunciationRules memoizes on the
        // identity of this map, so mutating in place would serve stale rules.
        config.pronunciations = { ...(config.pronunciations || {}), [match]: say };
        channelConfigsCache.set(channelId, config);
        logger.info(`[${channelName}] Pronunciation set: "${match}" -> "${say}"`);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName, match }, 'Failed to set pronunciation in Firestore.');
        return false;
    }
}

/**
 * Remove one channel pronunciation. A built-in of the same name comes back.
 * @param {string} channelName
 * @param {string} match Already normalized by normalizeMatchKey.
 * @returns {Promise<boolean>}
 */
export async function removePronunciation(channelName, match) {
    const channelId = resolveChannelId(channelName);
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelId);
    try {
        // FieldPath segments are taken literally. A dotted string would be
        // parsed instead, so a key containing a space or hyphen would need
        // backtick quoting and one containing a dot would target the wrong
        // nesting entirely.
        await docRef.update(new FieldPath('pronunciations', match), FieldValue.delete(),
            'updatedAt', FieldValue.serverTimestamp());

        const config = await getTtsState(channelId);
        const next = { ...(config.pronunciations || {}) };
        delete next[match];
        config.pronunciations = next;
        channelConfigsCache.set(channelId, config);
        logger.info(`[${channelName}] Pronunciation removed: "${match}"`);
        return true;
    } catch (error) {
        // 5 is NOT_FOUND: the entry was already gone, which is the desired end state.
        if (error.code === 5) return true;
        logger.error({ err: error, channel: channelName, match }, 'Failed to remove pronunciation from Firestore.');
        return false;
    }
}

/**
 * Drop every channel pronunciation, restoring the built-ins.
 * @param {string} channelName
 * @returns {Promise<boolean>}
 */
export async function clearPronunciations(channelName) {
    const channelId = resolveChannelId(channelName);
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelId);
    try {
        // Not merge:true — a merge would leave the existing keys in place.
        await docRef.set({
            pronunciations: {},
            updatedAt: FieldValue.serverTimestamp()
        }, { mergeFields: ['pronunciations', 'updatedAt'] });

        const config = await getTtsState(channelId);
        config.pronunciations = {};
        channelConfigsCache.set(channelId, config);
        logger.info(`[${channelName}] All channel pronunciations cleared.`);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName }, 'Failed to clear pronunciations in Firestore.');
        return false;
    }
}

// Get user-specific emotion preference
export async function getUserEmotionPreference(channelName, username, userId) {
    const channelConfig = await getTtsState(channelName);
    // Try userId first (immutable), then fall back to username (legacy)
    if (userId && channelConfig.userPreferences?.[userId]?.emotion) {
        return channelConfig.userPreferences[userId].emotion;
    }
    const lowerUser = username.toLowerCase();
    return channelConfig.userPreferences?.[lowerUser]?.emotion || null;
}

// Set user-specific emotion preference
export async function setUserEmotionPreference(channelName, username, userId, emotion) {
    const channelId = resolveChannelId(channelName);
    if (!VALID_EMOTIONS.includes(emotion.toLowerCase())) {
        logger.warn(`[${channelName}] Attempt to set invalid emotion '${emotion}' for user ${username}.`);
        return false;
    }
    // Use userId as primary key (immutable), fall back to username
    const userKey = userId || username.toLowerCase();
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelId);
    try {
        await docRef.set({
            userPreferences: {
                [userKey]: {
                    emotion: emotion.toLowerCase()
                }
            },
            updatedAt: FieldValue.serverTimestamp()
        }, { merge: true }); // Use merge:true to not overwrite other userPreferences

        logger.info(`[${channelName}] User TTS emotion preference updated for ${userKey}: ${emotion}`);
        // Update cache
        const currentConfig = channelConfigsCache.get(channelId) || await getTtsState(channelId);
        if (!currentConfig.userPreferences) currentConfig.userPreferences = {};
        if (!currentConfig.userPreferences[userKey]) currentConfig.userPreferences[userKey] = {};
        currentConfig.userPreferences[userKey].emotion = emotion.toLowerCase();
        channelConfigsCache.set(channelId, currentConfig);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName, user: userKey, emotion }, 'Failed to set user TTS emotion preference in Firestore.');
        return false;
    }
}

// Clear user-specific emotion preference (revert to channel default/auto)
export async function clearUserEmotionPreference(channelName, username, userId) {
    const channelId = resolveChannelId(channelName);
    // Use userId as primary key (immutable), fall back to username
    const userKey = userId || username.toLowerCase();
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelId);
    const fieldPath = `userPreferences.${userKey}.emotion`;

    try {
        await docRef.update({
            [fieldPath]: FieldValue.delete(), // Deletes the emotion field for the user
            updatedAt: FieldValue.serverTimestamp()
        });
        logger.info(`[${channelName}] Cleared user TTS emotion preference for ${userKey}.`);
        // Update cache
        const currentConfig = channelConfigsCache.get(channelId) || await getTtsState(channelId);
        if (currentConfig.userPreferences && currentConfig.userPreferences[userKey]) {
            delete currentConfig.userPreferences[userKey].emotion;
            // Optional: if userPreferences[userKey] is now empty, delete it too
            if (Object.keys(currentConfig.userPreferences[userKey]).length === 0) {
                delete currentConfig.userPreferences[userKey];
            }
        }
        channelConfigsCache.set(channelId, currentConfig);
        return true;
    } catch (error) {
        // It might fail if the field doesn't exist, which is fine.
        if (error.code === 5) { // Firestore: NOT_FOUND (usually if trying to delete a non-existent field path directly)
            logger.debug(`[${channelName}] No specific emotion preference to clear for user ${userKey}.`);
            // Ensure cache reflects this state
            const currentConfig = channelConfigsCache.get(channelId) || await getTtsState(channelId);
            if (currentConfig.userPreferences && currentConfig.userPreferences[userKey]) {
                delete currentConfig.userPreferences[userKey].emotion;
                if (Object.keys(currentConfig.userPreferences[userKey]).length === 0) {
                    delete currentConfig.userPreferences[userKey];
                }
            }
            channelConfigsCache.set(channelId, currentConfig);
            return true; // Considered success as the end state is "no preference"
        }
        logger.error({ err: error, channel: channelName, user: userKey }, 'Failed to clear user TTS emotion preference in Firestore.');
        return false;
    }
}

// --- NEW FUNCTIONS FOR VOICE PREFERENCE ---
export async function getUserVoicePreference(channelName, username, userId) {
    const channelConfig = await getTtsState(channelName);
    // Try userId first (immutable), then fall back to username (legacy)
    if (userId && channelConfig.userPreferences?.[userId]?.voiceId) {
        return channelConfig.userPreferences[userId].voiceId;
    }
    const lowerUser = username.toLowerCase();
    return channelConfig.userPreferences?.[lowerUser]?.voiceId || null;
}

export async function setUserVoicePreference(channelName, username, userId, voiceId) {
    const channelId = resolveChannelId(channelName);
    const availableVoices = await getAvailableVoices();
    const isValidVoice = availableVoices.some(v => v.id === voiceId);

    if (!isValidVoice) {
        logger.warn(`[${channelName}] Attempt to set invalid voice_id '${voiceId}' for user ${username}.`);
        return false;
    }

    // Use userId as primary key (immutable), fall back to username
    const userKey = userId || username.toLowerCase();
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelId);
    try {
        // Using mergeFields to precisely update only the voiceId for the specific user
        await docRef.set({
            userPreferences: {
                [userKey]: {
                    voiceId: voiceId
                }
            },
            updatedAt: FieldValue.serverTimestamp()
        }, { mergeFields: [`userPreferences.${userKey}.voiceId`, 'updatedAt'] });

        logger.info(`[${channelName}] User TTS voice preference updated for ${userKey}: ${voiceId}`);
        const currentConfig = channelConfigsCache.get(channelId) || await getTtsState(channelId);
        if (!currentConfig.userPreferences) currentConfig.userPreferences = {};
        if (!currentConfig.userPreferences[userKey]) currentConfig.userPreferences[userKey] = {};
        currentConfig.userPreferences[userKey].voiceId = voiceId;
        channelConfigsCache.set(channelId, currentConfig);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName, user: userKey, voiceId }, 'Failed to set user TTS voice preference in Firestore.');
        return false;
    }
}

export async function clearUserVoicePreference(channelName, username, userId) {
    const channelId = resolveChannelId(channelName);
    // Use userId as primary key (immutable), fall back to username
    const userKey = userId || username.toLowerCase();
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelId);
    const fieldPath = `userPreferences.${userKey}.voiceId`;

    try {
        await docRef.update({
            [fieldPath]: FieldValue.delete(),
            updatedAt: FieldValue.serverTimestamp()
        });
        logger.info(`[${channelName}] Cleared user TTS voice preference for ${userKey}.`);
        const currentConfig = channelConfigsCache.get(channelId) || await getTtsState(channelId);
        if (currentConfig.userPreferences && currentConfig.userPreferences[userKey]) {
            delete currentConfig.userPreferences[userKey].voiceId;
            if (Object.keys(currentConfig.userPreferences[userKey]).length === 0) {
                delete currentConfig.userPreferences[userKey];
            }
        }
        channelConfigsCache.set(channelId, currentConfig);
        return true;
    } catch (error) {
        if (error.code === 5) { // Firestore: NOT_FOUND (field doesn't exist)
            logger.debug(`[${channelName}] No specific voice preference to clear for user ${userKey}.`);
            const currentConfig = channelConfigsCache.get(channelId) || await getTtsState(channelId);
            if (currentConfig.userPreferences && currentConfig.userPreferences[userKey]) {
                delete currentConfig.userPreferences[userKey].voiceId;
                if (Object.keys(currentConfig.userPreferences[userKey]).length === 0) {
                    delete currentConfig.userPreferences[userKey];
                }
            }
            channelConfigsCache.set(channelId, currentConfig);
            return true;
        }
        logger.error({ err: error, channel: channelName, user: userKey }, 'Failed to clear user TTS voice preference in Firestore.');
        return false;
    }
}

// --- Functions for Channel-wide Default Pitch ---
export async function setChannelDefaultPitch(channelName, pitch) {
    const parsedPitch = parseInt(pitch, 10);
    if (isNaN(parsedPitch) || parsedPitch < TTS_PITCH_MIN || parsedPitch > TTS_PITCH_MAX) {
        logger.warn(`[${channelName}] Attempt to set invalid default pitch: ${pitch}. Must be integer between ${TTS_PITCH_MIN} and ${TTS_PITCH_MAX}.`);
        return false;
    }
    return setTtsState(channelName, 'pitch', parsedPitch);
}

export async function resetChannelDefaultPitch(channelName) {
    return setTtsState(channelName, 'pitch', TTS_PITCH_DEFAULT);
}

// --- Functions for Channel-wide Default Speed ---
export async function setChannelDefaultSpeed(channelName, speed) {
    const parsedSpeed = parseFloat(speed);
    if (isNaN(parsedSpeed) || parsedSpeed < TTS_SPEED_MIN || parsedSpeed > TTS_SPEED_MAX) {
        logger.warn(`[${channelName}] Attempt to set invalid default speed: ${speed}. Must be number between ${TTS_SPEED_MIN} and ${TTS_SPEED_MAX}.`);
        return false;
    }
    return setTtsState(channelName, 'speed', parsedSpeed);
}

export async function resetChannelDefaultSpeed(channelName) {
    return setTtsState(channelName, 'speed', TTS_SPEED_DEFAULT);
}

// --- Functions for Channel-wide Default Emotion ---
export async function setChannelDefaultEmotion(channelName, emotion) {
    if (!VALID_EMOTIONS.includes(emotion.toLowerCase())) {
        logger.warn(`[${channelName}] Attempt to set invalid default emotion: ${emotion}.`);
        return false;
    }
    return setTtsState(channelName, 'emotion', emotion.toLowerCase());
}

export async function resetChannelDefaultEmotion(channelName) {
    const systemDefaultEmotion = DEFAULT_TTS_SETTINGS.emotion || 'auto';
    return setTtsState(channelName, 'emotion', systemDefaultEmotion);
}

// --- Functions for User-specific Pitch Preference ---
export async function getUserPitchPreference(channelName, username, userId) {
    const channelConfig = await getTtsState(channelName);
    // Try userId first (immutable), then fall back to username (legacy)
    if (userId && channelConfig.userPreferences?.[userId]?.pitch !== undefined) {
        return channelConfig.userPreferences[userId].pitch;
    }
    const lowerUser = username.toLowerCase();
    return channelConfig.userPreferences?.[lowerUser]?.pitch ?? null;
}

export async function setUserPitchPreference(channelName, username, userId, pitch) {
    const channelId = resolveChannelId(channelName);
    const parsedPitch = parseInt(pitch, 10);
    if (isNaN(parsedPitch) || parsedPitch < TTS_PITCH_MIN || parsedPitch > TTS_PITCH_MAX) {
        logger.warn(`[${channelName}] Attempt to set invalid pitch preference '${pitch}' for user ${username}.`);
        return false;
    }
    // Use userId as primary key (immutable), fall back to username
    const userKey = userId || username.toLowerCase();
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelId);
    try {
        await docRef.set({
            userPreferences: { [userKey]: { pitch: parsedPitch } },
            updatedAt: FieldValue.serverTimestamp()
        }, { mergeFields: [`userPreferences.${userKey}.pitch`, 'updatedAt'] });

        logger.info(`[${channelName}] User TTS pitch preference updated for ${userKey}: ${parsedPitch}`);
        const currentConfig = channelConfigsCache.get(channelId) || await getTtsState(channelId);
        if (!currentConfig.userPreferences) currentConfig.userPreferences = {};
        if (!currentConfig.userPreferences[userKey]) currentConfig.userPreferences[userKey] = {};
        currentConfig.userPreferences[userKey].pitch = parsedPitch;
        channelConfigsCache.set(channelId, currentConfig);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName, user: userKey, pitch: parsedPitch }, 'Failed to set user TTS pitch preference in Firestore.');
        return false;
    }
}

export async function clearUserPitchPreference(channelName, username, userId) {
    const channelId = resolveChannelId(channelName);
    // Use userId as primary key (immutable), fall back to username
    const userKey = userId || username.toLowerCase();
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelId);
    const fieldPath = `userPreferences.${userKey}.pitch`;
    try {
        await docRef.update({ [fieldPath]: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
        logger.info(`[${channelName}] Cleared user TTS pitch preference for ${userKey}.`);
        const currentConfig = channelConfigsCache.get(channelId) || await getTtsState(channelId);
        if (currentConfig.userPreferences && currentConfig.userPreferences[userKey]) {
            delete currentConfig.userPreferences[userKey].pitch;
            if (Object.keys(currentConfig.userPreferences[userKey]).length === 0) {
                delete currentConfig.userPreferences[userKey];
            }
        }
        channelConfigsCache.set(channelId, currentConfig);
        return true;
    } catch (error) {
        if (error.code === 5) { return true; }
        logger.error({ err: error, channel: channelName, user: userKey }, 'Failed to clear user TTS pitch preference.');
        return false;
    }
}

// --- Functions for User-specific Speed Preference ---
export async function getUserSpeedPreference(channelName, username, userId) {
    const channelConfig = await getTtsState(channelName);
    // Try userId first (immutable), then fall back to username (legacy)
    if (userId && channelConfig.userPreferences?.[userId]?.speed !== undefined) {
        return channelConfig.userPreferences[userId].speed;
    }
    const lowerUser = username.toLowerCase();
    return channelConfig.userPreferences?.[lowerUser]?.speed ?? null;
}

export async function setUserSpeedPreference(channelName, username, userId, speed) {
    const channelId = resolveChannelId(channelName);
    const parsedSpeed = parseFloat(speed);
    if (isNaN(parsedSpeed) || parsedSpeed < TTS_SPEED_MIN || parsedSpeed > TTS_SPEED_MAX) {
        logger.warn(`[${channelName}] Attempt to set invalid speed preference '${speed}' for user ${username}.`);
        return false;
    }
    // Use userId as primary key (immutable), fall back to username
    const userKey = userId || username.toLowerCase();
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelId);
    try {
        await docRef.set({
            userPreferences: { [userKey]: { speed: parsedSpeed } },
            updatedAt: FieldValue.serverTimestamp()
        }, { mergeFields: [`userPreferences.${userKey}.speed`, 'updatedAt'] });

        logger.info(`[${channelName}] User TTS speed preference updated for ${userKey}: ${parsedSpeed}`);
        const currentConfig = channelConfigsCache.get(channelId) || await getTtsState(channelId);
        if (!currentConfig.userPreferences) currentConfig.userPreferences = {};
        if (!currentConfig.userPreferences[userKey]) currentConfig.userPreferences[userKey] = {};
        currentConfig.userPreferences[userKey].speed = parsedSpeed;
        channelConfigsCache.set(channelId, currentConfig);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName, user: userKey, speed: parsedSpeed }, 'Failed to set user TTS speed preference in Firestore.');
        return false;
    }
}

export async function clearUserSpeedPreference(channelName, username, userId) {
    const channelId = resolveChannelId(channelName);
    // Use userId as primary key (immutable), fall back to username
    const userKey = userId || username.toLowerCase();
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelId);
    const fieldPath = `userPreferences.${userKey}.speed`;
    try {
        await docRef.update({ [fieldPath]: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
        logger.info(`[${channelName}] Cleared user TTS speed preference for ${userKey}.`);
        const currentConfig = channelConfigsCache.get(channelId) || await getTtsState(channelId);
        if (currentConfig.userPreferences && currentConfig.userPreferences[userKey]) {
            delete currentConfig.userPreferences[userKey].speed;
            if (Object.keys(currentConfig.userPreferences[userKey]).length === 0) {
                delete currentConfig.userPreferences[userKey];
            }
        }
        channelConfigsCache.set(channelId, currentConfig);
        return true;
    } catch (error) {
        if (error.code === 5) { return true; }
        logger.error({ err: error, channel: channelName, user: userKey }, 'Failed to clear user TTS speed preference.');
        return false;
    }
}

// --- Functions for Channel-wide Default Language ---
export async function setChannelDefaultLanguage(channelName, language) {
    const langKey = language.charAt(0).toUpperCase() + language.slice(1).toLowerCase();
    if (!VALID_LANGUAGE_BOOSTS.includes(langKey) && langKey !== "None" && langKey !== "Automatic") {
        const foundLang = VALID_LANGUAGE_BOOSTS.find(l => l.toLowerCase() === language.toLowerCase());
        if (!foundLang) {
            logger.warn(`[${channelName}] Attempt to set invalid default language: ${language}.`);
            return false;
        }
        language = foundLang;
    } else if (VALID_LANGUAGE_BOOSTS.includes(langKey)) {
        language = langKey;
    }
    if (!VALID_LANGUAGE_BOOSTS.includes(language)) {
        logger.warn(`[${channelName}] Attempt to set invalid default language: ${language}.`);
        return false;
    }
    return setTtsState(channelName, 'languageBoost', language);
}

export async function resetChannelDefaultLanguage(channelName) {
    const systemDefaultLanguage = DEFAULT_TTS_SETTINGS.languageBoost || 'Automatic';
    return setTtsState(channelName, 'languageBoost', systemDefaultLanguage);
}

// --- Functions for User-specific Language Preference ---
export async function getUserLanguagePreference(channelName, username, userId) {
    const channelConfig = await getTtsState(channelName);
    // Try userId first (immutable), then fall back to username (legacy)
    if (userId && channelConfig.userPreferences?.[userId]?.languageBoost) {
        return channelConfig.userPreferences[userId].languageBoost;
    }
    const lowerUser = username.toLowerCase();
    return channelConfig.userPreferences?.[lowerUser]?.languageBoost || null;
}

export async function setUserLanguagePreference(channelName, username, userId, language) {
    const langKey = language.charAt(0).toUpperCase() + language.slice(1).toLowerCase();
    if (!VALID_LANGUAGE_BOOSTS.includes(langKey) && langKey !== "None" && langKey !== "Automatic") {
        const foundLang = VALID_LANGUAGE_BOOSTS.find(l => l.toLowerCase() === language.toLowerCase());
        if (!foundLang) {
            logger.warn(`[${channelName}] Attempt to set invalid language preference '${language}' for user ${username}.`);
            return false;
        }
        language = foundLang;
    } else if (VALID_LANGUAGE_BOOSTS.includes(langKey)) {
        language = langKey;
    }
    if (!VALID_LANGUAGE_BOOSTS.includes(language)) {
        logger.warn(`[${channelName}] Attempt to set invalid language preference '${language}' for user ${username}.`);
        return false;
    }
    // Use userId as primary key (immutable), fall back to username
    const userKey = userId || username.toLowerCase();
    const channelId = resolveChannelId(channelName);
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelId);
    try {
        await docRef.set({
            userPreferences: { [userKey]: { languageBoost: language } },
            updatedAt: FieldValue.serverTimestamp()
        }, { mergeFields: [`userPreferences.${userKey}.languageBoost`, 'updatedAt'] });
        logger.info(`[${channelName}] User TTS language preference updated for ${userKey}: ${language}`);
        const currentConfig = channelConfigsCache.get(channelId) || await getTtsState(channelId);
        if (!currentConfig.userPreferences) currentConfig.userPreferences = {};
        if (!currentConfig.userPreferences[userKey]) currentConfig.userPreferences[userKey] = {};
        currentConfig.userPreferences[userKey].languageBoost = language;
        channelConfigsCache.set(channelId, currentConfig);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName, user: userKey, language: language }, 'Failed to set user TTS language preference in Firestore.');
        return false;
    }
}

export async function clearUserLanguagePreference(channelName, username, userId) {
    // Use userId as primary key (immutable), fall back to username
    const userKey = userId || username.toLowerCase();
    const channelId = resolveChannelId(channelName);
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelId);
    const fieldPath = `userPreferences.${userKey}.languageBoost`;
    try {
        await docRef.update({ [fieldPath]: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
        logger.info(`[${channelName}] Cleared user TTS language preference for ${userKey}.`);
        const currentConfig = channelConfigsCache.get(channelId) || await getTtsState(channelId);
        if (currentConfig.userPreferences && currentConfig.userPreferences[userKey]) {
            delete currentConfig.userPreferences[userKey].languageBoost;
            if (Object.keys(currentConfig.userPreferences[userKey]).length === 0) {
                delete currentConfig.userPreferences[userKey];
            }
        }
        channelConfigsCache.set(channelId, currentConfig);
        return true;
    } catch (error) {
        if (error.code === 5) { return true; }
        logger.error({ err: error, channel: channelName, user: userKey }, 'Failed to clear user TTS language preference.');
        return false;
    }
}

async function getUserPreferences(channelName, username, userId) {
    const channelConfig = await getTtsState(channelName); // getTtsState handles resolution
    // Try userId first (immutable), then fall back to username (legacy)
    if (userId && channelConfig.userPreferences?.[userId]) {
        return channelConfig.userPreferences[userId];
    }
    const lowerUser = username.toLowerCase();
    return channelConfig.userPreferences?.[lowerUser] || {};
}

async function setUserPreference(channelName, username, userId, preferenceKey, value) {
    // Use userId as primary key (immutable), fall back to username
    const userKey = userId || username.toLowerCase();
    const channelId = resolveChannelId(channelName);
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelId);
    try {
        await docRef.set({
            userPreferences: { [userKey]: { [preferenceKey]: value } },
            updatedAt: FieldValue.serverTimestamp()
        }, { mergeFields: [`userPreferences.${userKey}.${preferenceKey}`, 'updatedAt'] });
        logger.info(`[${channelName}] User TTS preference updated for ${userKey}: ${preferenceKey} = ${value}`);
        const currentConfig = channelConfigsCache.get(channelId) || await getTtsState(channelId);
        if (!currentConfig.userPreferences) currentConfig.userPreferences = {};
        if (!currentConfig.userPreferences[userKey]) currentConfig.userPreferences[userKey] = {};
        currentConfig.userPreferences[userKey][preferenceKey] = value;
        currentConfig.updatedAt = new Date();
        channelConfigsCache.set(channelId, currentConfig);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName, user: userKey, preference: preferenceKey, value }, 'Failed to set user TTS preference.');
        return false;
    }
}

async function getUserEnglishNormalizationPreference(channelName, username, userId) {
    const userPrefs = await getUserPreferences(channelName, username, userId);
    return userPrefs?.englishNormalization;
}

async function setUserEnglishNormalizationPreference(channelName, username, userId, value) {
    await setUserPreference(channelName, username, userId, 'englishNormalization', value);
}

// --- Functions for Bits-for-TTS Configuration ---
/**
 * Sets the Bits-for-TTS configuration for a channel.
 * @param {string} channelName - The name of the channel.
 * @param {object} bitsConfig - An object containing { enabled, minimumAmount }.
 * @returns {Promise<boolean>}
 */
export async function setBitsConfig(channelName, { enabled, minimumAmount }) {
    const channelId = resolveChannelId(channelName);
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelId);
    try {
        const updatePayload = {
            bitsModeEnabled: enabled,
            bitsMinimumAmount: minimumAmount,
            updatedAt: FieldValue.serverTimestamp()
        };
        await docRef.set(updatePayload, { merge: true });
        logger.info(`[${channelName}] Bits-for-TTS config updated: Enabled=${enabled}, Min=${minimumAmount}`);
        // Update local cache
        const currentConfig = channelConfigsCache.get(channelId) || {};
        channelConfigsCache.set(channelId, { ...currentConfig, ...updatePayload });
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName }, 'Failed to set Bits-for-TTS config.');
        return false;
    }
}

/**
 * Gets the Bits-for-TTS configuration for a channel.
 * @param {string} channelName - The name of the channel.
 * @returns {Promise<{enabled: boolean, minimumAmount: number}>}
 */
export async function getBitsConfig(channelName) {
    const config = await getTtsState(channelName);
    return {
        enabled: !!config.bitsModeEnabled,
        minimumAmount: typeof config.bitsMinimumAmount === 'number' ? config.bitsMinimumAmount : 0
    };
}

/**
 * Resets the Bits-for-TTS configuration for a channel to defaults (disabled, min 0).
 * @param {string} channelName - The name of the channel.
 * @returns {Promise<boolean>}
 */
export async function resetBitsConfig(channelName) {
    return setBitsConfig(channelName, { enabled: false, minimumAmount: 0 });
}

/**
 * Returns the entire channelConfigsCache Map.
 * Used by ytChatClient.js to iterate over all channels on initialization.
 */
export function getAllChannelConfigs() {
    return channelConfigsCache;
}

/**
 * Register a callback to be notified when a channel's YouTube config changes.
 * @param {function(string, object): void} callback - Called with (channelId, newConfig)
 */
export function onYouTubeConfigChange(callback) {
    youtubeConfigChangeListeners.push(callback);
}

export {
    getUserEnglishNormalizationPreference,
    setUserEnglishNormalizationPreference
}
