// src/components/tts/ttsState.js
import { Firestore, FieldValue } from '@google-cloud/firestore';
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

let db;
const TTS_CONFIG_COLLECTION = 'ttsChannelConfigs';
const USER_PREFS_COLLECTION = 'ttsUserPreferences';

// In-memory cache of channel configs
const channelConfigsCache = new Map();
let firestoreListenerUnsubscribe = null;

// In-memory cache for global user preferences: key -> { data, cachedAt }
const globalUserPrefsCache = new Map();
const GLOBAL_PREFS_CACHE_TTL_MS = 60 * 1000; // 60 seconds

// In-memory cache for user emote mode preferences: key -> { mode, cachedAt }
const userEmoteModePrefCache = new Map();
const EMOTE_MODE_CACHE_TTL_MS = 60 * 1000; // 60 seconds

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
                const channelName = change.doc.id;
                const data = change.doc.data();
                if (change.type === 'added' || change.type === 'modified') {
                    logger.info(`TTS config for ${channelName} ${change.type}. Updating cache.`);
                    // Migration: Convert old botMode to botRespondsInChat
                    let botRespondsInChat = data.botRespondsInChat;
                    if (botRespondsInChat === undefined && data.botMode !== undefined) {
                        // Migrate from old botMode: 'authenticated' -> true, others -> false
                        botRespondsInChat = data.botMode === 'authenticated';
                    }
                    channelConfigsCache.set(channelName, {
                        ...DEFAULT_TTS_SETTINGS,
                        ...data,
                        botRespondsInChat: botRespondsInChat !== undefined ? botRespondsInChat : false,
                        userPreferences: data.userPreferences || {} // Ensure userPreferences exists
                    });
                } else if (change.type === 'removed') {
                    logger.info(`TTS config for ${channelName} removed. Removing from cache.`);
                    channelConfigsCache.delete(channelName);
                }
            });
        }, err => {
            logger.error({ err }, 'TTS config Firestore listener error.');
        });
}

export async function getTtsState(channelName) {
    if (channelConfigsCache.has(channelName)) {
        // Ensure userPreferences is part of the returned object
        const cachedConfig = channelConfigsCache.get(channelName);
        return { ...cachedConfig, userPreferences: cachedConfig.userPreferences || {} };
    }
    try {
        const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelName);
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
            channelConfigsCache.set(channelName, config);
            return config;
        }
    } catch (error) {
        logger.error({ err: error, channel: channelName }, `Error fetching TTS state for ${channelName} from Firestore.`);
    }
    // No document exists - this is a new channel, use defaults (botRespondsInChat: false)
    const defaultConfigCopy = { ...DEFAULT_TTS_SETTINGS, userPreferences: {} };
    channelConfigsCache.set(channelName, defaultConfigCopy);
    return defaultConfigCopy;
}

export async function getChannelTtsConfig(channelName) {
    const fullState = await getTtsState(channelName);
    // Extract only TTS parameters
    const { voiceId, speed, volume, pitch, emotion, englishNormalization, sampleRate, bitrate, channel, languageBoost, voiceVolumes } = fullState;
    return { voiceId, speed, volume, pitch, emotion, languageBoost, englishNormalization, sampleRate, bitrate, channel, voiceVolumes: voiceVolumes || {} };
}

