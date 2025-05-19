// src/components/tts/ttsState.js
import { Firestore, FieldValue } from '@google-cloud/firestore';
import logger from '../../lib/logger.js';
import { DEFAULT_TTS_SETTINGS, VALID_EMOTIONS } from './ttsConstants.js'; // Import VALID_EMOTIONS

let db;
const TTS_CONFIG_COLLECTION = 'ttsChannelConfigs';
const DEFAULT_TTS_CONFIG = { /* loaded from ttsConstants.js */
    engineEnabled: true,
    mode: 'command', // 'all' or 'command'
    voiceId: 'Friendly_Person',
    speed: 1.0,
    volume: 1.0,
    pitch: 0,
    emotion: 'neutral',
    speakEvents: true,
    ignoredUsers: []
};

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
// ... other setter functions for ignoredUsers, etc.
// Example:
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
    } catch (error) { /* ... */ return false; }
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