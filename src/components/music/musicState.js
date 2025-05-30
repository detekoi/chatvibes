import { Firestore, FieldValue } from '@google-cloud/firestore';
import logger from '../../lib/logger.js';

let db;
const MUSIC_COLLECTION = 'musicSettings';

// In-memory cache of music configs
const musicConfigsCache = new Map();

export async function initializeMusicState() {
    if (!db) db = new Firestore();
    logger.info('Initializing Music State from Firestore...');
    try {
        const snapshot = await db.collection(MUSIC_COLLECTION).get();
        snapshot.forEach(doc => {
            const data = doc.data();
            musicConfigsCache.set(doc.id, {
                enabled: false,
                maxQueueLength: 10,
                allowedRoles: ['moderator'],
                cooldownSeconds: 300,
                ...data
            });
        });
        logger.info(`Loaded music configs for ${musicConfigsCache.size} channels.`);
    } catch (error) {
        logger.error({ err: error }, 'Failed to initialize music state from Firestore.');
    }
}

export async function getMusicState(channelName) {
    if (musicConfigsCache.has(channelName)) {
        return musicConfigsCache.get(channelName);
    }
    
    try {
        const docRef = db.collection(MUSIC_COLLECTION).doc(channelName);
        const docSnap = await docRef.get();
        if (docSnap.exists) {
            const data = docSnap.data();
            const config = {
                enabled: false,
                maxQueueLength: 10,
                allowedRoles: ['moderator'],
                cooldownSeconds: 300,
                ...data
            };
            musicConfigsCache.set(channelName, config);
            return config;
        }
    } catch (error) {
        logger.error({ err: error, channel: channelName }, `Error fetching music state for ${channelName} from Firestore.`);
    }
    
    const defaultConfig = {
        enabled: false,
        maxQueueLength: 10,
        allowedRoles: ['moderator'],
        cooldownSeconds: 300
    };
    musicConfigsCache.set(channelName, defaultConfig);
    return defaultConfig;
}

export async function setMusicEnabled(channelName, enabled) {
    try {
        const docRef = db.collection(MUSIC_COLLECTION).doc(channelName);
        await docRef.set({
            enabled,
            updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        
        // Update cache
        const currentConfig = musicConfigsCache.get(channelName) || await getMusicState(channelName);
        musicConfigsCache.set(channelName, { ...currentConfig, enabled });
        
        logger.info(`[${channelName}] Music generation ${enabled ? 'enabled' : 'disabled'}`);
        return true;
    } catch (error) {
        logger.error({ err: error, channel: channelName, enabled }, 'Error updating music state');
        return false;
    }
}