export async function setTtsState(channelName, key, value) {
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelName);
    try {
        await docRef.set({ [key]: value, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        logger.info(`[${channelName}] TTS state updated: ${key} = ${value}`);
        // Update cache immediately (Firestore listener will also update, but this is faster)
        const currentConfig = channelConfigsCache.get(channelName) || { ...DEFAULT_TTS_SETTINGS };
        channelConfigsCache.set(channelName, { ...currentConfig, [key]: value });
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
    const cacheKey = userId || username.toLowerCase();
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
                globalUserPrefsCache.set(cacheKey, { data, cachedAt: Date.now() });
                return data;
            }
        }
        // Fallback to username
        const lowerUser = username.toLowerCase();
        const docRef = db.collection(USER_PREFS_COLLECTION).doc(lowerUser);
        const docSnap = await docRef.get();
        if (docSnap.exists) {
            const data = docSnap.data() || {};
            globalUserPrefsCache.set(cacheKey, { data, cachedAt: Date.now() });
            return data;
        }
        // Cache the empty result too to avoid repeated Firestore misses
        globalUserPrefsCache.set(cacheKey, { data: {}, cachedAt: Date.now() });
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
    if (!db) db = new Firestore();
    const cacheKey = userId || (username ? username.toLowerCase() : null);
    if (cacheKey) {
        const cached = userEmoteModePrefCache.get(cacheKey);
        if (cached && (Date.now() - cached.cachedAt) < EMOTE_MODE_CACHE_TTL_MS) {
            return cached.mode;
        }
    }
    try {
        // Try userId first (primary)
        if (userId) {
            const userIdDoc = await db.collection(USER_PREFS_COLLECTION).doc(userId).get();
            if (userIdDoc.exists) {
                const data = userIdDoc.data();
                if (data?.emoteMode !== undefined && VALID_EMOTE_MODES.includes(data.emoteMode)) {
                    if (cacheKey) userEmoteModePrefCache.set(cacheKey, { mode: data.emoteMode, cachedAt: Date.now() });
                    return data.emoteMode;
                }
            }
        }
        // Fallback to username
        if (username) {
            const lowerUser = username.toLowerCase();
            const usernameDoc = await db.collection(USER_PREFS_COLLECTION).doc(lowerUser).get();
            if (usernameDoc.exists) {
                const data = usernameDoc.data();
                if (data?.emoteMode !== undefined && VALID_EMOTE_MODES.includes(data.emoteMode)) {
                    if (cacheKey) userEmoteModePrefCache.set(cacheKey, { mode: data.emoteMode, cachedAt: Date.now() });
                    return data.emoteMode;
                }
            }
        }
        // Cache the null result to avoid repeated Firestore misses
        if (cacheKey) userEmoteModePrefCache.set(cacheKey, { mode: null, cachedAt: Date.now() });
        return null; // No preference set, allows channel default fallback
    } catch (error) {
        logger.error({ err: error, user: username, userId }, 'Failed to get emoteMode preference.');
        return null;
    }
}

/**

 * Sets the OBS WebSocket token secret name for a channel.
 * @param {string} channelName - The name of the channel.
 * @param {string} secretName - The full resource name of the secret in Secret Manager.
 * @returns {Promise<boolean>}
 */
export async function setObsSocketSecretName(channelName, secretName) {
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelName);
    try {
        await docRef.set({
            obsSocketSecretName: secretName,
            updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        logger.info(`[${channelName}] OBS WebSocket secret name has been set.`);
        // Update cache
        const currentConfig = await getTtsState(channelName);
        channelConfigsCache.set(channelName, { ...currentConfig, obsSocketSecretName: secretName });
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
    if (!db) db = new Firestore();
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelName);
    try {
        await docRef.set({
            obsSocketToken: token,
            updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        logger.info(`[${channelName}] OBS WebSocket token has been set (Firestore).`);
        // Update cache
        const currentConfig = await getTtsState(channelName);
        channelConfigsCache.set(channelName, { ...currentConfig, obsSocketToken: token });
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName }, 'Failed to set OBS socket token in Firestore.');
        return false;
    }
}
// Functions for managing ignored users
export async function addIgnoredUser(channelName, username) {
    const lowerUser = username.toLowerCase();
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelName);
    try {
        await docRef.set({
            ignoredUsers: FieldValue.arrayUnion(lowerUser),
            updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        // Update cache
        const config = await getTtsState(channelName); // Fetches or gets from cache
        if (!config.ignoredUsers.includes(lowerUser)) {
            config.ignoredUsers.push(lowerUser);
        }
        channelConfigsCache.set(channelName, config);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName, user: lowerUser }, 'Failed to add user to TTS ignore list in Firestore.');
        return false;
    }
}

