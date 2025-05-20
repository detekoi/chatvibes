// src/components/tts/ttsState.js
import { Firestore, FieldValue } from '@google-cloud/firestore';
import logger from '../../lib/logger.js';
import {
    DEFAULT_TTS_SETTINGS,
    VALID_EMOTIONS,
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

// In-memory cache of channel configs
const channelConfigsCache = new Map();
let firestoreListenerUnsubscribe = null;

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
                const channelName = change.doc.id;
                const data = change.doc.data();
                if (change.type === 'added' || change.type === 'modified') {
                    logger.info(`TTS config for ${channelName} ${change.type}. Updating cache.`);
                    channelConfigsCache.set(channelName, {
                        ...DEFAULT_TTS_SETTINGS,
                        ...data,
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
            const config = { ...DEFAULT_TTS_SETTINGS, ...data, userPreferences: data.userPreferences || {} };
            channelConfigsCache.set(channelName, config);
            return config;
        }
    } catch (error) {
        logger.error({ err: error, channel: channelName }, `Error fetching TTS state for ${channelName} from Firestore.`);
    }
    const defaultConfigCopy = { ...DEFAULT_TTS_SETTINGS, userPreferences: {} };
    channelConfigsCache.set(channelName, defaultConfigCopy);
    return defaultConfigCopy;
}

export async function getChannelTtsConfig(channelName) {
    const fullState = await getTtsState(channelName);
    // Extract only TTS parameters
    const { voiceId, speed, volume, pitch, emotion, englishNormalization, sampleRate, bitrate, channel, languageBoost } = fullState;
    return { voiceId, speed, volume, pitch, emotion, englishNormalization, sampleRate, bitrate, channel, languageBoost };
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
// Functions for managing ignored users
export async function addIgnoredUser(channelName, username) {
    const lowerUser = username.toLowerCase();
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelName);
    try {
        await docRef.update({
            ignoredUsers: FieldValue.arrayUnion(lowerUser),
            updatedAt: FieldValue.serverTimestamp()
        });
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

// Get user-specific emotion preference
export async function getUserEmotionPreference(channelName, username) {
    const lowerUser = username.toLowerCase();
    const channelConfig = await getTtsState(channelName); // This now includes userPreferences
    return channelConfig.userPreferences?.[lowerUser]?.emotion || null;
}

// Set user-specific emotion preference
export async function setUserEmotionPreference(channelName, username, emotion) {
    if (!VALID_EMOTIONS.includes(emotion.toLowerCase())) {
        logger.warn(`[${channelName}] Attempt to set invalid emotion '${emotion}' for user ${username}.`);
        return false;
    }
    const lowerUser = username.toLowerCase();
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelName);
    try {
        await docRef.set({
            userPreferences: {
                [lowerUser]: {
                    emotion: emotion.toLowerCase()
                }
            },
            updatedAt: FieldValue.serverTimestamp()
        }, { merge: true }); // Use merge:true to not overwrite other userPreferences

        logger.info(`[${channelName}] User TTS emotion preference updated for ${lowerUser}: ${emotion}`);
        // Update cache
        const currentConfig = channelConfigsCache.get(channelName) || await getTtsState(channelName);
        if (!currentConfig.userPreferences) currentConfig.userPreferences = {};
        if (!currentConfig.userPreferences[lowerUser]) currentConfig.userPreferences[lowerUser] = {};
        currentConfig.userPreferences[lowerUser].emotion = emotion.toLowerCase();
        channelConfigsCache.set(channelName, currentConfig);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName, user: lowerUser, emotion }, 'Failed to set user TTS emotion preference in Firestore.');
        return false;
    }
}

// Clear user-specific emotion preference (revert to channel default/auto)
export async function clearUserEmotionPreference(channelName, username) {
    const lowerUser = username.toLowerCase();
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelName);
    const fieldPath = `userPreferences.${lowerUser}.emotion`;

    try {
        await docRef.update({
            [fieldPath]: FieldValue.delete(), // Deletes the emotion field for the user
            updatedAt: FieldValue.serverTimestamp()
        });
        logger.info(`[${channelName}] Cleared user TTS emotion preference for ${lowerUser}.`);
        // Update cache
        const currentConfig = channelConfigsCache.get(channelName) || await getTtsState(channelName);
        if (currentConfig.userPreferences && currentConfig.userPreferences[lowerUser]) {
            delete currentConfig.userPreferences[lowerUser].emotion;
            // Optional: if userPreferences[lowerUser] is now empty, delete it too
            if (Object.keys(currentConfig.userPreferences[lowerUser]).length === 0) {
                delete currentConfig.userPreferences[lowerUser];
            }
        }
        channelConfigsCache.set(channelName, currentConfig);
        return true;
    } catch (error) {
        // It might fail if the field doesn't exist, which is fine.
        if (error.code === 5) { // Firestore: NOT_FOUND (usually if trying to delete a non-existent field path directly)
            logger.debug(`[${channelName}] No specific emotion preference to clear for user ${lowerUser}.`);
             // Ensure cache reflects this state
            const currentConfig = channelConfigsCache.get(channelName) || await getTtsState(channelName);
            if (currentConfig.userPreferences && currentConfig.userPreferences[lowerUser]) {
                delete currentConfig.userPreferences[lowerUser].emotion;
                if (Object.keys(currentConfig.userPreferences[lowerUser]).length === 0) {
                    delete currentConfig.userPreferences[lowerUser];
                }
            }
            channelConfigsCache.set(channelName, currentConfig);
            return true; // Considered success as the end state is "no preference"
        }
        logger.error({ err: error, channel: channelName, user: lowerUser }, 'Failed to clear user TTS emotion preference in Firestore.');
        return false;
    }
}

