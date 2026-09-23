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
import { getChannelIdFromName } from '../../lib/allowList.js';
import { buildIgnoreEntry } from '../../lib/ignoreList.js';

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
 * Resolves a channel identifier (login name or numeric ID) to the broadcaster's
 * Twitch User ID, which is the ttsChannelConfigs document key. A login the
 * allow-list does not know resolves to null — never to the login itself, which
 * would read or create a document under a key nothing else uses.
 * @param {string} identifier - Channel login name or numeric User ID
 * @returns {string|null}
 */
function resolveChannelId(identifier) {
    if (!identifier) return null;
    if (/^\d+$/.test(identifier)) return String(identifier);
    return getChannelIdFromName(identifier) || null;
}

/**
 * resolveChannelId for writers: logs and returns null when the channel has no
 * known ID, so the caller can return its usual failure value.
 * @param {string} channelName
 * @returns {string|null}
 */
function channelIdForWrite(channelName) {
    const channelId = resolveChannelId(channelName);
    if (!channelId) {
        logger.error({ channel: channelName }, 'No Twitch user ID known for channel; refusing to write TTS config.');
    }
    return channelId;
}

export async function initializeTtsState() {
    if (!db) db = new Firestore();
    logger.info('Initializing TTS State from Firestore...');
    try {
        const snapshot = await db.collection(TTS_CONFIG_COLLECTION).get();
        snapshot.forEach(doc => {
            // Ensure userPreferences field exists
            const data = doc.data();
            channelConfigsCache.set(doc.id, {
                ...DEFAULT_TTS_SETTINGS,
                ...data,
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
                    const previousConfig = channelConfigsCache.get(docId);
                    const newConfig = {
                        ...DEFAULT_TTS_SETTINGS,
                        ...data,
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
    if (!channelId) {
        // Same reasoning as a failed read below: an unknown ID (allow-list not yet
        // loaded, or a channel doc without twitchUserId) says nothing about the
        // channel's settings, so serve defaults without caching them.
        logger.warn({ channel: channelName }, 'No Twitch user ID known for channel; serving default TTS settings.');
        return { ...DEFAULT_TTS_SETTINGS, userPreferences: {} };
    }
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
            const config = {
                ...DEFAULT_TTS_SETTINGS,
                ...data,
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
    // No document exists - this is a new channel, use defaults
    const defaultConfigCopy = { ...DEFAULT_TTS_SETTINGS, userPreferences: {} };
    channelConfigsCache.set(channelId, defaultConfigCopy);
    return defaultConfigCopy;
}

/**
 * The channel's *stored* languageBoost, or null when it has none.
 *
 * Deliberately not `getTtsState().languageBoost`. That function swallows a
 * Firestore read error and returns DEFAULT_TTS_SETTINGS, whose languageBoost is
 * 'auto' — indistinguishable from a channel that genuinely has not chosen one.
 * Any caller that *writes* based on the absence of a setting would therefore
 * overwrite a real preference during a transient outage, so this one lets the
 * error propagate and makes the caller decide.
 *
 * @throws whatever Firestore throws on a failed read, or when the channel has
 *   no known Twitch user ID.
 * @returns {Promise<string|null>}
 */
export async function getStoredLanguageBoost(channelName) {
    if (!db) db = new Firestore();
    const channelId = resolveChannelId(channelName);
    if (!channelId) throw new Error(`No Twitch user ID known for channel ${channelName}`);

    // The collection listener keeps this current, so a hit is authoritative.
    if (channelConfigsCache.has(channelId)) {
        return channelConfigsCache.get(channelId).languageBoost ?? null;
    }

    const docSnap = await db.collection(TTS_CONFIG_COLLECTION).doc(channelId).get();
    if (!docSnap.exists) return null;
    return docSnap.data()?.languageBoost ?? null;
}

export async function getChannelTtsConfig(channelName) {
    const fullState = await getTtsState(channelName);
    // Extract only TTS parameters
    const { voiceId, speed, volume, pitch, emotion, englishNormalization, sampleRate, bitrate, channel, languageBoost, voiceVolumes } = fullState;
    return { voiceId, speed, volume, pitch, emotion, languageBoost, englishNormalization, sampleRate, bitrate, channel, voiceVolumes: voiceVolumes || {} };
}

export async function setTtsState(channelName, key, value) {
    const channelId = channelIdForWrite(channelName);
    if (!channelId) return false;
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

// --- Viewer preferences ---
//
// Keyed by the viewer's immutable platform account ID (Twitch user ID, or the
// YouTube channel ID for YouTube chatters), never by login. A caller without an
// ID gets no preferences and cannot write any.

/**
 * The viewer's global (cross-channel) preferences from ttsUserPreferences.
 * @param {string|null} userId
 * @returns {Promise<object>}
 */
export async function getGlobalUserPreferences(userId) {
    if (!db) db = new Firestore();
    if (!userId) return {};
    const cached = globalUserPrefsCache.get(userId);
    if (cached && (Date.now() - cached.cachedAt) < GLOBAL_PREFS_CACHE_TTL_MS) {
        return cached.data;
    }
    try {
        const docSnap = await db.collection(USER_PREFS_COLLECTION).doc(userId).get();
        // Cache the empty result too to avoid repeated Firestore misses
        const data = docSnap.exists ? (docSnap.data() || {}) : {};
        setBoundedCacheEntry(globalUserPrefsCache, userId, { data, cachedAt: Date.now() }, GLOBAL_PREFS_CACHE_TTL_MS);
        return data;
    } catch (error) {
        logger.error({ err: error, userId }, 'Failed to get user preferences from Firestore.');
        return {};
    }
}

/**
 * @param {string} userId
 * @param {string} key
 * @param {*} value
 * @param {string} [username] - Stored alongside as a display label only
 */
export async function setGlobalUserPreference(userId, key, value, username) {
    if (!db) db = new Firestore();
    if (!userId) {
        logger.error({ user: username, key }, 'Refusing to set a user preference without a user ID.');
        return false;
    }
    const docRef = db.collection(USER_PREFS_COLLECTION).doc(userId);
    try {
        const writeData = { [key]: value, updatedAt: FieldValue.serverTimestamp() };
        if (username) writeData.username = username.toLowerCase();
        await docRef.set(writeData, { merge: true });
        logger.info(`Global user preference updated for ${userId}: ${key} = ${value}`);
        // Invalidate cache so next read picks up the new value
        globalUserPrefsCache.delete(userId);
        return true;
    } catch (error) {
        logger.error({ err: error, userId, key, value }, 'Failed to set user preference in Firestore.');
        return false;
    }
}

export async function clearGlobalUserPreference(userId, key) {
    if (!db) db = new Firestore();
    if (!userId) {
        logger.error({ key }, 'Refusing to clear a user preference without a user ID.');
        return false;
    }
    const docRef = db.collection(USER_PREFS_COLLECTION).doc(userId);
    try {
        await docRef.update({ [key]: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
        logger.info(`Cleared global user preference '${key}' for ${userId}.`);
        // Invalidate cache
        globalUserPrefsCache.delete(userId);
        return true;
    } catch (error) {
        if (error.code === 5) {
            logger.debug(`No specific preference '${key}' to clear for user ${userId}.`);
            return true;
        }
        logger.error({ err: error, userId, key }, `Failed to clear user preference '${key}'.`);
        return false;
    }
}

/**
 * The viewer's per-channel preferences (ttsChannelConfigs.userPreferences). Nothing
 * writes these any more — chat commands and the dashboard write the global
 * document — but existing entries are still honored, below the global ones.
 * @param {string} channelName
 * @param {string|null} userId
 * @returns {Promise<object>}
 */
export async function getChannelUserPreferences(channelName, userId) {
    if (!userId) return {};
    const channelConfig = await getTtsState(channelName);
    return channelConfig.userPreferences?.[userId] || {};
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
 * @param {string|null} userId
 * @returns {Promise<string|null>} - 'read' | 'skip' | 'describe' | null (allows channel default fallback)
 */
export async function getUserEmoteModePreference(userId) {
    if (!userId) return null;
    try {
        // emoteMode lives on the same ttsUserPreferences document as every other
        // global preference, so this delegates rather than reading it a second time
        // and shares its cache, which setGlobalUserPreference invalidates on write.
        const prefs = await getGlobalUserPreferences(userId);
        const mode = prefs?.emoteMode;
        return mode !== undefined && VALID_EMOTE_MODES.includes(mode) ? mode : null;
    } catch (error) {
        logger.error({ err: error, userId }, 'Failed to get emoteMode preference.');
        return null; // No preference set, allows channel default fallback
    }
}

// --- TTS ignore list (keyed by immutable platform account ID) ---
//
// Stored as a map field rather than an array, so arrayUnion/arrayRemove do not
// apply — the same shape and the same write mechanics as `pronunciations` below.
// See src/lib/ignoreList.js for the key format.

/**
 * Add one account to the channel's ignore list.
 *
 * Re-adding an account overwrites its provenance, which is how a moderator
 * muting someone who had opted out themselves takes the entry out of that
 * viewer's hands.
 *
 * @param {string} channelName
 * @param {string} key Built by ignoreKey(platform, accountId).
 * @param {string} label Display name, shown by !tts ignored and the dashboard.
 * @param {{ source?: string, by?: string|null }} [provenance] Who imposed it;
 *   defaults to moderator, the shape that cannot be lifted by its subject.
 * @returns {Promise<boolean>}
 */
export async function addIgnoredUser(channelName, key, label, provenance = {}) {
    const channelId = channelIdForWrite(channelName);
    if (!channelId) return false;
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelId);
    const entry = buildIgnoreEntry({ label, ...provenance });
    try {
        // merge:true deep-merges nested maps key by key, so this touches only
        // the one entry and leaves the rest of the list alone. It merges into
        // the entry object too, which is exactly why buildIgnoreEntry writes
        // every field: a partial write here would inherit the previous entry's
        // source instead of replacing it.
        await docRef.set({
            ignoredUserIds: { [key]: entry },
            updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });

        const config = await getTtsState(channelId);
        // A fresh object rather than a mutation, so a caller holding the
        // previous config does not observe the change behind its back.
        config.ignoredUserIds = { ...(config.ignoredUserIds || {}), [key]: entry };
        channelConfigsCache.set(channelId, config);
        logger.info(`[${channelName}] TTS ignore added: ${key} ("${label}") by ${entry.source}`);
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
    const channelId = channelIdForWrite(channelName);
    if (!channelId) return false;
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

// --- Muted rewards (channel point redemptions that are not announced) ---
//
// Keyed by Twitch reward ID; see src/lib/rewardMuteList.js for the shape and
// why it is an exclusion list. Same write mechanics as the ignore list.

/**
 * Stop announcing redemptions of one reward.
 * @param {string} channelName
 * @param {string} rewardId Twitch custom reward ID.
 * @param {{ title: string, by: string|null, at: string }} entry Built by buildMutedRewardEntry.
 * @returns {Promise<boolean>}
 */
export async function muteReward(channelName, rewardId, entry) {
    const channelId = channelIdForWrite(channelName);
    if (!channelId) return false;
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelId);
    try {
        await docRef.set({
            mutedRewardIds: { [rewardId]: entry },
            updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });

        const config = await getTtsState(channelId);
        config.mutedRewardIds = { ...(config.mutedRewardIds || {}), [rewardId]: entry };
        channelConfigsCache.set(channelId, config);
        logger.info(`[${channelName}] Reward muted: ${rewardId} ("${entry.title}")`);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName, rewardId }, 'Failed to mute reward in Firestore.');
        return false;
    }
}

/**
 * Announce redemptions of one reward again.
 * @param {string} channelName
 * @param {string} rewardId
 * @returns {Promise<boolean>}
 */
export async function unmuteReward(channelName, rewardId) {
    const channelId = channelIdForWrite(channelName);
    if (!channelId) return false;
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelId);
    try {
        await docRef.update(new FieldPath('mutedRewardIds', rewardId), FieldValue.delete(),
            'updatedAt', FieldValue.serverTimestamp());

        const config = await getTtsState(channelId);
        const next = { ...(config.mutedRewardIds || {}) };
        delete next[rewardId];
        config.mutedRewardIds = next;
        channelConfigsCache.set(channelId, config);
        logger.info(`[${channelName}] Reward unmuted: ${rewardId}`);
        return true;
    } catch (error) {
        // 5 is NOT_FOUND: the entry was already gone, which is the desired end state.
        if (error.code === 5) return true;
        logger.error({ err: error, channel: channelName, rewardId }, 'Failed to unmute reward in Firestore.');
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
    const channelId = channelIdForWrite(channelName);
    if (!channelId) return false;
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
    const channelId = channelIdForWrite(channelName);
    if (!channelId) return false;
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
    const channelId = channelIdForWrite(channelName);
    if (!channelId) return false;
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

// --- Functions for cheer configuration (readCheerMessages, bitsMinimumAmount) ---
/**
 * Sets the cheer configuration for a channel: whether cheer messages are read, and the minimum bits.
 * @param {string} channelName - The name of the channel.
 * @param {object} bitsConfig - An object containing { enabled, minimumAmount }.
 * @returns {Promise<boolean>}
 */
export async function setBitsConfig(channelName, { enabled, minimumAmount }) {
    const channelId = channelIdForWrite(channelName);
    if (!channelId) return false;
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelId);
    try {
        const updatePayload = {
            readCheerMessages: enabled,
            bitsMinimumAmount: minimumAmount,
            updatedAt: FieldValue.serverTimestamp()
        };
        await docRef.set(updatePayload, { merge: true });
        logger.info(`[${channelName}] Cheer config updated: readCheerMessages=${enabled}, minimumBits=${minimumAmount}`);
        // Update local cache
        const currentConfig = channelConfigsCache.get(channelId) || {};
        channelConfigsCache.set(channelId, { ...currentConfig, ...updatePayload });
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName }, 'Failed to set cheer config.');
        return false;
    }
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