export async function removeIgnoredUser(channelName, username) {
    const lowerUser = username.toLowerCase();
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelName);
    try {
        await docRef.update({
            ignoredUsers: FieldValue.arrayRemove(lowerUser),
            updatedAt: FieldValue.serverTimestamp()
        });
        // Update cache
        const config = await getTtsState(channelName); // Fetches or gets from cache
        if (config.ignoredUsers) {
            config.ignoredUsers = config.ignoredUsers.filter(user => user !== lowerUser);
        }
        channelConfigsCache.set(channelName, config);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName, user: lowerUser }, 'Failed to remove user from TTS ignore list in Firestore.');
        return false;
    }
}

// Functions for managing banned words/phrases
export async function addBannedWord(channelName, word) {
    const lowerWord = word.toLowerCase().trim();
    if (!lowerWord) return false;
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelName);
    try {
        await docRef.set({
            bannedWords: FieldValue.arrayUnion(lowerWord),
            updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        // Update cache
        const config = await getTtsState(channelName);
        if (!config.bannedWords) config.bannedWords = [];
        if (!config.bannedWords.includes(lowerWord)) {
            config.bannedWords.push(lowerWord);
        }
        channelConfigsCache.set(channelName, config);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName, word: lowerWord }, 'Failed to add banned word in Firestore.');
        return false;
    }
}

export async function removeBannedWord(channelName, word) {
    const lowerWord = word.toLowerCase().trim();
    if (!lowerWord) return false;
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelName);
    try {
        await docRef.update({
            bannedWords: FieldValue.arrayRemove(lowerWord),
            updatedAt: FieldValue.serverTimestamp()
        });
        // Update cache
        const config = await getTtsState(channelName);
        if (config.bannedWords) {
            config.bannedWords = config.bannedWords.filter(w => w !== lowerWord);
        }
        channelConfigsCache.set(channelName, config);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName, word: lowerWord }, 'Failed to remove banned word from Firestore.');
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
    if (!VALID_EMOTIONS.includes(emotion.toLowerCase())) {
        logger.warn(`[${channelName}] Attempt to set invalid emotion '${emotion}' for user ${username}.`);
        return false;
    }
    // Use userId as primary key (immutable), fall back to username
    const userKey = userId || username.toLowerCase();
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelName);
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
        const currentConfig = channelConfigsCache.get(channelName) || await getTtsState(channelName);
        if (!currentConfig.userPreferences) currentConfig.userPreferences = {};
        if (!currentConfig.userPreferences[userKey]) currentConfig.userPreferences[userKey] = {};
        currentConfig.userPreferences[userKey].emotion = emotion.toLowerCase();
        channelConfigsCache.set(channelName, currentConfig);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName, user: userKey, emotion }, 'Failed to set user TTS emotion preference in Firestore.');
        return false;
    }
}

// Clear user-specific emotion preference (revert to channel default/auto)
export async function clearUserEmotionPreference(channelName, username, userId) {
    // Use userId as primary key (immutable), fall back to username
    const userKey = userId || username.toLowerCase();
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelName);
    const fieldPath = `userPreferences.${userKey}.emotion`;

    try {
        await docRef.update({
            [fieldPath]: FieldValue.delete(), // Deletes the emotion field for the user
            updatedAt: FieldValue.serverTimestamp()
        });
        logger.info(`[${channelName}] Cleared user TTS emotion preference for ${userKey}.`);
        // Update cache
        const currentConfig = channelConfigsCache.get(channelName) || await getTtsState(channelName);
        if (currentConfig.userPreferences && currentConfig.userPreferences[userKey]) {
            delete currentConfig.userPreferences[userKey].emotion;
            // Optional: if userPreferences[userKey] is now empty, delete it too
            if (Object.keys(currentConfig.userPreferences[userKey]).length === 0) {
                delete currentConfig.userPreferences[userKey];
            }
        }
        channelConfigsCache.set(channelName, currentConfig);
        return true;
    } catch (error) {
        // It might fail if the field doesn't exist, which is fine.
        if (error.code === 5) { // Firestore: NOT_FOUND (usually if trying to delete a non-existent field path directly)
            logger.debug(`[${channelName}] No specific emotion preference to clear for user ${userKey}.`);
            // Ensure cache reflects this state
            const currentConfig = channelConfigsCache.get(channelName) || await getTtsState(channelName);
            if (currentConfig.userPreferences && currentConfig.userPreferences[userKey]) {
                delete currentConfig.userPreferences[userKey].emotion;
                if (Object.keys(currentConfig.userPreferences[userKey]).length === 0) {
                    delete currentConfig.userPreferences[userKey];
                }
            }
            channelConfigsCache.set(channelName, currentConfig);
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
    const availableVoices = await getAvailableVoices();
    const isValidVoice = availableVoices.some(v => v.id === voiceId);

    if (!isValidVoice) {
        logger.warn(`[${channelName}] Attempt to set invalid voice_id '${voiceId}' for user ${username}.`);
        return false;
    }

    // Use userId as primary key (immutable), fall back to username
    const userKey = userId || username.toLowerCase();
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelName);
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
        const currentConfig = channelConfigsCache.get(channelName) || await getTtsState(channelName);
        if (!currentConfig.userPreferences) currentConfig.userPreferences = {};
        if (!currentConfig.userPreferences[userKey]) currentConfig.userPreferences[userKey] = {};
        currentConfig.userPreferences[userKey].voiceId = voiceId;
        channelConfigsCache.set(channelName, currentConfig);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName, user: userKey, voiceId }, 'Failed to set user TTS voice preference in Firestore.');
        return false;
    }
}