// --- NEW FUNCTIONS FOR VOICE PREFERENCE ---
export async function getUserVoicePreference(channelName, username) {
    const lowerUser = username.toLowerCase();
    const channelConfig = await getTtsState(channelName);
    return channelConfig.userPreferences?.[lowerUser]?.voiceId || null;
}

export async function setUserVoicePreference(channelName, username, voiceId) {
    const availableVoices = await getAvailableVoices();
    const isValidVoice = availableVoices.some(v => v.id === voiceId);

    if (!isValidVoice) {
        logger.warn(`[${channelName}] Attempt to set invalid voice_id '${voiceId}' for user ${username}.`);
        return false;
    }

    const lowerUser = username.toLowerCase();
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelName);
    try {
        // Using mergeFields to precisely update only the voiceId for the specific user
        await docRef.set({
            userPreferences: {
                [lowerUser]: {
                    voiceId: voiceId
                }
            },
            updatedAt: FieldValue.serverTimestamp()
        }, { mergeFields: [`userPreferences.${lowerUser}.voiceId`, 'updatedAt'] });

        logger.info(`[${channelName}] User TTS voice preference updated for ${lowerUser}: ${voiceId}`);
        const currentConfig = channelConfigsCache.get(channelName) || await getTtsState(channelName);
        if (!currentConfig.userPreferences) currentConfig.userPreferences = {};
        if (!currentConfig.userPreferences[lowerUser]) currentConfig.userPreferences[lowerUser] = {};
        currentConfig.userPreferences[lowerUser].voiceId = voiceId;
        channelConfigsCache.set(channelName, currentConfig);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName, user: lowerUser, voiceId }, 'Failed to set user TTS voice preference in Firestore.');
        return false;
    }
}

export async function clearUserVoicePreference(channelName, username) {
    const lowerUser = username.toLowerCase();
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelName);
    const fieldPath = `userPreferences.${lowerUser}.voiceId`;

    try {
        await docRef.update({
            [fieldPath]: FieldValue.delete(),
            updatedAt: FieldValue.serverTimestamp()
        });
        logger.info(`[${channelName}] Cleared user TTS voice preference for ${lowerUser}.`);
        const currentConfig = channelConfigsCache.get(channelName) || await getTtsState(channelName);
        if (currentConfig.userPreferences && currentConfig.userPreferences[lowerUser]) {
            delete currentConfig.userPreferences[lowerUser].voiceId;
            if (Object.keys(currentConfig.userPreferences[lowerUser]).length === 0) {
                delete currentConfig.userPreferences[lowerUser];
            }
        }
        channelConfigsCache.set(channelName, currentConfig);
        return true;
    } catch (error) {
        if (error.code === 5) { // Firestore: NOT_FOUND (field doesn't exist)
            logger.debug(`[${channelName}] No specific voice preference to clear for user ${lowerUser}.`);
            const currentConfig = channelConfigsCache.get(channelName) || await getTtsState(channelName);
            if (currentConfig.userPreferences && currentConfig.userPreferences[lowerUser]) {
                delete currentConfig.userPreferences[lowerUser].voiceId;
                if (Object.keys(currentConfig.userPreferences[lowerUser]).length === 0) {
                    delete currentConfig.userPreferences[lowerUser];
                }
            }
            channelConfigsCache.set(channelName, currentConfig);
            return true;
        }
        logger.error({ err: error, channel: channelName, user: lowerUser }, 'Failed to clear user TTS voice preference in Firestore.');
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
export async function getUserPitchPreference(channelName, username) {
    const lowerUser = username.toLowerCase();
    const channelConfig = await getTtsState(channelName);
    return channelConfig.userPreferences?.[lowerUser]?.pitch ?? null;
}

export async function setUserPitchPreference(channelName, username, pitch) {
    const parsedPitch = parseInt(pitch, 10);
    if (isNaN(parsedPitch) || parsedPitch < TTS_PITCH_MIN || parsedPitch > TTS_PITCH_MAX) {
        logger.warn(`[${channelName}] Attempt to set invalid pitch preference '${pitch}' for user ${username}.`);
        return false;
    }
    const lowerUser = username.toLowerCase();
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelName);
    try {
        await docRef.set({
            userPreferences: { [lowerUser]: { pitch: parsedPitch } },
            updatedAt: FieldValue.serverTimestamp()
        }, { mergeFields: [`userPreferences.${lowerUser}.pitch`, 'updatedAt'] });

        logger.info(`[${channelName}] User TTS pitch preference updated for ${lowerUser}: ${parsedPitch}`);
        const currentConfig = channelConfigsCache.get(channelName) || await getTtsState(channelName);
        if (!currentConfig.userPreferences) currentConfig.userPreferences = {};
        if (!currentConfig.userPreferences[lowerUser]) currentConfig.userPreferences[lowerUser] = {};
        currentConfig.userPreferences[lowerUser].pitch = parsedPitch;
        channelConfigsCache.set(channelName, currentConfig);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName, user: lowerUser, pitch: parsedPitch }, 'Failed to set user TTS pitch preference in Firestore.');
        return false;
    }
}

