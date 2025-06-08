// src/components/music/musicState.js
import { Firestore, FieldValue } from '@google-cloud/firestore';
import logger from '../../lib/logger.js';

let db;
const MUSIC_COLLECTION = 'musicSettings';

// In-memory cache of music configs
const musicConfigsCache = new Map();

// Define default settings, now with 'everyone' for allowedRoles
const DEFAULT_MUSIC_SETTINGS = {
    enabled: false,
    maxQueueLength: 10,
    allowedRoles: ['everyone'], // Changed default to 'everyone'
    cooldownSeconds: 300,
    ignoredUsers: [], // Added ignoredUsers
    bitsModeEnabled: false, 
    bitsMinimumAmount: 100, 
    updatedAt: null
};

export async function initializeMusicState() {
    if (!db) db = new Firestore();
    logger.info('Initializing Music State from Firestore...');
    try {
        const snapshot = await db.collection(MUSIC_COLLECTION).get();
        snapshot.forEach(doc => {
            const data = doc.data();
            musicConfigsCache.set(doc.id, {
                ...DEFAULT_MUSIC_SETTINGS, // Spread defaults first
                ...data // Then override with Firestore data
            });
        });
        logger.info(`Loaded music configs for ${musicConfigsCache.size} channels.`);
    } catch (error) {
        logger.error({ err: error }, 'Failed to initialize music state from Firestore.');
    }
}

export async function getMusicState(channelName) {
    if (musicConfigsCache.has(channelName)) {
        // Ensure all default fields are present even for cached items, especially new ones
        const cachedConfig = musicConfigsCache.get(channelName);
        return { ...DEFAULT_MUSIC_SETTINGS, ...cachedConfig };
    }
    
    try {
        const docRef = db.collection(MUSIC_COLLECTION).doc(channelName);
        const docSnap = await docRef.get();
        if (docSnap.exists) {
            const data = docSnap.data();
            const config = {
                ...DEFAULT_MUSIC_SETTINGS, // Spread defaults first
                ...data // Then override with Firestore data
            };
            musicConfigsCache.set(channelName, config);
            return config;
        }
    } catch (error) {
        logger.error({ err: error, channel: channelName }, `Error fetching music state for ${channelName} from Firestore.`);
    }
    
    // If not in cache and not in Firestore, create new default config
    const defaultConfigCopy = { ...DEFAULT_MUSIC_SETTINGS };
    musicConfigsCache.set(channelName, defaultConfigCopy);
    return defaultConfigCopy;
}

/**
 * Sets the Bits-for-Music configuration for a channel.
 * @param {string} channelName - The name of the channel.
 * @param {object} bitsConfig - An object containing { enabled, minimumAmount }.
 * @returns {Promise<boolean>}
 */
export async function setBitsConfigMusic(channelName, { enabled, minimumAmount }) {
    const docRef = db.collection(MUSIC_COLLECTION).doc(channelName);
    try {
        const updatePayload = {
            bitsModeEnabled: enabled,
            bitsMinimumAmount: minimumAmount,
            updatedAt: FieldValue.serverTimestamp()
        };
        await docRef.set(updatePayload, { merge: true });
        logger.info(`[${channelName}] Bits-for-Music config updated: Enabled=${enabled}, Min=${minimumAmount}`);
        
        // Update local cache
        const currentConfig = await getMusicState(channelName); // Ensures we have the full config
        musicConfigsCache.set(channelName, { ...currentConfig, ...updatePayload });
        
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName }, 'Failed to set Bits-for-Music config.');
        return false;
    }
}


export async function setMusicEnabled(channelName, enabled) {
    try {
        const docRef = db.collection(MUSIC_COLLECTION).doc(channelName);
        await docRef.set({
            enabled,
            updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        
        const currentConfig = await getMusicState(channelName); // Ensures we have full config
        musicConfigsCache.set(channelName, { ...currentConfig, enabled, updatedAt: new Date() });
        
        logger.info(`[${channelName}] Music generation ${enabled ? 'enabled' : 'disabled'}`);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName, enabled }, 'Error updating music enabled state');
        return false;
    }
}

export async function setAllowedMusicRoles(channelName, rolesArray) {
    if (!Array.isArray(rolesArray) || !rolesArray.every(role => typeof role === 'string' && ['everyone', 'moderator', 'subscriber', 'vip'].includes(role))) {
        logger.error(`[${channelName}] Invalid roles array for setAllowedMusicRoles: ${JSON.stringify(rolesArray)}`);
        return false;
    }
    try {
        const docRef = db.collection(MUSIC_COLLECTION).doc(channelName);
        await docRef.set({
            allowedRoles: rolesArray,
            updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        
        const currentConfig = await getMusicState(channelName);
        musicConfigsCache.set(channelName, { ...currentConfig, allowedRoles: rolesArray, updatedAt: new Date() });
        
        logger.info(`[${channelName}] Music allowedRoles set to: ${rolesArray.join(', ')}`);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName, roles: rolesArray }, 'Error setting allowed music roles');
        return false;
    }
}

export async function addIgnoredUserMusic(channelName, username) {
    const lowerUser = username.toLowerCase();
    const docRef = db.collection(MUSIC_COLLECTION).doc(channelName);
    try {
        await docRef.set({ // Use set with merge to ensure doc exists
            ignoredUsers: FieldValue.arrayUnion(lowerUser),
            updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        
        const config = await getMusicState(channelName);
        if (!config.ignoredUsers.includes(lowerUser)) {
            config.ignoredUsers.push(lowerUser);
        }
        musicConfigsCache.set(channelName, { ...config, updatedAt: new Date() }); // Ensure updatedAt is also updated in cache
        logger.info(`[${channelName}] User ${lowerUser} added to music ignore list.`);
        return true;
    } catch (error) { 
        logger.error({ err: error, channel: channelName, user: lowerUser }, 'Failed to add user to music ignore list in Firestore.');
        return false; 
    }
}

export async function removeIgnoredUserMusic(channelName, username) {
    const lowerUser = username.toLowerCase();
    const docRef = db.collection(MUSIC_COLLECTION).doc(channelName);
    try {
        await docRef.update({ // Update should be fine if we ensure doc via set on add
            ignoredUsers: FieldValue.arrayRemove(lowerUser),
            updatedAt: FieldValue.serverTimestamp()
        });
        
        const config = await getMusicState(channelName);
        if (config.ignoredUsers) {
            config.ignoredUsers = config.ignoredUsers.filter(user => user !== lowerUser);
        }
        musicConfigsCache.set(channelName, { ...config, updatedAt: new Date() });
        logger.info(`[${channelName}] User ${lowerUser} removed from music ignore list.`);
        return true;
    } catch (error) {
        // Firestore's arrayRemove doesn't error if the item isn't present,
        // but it might error if the document or ignoredUsers field doesn't exist.
        // Let's ensure the cache reflects the desired state (user not in list).
        const config = await getMusicState(channelName);
        if (config.ignoredUsers) {
            config.ignoredUsers = config.ignoredUsers.filter(user => user !== lowerUser);
        }
        musicConfigsCache.set(channelName, { ...config, updatedAt: new Date() });
        logger.warn({ err: error, channel: channelName, user: lowerUser }, 'Error removing user from music ignore list in Firestore, but cache updated.');
        return true; // From user's perspective, operation appears successful if user is not in list.
    }
}