export async function clearUserVoicePreference(channelName, username, userId) {
    // Use userId as primary key (immutable), fall back to username
    const userKey = userId || username.toLowerCase();
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelName);
    const fieldPath = `userPreferences.${userKey}.voiceId`;

    try {
        await docRef.update({
            [fieldPath]: FieldValue.delete(),
            updatedAt: FieldValue.serverTimestamp()
        });
        logger.info(`[${channelName}] Cleared user TTS voice preference for ${userKey}.`);
        const currentConfig = channelConfigsCache.get(channelName) || await getTtsState(channelName);
        if (currentConfig.userPreferences && currentConfig.userPreferences[userKey]) {
            delete currentConfig.userPreferences[userKey].voiceId;
            if (Object.keys(currentConfig.userPreferences[userKey]).length === 0) {
                delete currentConfig.userPreferences[userKey];
            }
        }
        channelConfigsCache.set(channelName, currentConfig);
        return true;
    } catch (error) {
        if (error.code === 5) { // Firestore: NOT_FOUND (field doesn't exist)
            logger.debug(`[${channelName}] No specific voice preference to clear for user ${userKey}.`);
            const currentConfig = channelConfigsCache.get(channelName) || await getTtsState(channelName);
            if (currentConfig.userPreferences && currentConfig.userPreferences[userKey]) {
                delete currentConfig.userPreferences[userKey].voiceId;
                if (Object.keys(currentConfig.userPreferences[userKey]).length === 0) {
                    delete currentConfig.userPreferences[userKey];
                }
            }
            channelConfigsCache.set(channelName, currentConfig);
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
    const parsedPitch = parseInt(pitch, 10);
    if (isNaN(parsedPitch) || parsedPitch < TTS_PITCH_MIN || parsedPitch > TTS_PITCH_MAX) {
        logger.warn(`[${channelName}] Attempt to set invalid pitch preference '${pitch}' for user ${username}.`);
        return false;
    }
    // Use userId as primary key (immutable), fall back to username
    const userKey = userId || username.toLowerCase();
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelName);
    try {
        await docRef.set({
            userPreferences: { [userKey]: { pitch: parsedPitch } },
            updatedAt: FieldValue.serverTimestamp()
        }, { mergeFields: [`userPreferences.${userKey}.pitch`, 'updatedAt'] });

        logger.info(`[${channelName}] User TTS pitch preference updated for ${userKey}: ${parsedPitch}`);
        const currentConfig = channelConfigsCache.get(channelName) || await getTtsState(channelName);
        if (!currentConfig.userPreferences) currentConfig.userPreferences = {};
        if (!currentConfig.userPreferences[userKey]) currentConfig.userPreferences[userKey] = {};
        currentConfig.userPreferences[userKey].pitch = parsedPitch;
        channelConfigsCache.set(channelName, currentConfig);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName, user: userKey, pitch: parsedPitch }, 'Failed to set user TTS pitch preference in Firestore.');
        return false;
    }
}