export async function clearUserPitchPreference(channelName, username) {
    const lowerUser = username.toLowerCase();
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelName);
    const fieldPath = `userPreferences.${lowerUser}.pitch`;
    try {
        await docRef.update({ [fieldPath]: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
        logger.info(`[${channelName}] Cleared user TTS pitch preference for ${lowerUser}.`);
        const currentConfig = channelConfigsCache.get(channelName) || await getTtsState(channelName);
        if (currentConfig.userPreferences && currentConfig.userPreferences[lowerUser]) {
            delete currentConfig.userPreferences[lowerUser].pitch;
            if (Object.keys(currentConfig.userPreferences[lowerUser]).length === 0) {
                delete currentConfig.userPreferences[lowerUser];
            }
        }
        channelConfigsCache.set(channelName, currentConfig);
        return true;
    } catch (error) {
        if (error.code === 5) { return true; }
        logger.error({ err: error, channel: channelName, user: lowerUser }, 'Failed to clear user TTS pitch preference.');
        return false;
    }
}

// --- Functions for User-specific Speed Preference ---
export async function getUserSpeedPreference(channelName, username) {
    const lowerUser = username.toLowerCase();
    const channelConfig = await getTtsState(channelName);
    return channelConfig.userPreferences?.[lowerUser]?.speed ?? null;
}

export async function setUserSpeedPreference(channelName, username, speed) {
    const parsedSpeed = parseFloat(speed);
    if (isNaN(parsedSpeed) || parsedSpeed < TTS_SPEED_MIN || parsedSpeed > TTS_SPEED_MAX) {
        logger.warn(`[${channelName}] Attempt to set invalid speed preference '${speed}' for user ${username}.`);
        return false;
    }
    const lowerUser = username.toLowerCase();
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelName);
    try {
        await docRef.set({
            userPreferences: { [lowerUser]: { speed: parsedSpeed } },
            updatedAt: FieldValue.serverTimestamp()
        }, { mergeFields: [`userPreferences.${lowerUser}.speed`, 'updatedAt'] });

        logger.info(`[${channelName}] User TTS speed preference updated for ${lowerUser}: ${parsedSpeed}`);
        const currentConfig = channelConfigsCache.get(channelName) || await getTtsState(channelName);
        if (!currentConfig.userPreferences) currentConfig.userPreferences = {};
        if (!currentConfig.userPreferences[lowerUser]) currentConfig.userPreferences[lowerUser] = {};
        currentConfig.userPreferences[lowerUser].speed = parsedSpeed;
        channelConfigsCache.set(channelName, currentConfig);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName, user: lowerUser, speed: parsedSpeed }, 'Failed to set user TTS speed preference in Firestore.');
        return false;
    }
}

export async function clearUserSpeedPreference(channelName, username) {
    const lowerUser = username.toLowerCase();
    const docRef = db.collection(TTS_CONFIG_COLLECTION).doc(channelName);
    const fieldPath = `userPreferences.${lowerUser}.speed`;
    try {
        await docRef.update({ [fieldPath]: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
        logger.info(`[${channelName}] Cleared user TTS speed preference for ${lowerUser}.`);
        const currentConfig = channelConfigsCache.get(channelName) || await getTtsState(channelName);
        if (currentConfig.userPreferences && currentConfig.userPreferences[lowerUser]) {
            delete currentConfig.userPreferences[lowerUser].speed;
            if (Object.keys(currentConfig.userPreferences[lowerUser]).length === 0) {
                delete currentConfig.userPreferences[lowerUser];
            }
        }
        channelConfigsCache.set(channelName, currentConfig);
        return true;
    } catch (error) {
        if (error.code === 5) { return true; }
        logger.error({ err: error, channel: channelName, user: lowerUser }, 'Failed to clear user TTS speed preference.');
        return false;
    }
}