export async function clearUserPitchPreference(channelName, username, userId) {
    // Use userId as primary key (immutable), fall back to username
    const userKey = userId || username.toLowerCase();
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelName);
    const fieldPath = `userPreferences.${userKey}.pitch`;
    try {
        await docRef.update({ [fieldPath]: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
        logger.info(`[${channelName}] Cleared user TTS pitch preference for ${userKey}.`);
        const currentConfig = channelConfigsCache.get(channelName) || await getTtsState(channelName);
        if (currentConfig.userPreferences && currentConfig.userPreferences[userKey]) {
            delete currentConfig.userPreferences[userKey].pitch;
            if (Object.keys(currentConfig.userPreferences[userKey]).length === 0) {
                delete currentConfig.userPreferences[userKey];
            }
        }
        channelConfigsCache.set(channelName, currentConfig);
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
    const parsedSpeed = parseFloat(speed);
    if (isNaN(parsedSpeed) || parsedSpeed < TTS_SPEED_MIN || parsedSpeed > TTS_SPEED_MAX) {
        logger.warn(`[${channelName}] Attempt to set invalid speed preference '${speed}' for user ${username}.`);
        return false;
    }
    // Use userId as primary key (immutable), fall back to username
    const userKey = userId || username.toLowerCase();
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelName);
    try {
        await docRef.set({
            userPreferences: { [userKey]: { speed: parsedSpeed } },
            updatedAt: FieldValue.serverTimestamp()
        }, { mergeFields: [`userPreferences.${userKey}.speed`, 'updatedAt'] });

        logger.info(`[${channelName}] User TTS speed preference updated for ${userKey}: ${parsedSpeed}`);
        const currentConfig = channelConfigsCache.get(channelName) || await getTtsState(channelName);
        if (!currentConfig.userPreferences) currentConfig.userPreferences = {};
        if (!currentConfig.userPreferences[userKey]) currentConfig.userPreferences[userKey] = {};
        currentConfig.userPreferences[userKey].speed = parsedSpeed;
        channelConfigsCache.set(channelName, currentConfig);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName, user: userKey, speed: parsedSpeed }, 'Failed to set user TTS speed preference in Firestore.');
        return false;
    }
}

export async function clearUserSpeedPreference(channelName, username, userId) {
    // Use userId as primary key (immutable), fall back to username
    const userKey = userId || username.toLowerCase();
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelName);
    const fieldPath = `userPreferences.${userKey}.speed`;
    try {
        await docRef.update({ [fieldPath]: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
        logger.info(`[${channelName}] Cleared user TTS speed preference for ${userKey}.`);
        const currentConfig = channelConfigsCache.get(channelName) || await getTtsState(channelName);
        if (currentConfig.userPreferences && currentConfig.userPreferences[userKey]) {
            delete currentConfig.userPreferences[userKey].speed;
            if (Object.keys(currentConfig.userPreferences[userKey]).length === 0) {
                delete currentConfig.userPreferences[userKey];
            }
        }
        channelConfigsCache.set(channelName, currentConfig);
        return true;
    } catch (error) {
        if (error.code === 5) { return true; }
        logger.error({ err: error, channel: channelName, user: userKey }, 'Failed to clear user TTS speed preference.');
        return false;
    }
}

// --- Functions for Voice Volumes ---
export async function getVoiceVolumes(channelName) {
    const config = await getTtsState(channelName);
    return config.voiceVolumes || {};
}

export async function setVoiceVolume(channelName, voiceId, volume) {
    const parsedVolume = parseFloat(volume);
    if (isNaN(parsedVolume) || parsedVolume <= 0 || parsedVolume > 10) {
        logger.warn(`[${channelName}] Attempt to set invalid volume '${volume}' for voice ${voiceId}.`);
        return false;
    }
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelName);
    try {
        // Use dot notation for nested update in Firestore
        await docRef.set({
            voiceVolumes: { [voiceId]: parsedVolume },
            updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });

        logger.info(`[${channelName}] Voice volume updated for ${voiceId}: ${parsedVolume}`);

        // Update cache
        const currentConfig = channelConfigsCache.get(channelName) || await getTtsState(channelName);
        if (!currentConfig.voiceVolumes) currentConfig.voiceVolumes = {};
        currentConfig.voiceVolumes[voiceId] = parsedVolume;
        channelConfigsCache.set(channelName, currentConfig);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName, voiceId, volume }, 'Failed to set voice volume in Firestore.');
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
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelName);
    try {
        await docRef.set({
            userPreferences: { [userKey]: { languageBoost: language } },
            updatedAt: FieldValue.serverTimestamp()
        }, { mergeFields: [`userPreferences.${userKey}.languageBoost`, 'updatedAt'] });
        logger.info(`[${channelName}] User TTS language preference updated for ${userKey}: ${language}`);
        const currentConfig = channelConfigsCache.get(channelName) || await getTtsState(channelName);
        if (!currentConfig.userPreferences) currentConfig.userPreferences = {};
        if (!currentConfig.userPreferences[userKey]) currentConfig.userPreferences[userKey] = {};
        currentConfig.userPreferences[userKey].languageBoost = language;
        channelConfigsCache.set(channelName, currentConfig);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName, user: userKey, language: language }, 'Failed to set user TTS language preference in Firestore.');
        return false;
    }
}

export async function clearUserLanguagePreference(channelName, username, userId) {
    // Use userId as primary key (immutable), fall back to username
    const userKey = userId || username.toLowerCase();
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelName);
    const fieldPath = `userPreferences.${userKey}.languageBoost`;
    try {
        await docRef.update({ [fieldPath]: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
        logger.info(`[${channelName}] Cleared user TTS language preference for ${userKey}.`);
        const currentConfig = channelConfigsCache.get(channelName) || await getTtsState(channelName);
        if (currentConfig.userPreferences && currentConfig.userPreferences[userKey]) {
            delete currentConfig.userPreferences[userKey].languageBoost;
            if (Object.keys(currentConfig.userPreferences[userKey]).length === 0) {
                delete currentConfig.userPreferences[userKey];
            }
        }
        channelConfigsCache.set(channelName, currentConfig);
        return true;
    } catch (error) {
        if (error.code === 5) { return true; }
        logger.error({ err: error, channel: channelName, user: userKey }, 'Failed to clear user TTS language preference.');
        return false;
    }
}

async function getUserPreferences(channelName, username, userId) {
    const channelConfig = await getTtsState(channelName);
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
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelName);
    try {
        await docRef.set({
            userPreferences: { [userKey]: { [preferenceKey]: value } },
            updatedAt: FieldValue.serverTimestamp()
        }, { mergeFields: [`userPreferences.${userKey}.${preferenceKey}`, 'updatedAt'] });
        logger.info(`[${channelName}] User TTS preference updated for ${userKey}: ${preferenceKey} = ${value}`);
        const currentConfig = channelConfigsCache.get(channelName) || await getTtsState(channelName);
        if (!currentConfig.userPreferences) currentConfig.userPreferences = {};
        if (!currentConfig.userPreferences[userKey]) currentConfig.userPreferences[userKey] = {};
        currentConfig.userPreferences[userKey][preferenceKey] = value;
        currentConfig.updatedAt = new Date();
        channelConfigsCache.set(channelName, currentConfig);
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
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelName);
    try {
        const updatePayload = {
            bitsModeEnabled: enabled,
            bitsMinimumAmount: minimumAmount,
            updatedAt: FieldValue.serverTimestamp()
        };
        await docRef.set(updatePayload, { merge: true });
        logger.info(`[${channelName}] Bits-for-TTS config updated: Enabled=${enabled}, Min=${minimumAmount}`);
        // Update local cache
        const currentConfig = channelConfigsCache.get(channelName) || {};
        channelConfigsCache.set(channelName, { ...currentConfig, ...updatePayload });
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

export {
    getUserEnglishNormalizationPreference,
    setUserEnglishNormalizationPreference
}
