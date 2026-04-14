// src/components/twitch/channelManager.js
import { Firestore } from '@google-cloud/firestore';
import logger from '../../lib/logger.js';

import { updateAllowedChannels, addAllowedChannel, removeAllowedChannel } from '../../lib/allowList.js';

// --- Firestore Client Initialization ---
let db = null; // Firestore database instance

// Collection name (must match the name used in chatsage-web-ui)
const MANAGED_CHANNELS_COLLECTION = 'managedChannels';

/**
 * Custom error class for channel management operations.
 */
export class ChannelManagerError extends Error {
    constructor(message, cause) {
        super(message);
        this.name = 'ChannelManagerError';
        this.cause = cause;
    }
}

/**
 * Initializes the Google Cloud Firestore client.
 * Relies on Application Default Credentials or GOOGLE_APPLICATION_CREDENTIALS environment variable.
 */
export async function initializeChannelManager() {
    logger.info("[ChannelManager] Initializing Google Cloud Firestore client for channel management...");
    try {
        // Create a new client
        db = new Firestore();

        logger.debug("[ChannelManager] Firestore client created, testing connection...");

        // Test connection by fetching a document
        const testQuery = db.collection(MANAGED_CHANNELS_COLLECTION).limit(1);
        logger.debug("[ChannelManager] Executing test query...");
        const result = await testQuery.get();

        logger.debug(`[ChannelManager] Test query successful. Found ${result.size} documents.`);
        logger.info("[ChannelManager] Google Cloud Firestore client initialized and connected.");
    } catch (error) {
        logger.fatal({
            err: error,
            message: error.message,
            code: error.code,
            stack: error.stack,
            projectId: process.env.GOOGLE_CLOUD_PROJECT || 'unknown'
        }, "[ChannelManager] CRITICAL: Failed to initialize Google Cloud Firestore for channel management.");

        // Log credential path if set
        const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
        if (credPath) {
            logger.fatal(`[ChannelManager] GOOGLE_APPLICATION_CREDENTIALS is set to: ${credPath}`);
        } else {
            logger.fatal("[ChannelManager] GOOGLE_APPLICATION_CREDENTIALS environment variable is not set.");
        }

        // Application cannot proceed without storage
        throw error;
    }
}

/**
 * Gets the Firestore database instance.
 * @returns {Firestore} Firestore DB instance.
 * @throws {Error} If storage is not initialized.
 */
function _getDb() {
    if (!db) {
        throw new Error("[ChannelManager] Storage not initialized. Call initializeChannelManager first.");
    }
    return db;
}

/**
 * Retrieves all active managed channels from Firestore.
 * @returns {Promise<string[]>} Array of channel names.
 */
export async function getActiveManagedChannels() {
    const db = _getDb();
    logger.info("[ChannelManager] Fetching active managed channels from Firestore...");

    try {
        const snapshot = await db.collection(MANAGED_CHANNELS_COLLECTION)
            .where('isActive', '==', true)
            .get();

        const channels = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            if (data && typeof data.channelName === 'string') {
                channels.push({
                    name: data.channelName.toLowerCase(),
                    twitchUserId: data.twitchUserId || null
                });
            } else {
                logger.warn({ docId: doc.id }, `[ChannelManager] Document in managedChannels missing valid 'channelName'. Skipping.`);
            }
        });

        // Populate the allow-list cache from Firestore (the single source of truth)
        updateAllowedChannels(channels);

        const channelNames = channels.map(ch => ch.name);
        logger.info(`[ChannelManager] Successfully fetched ${channelNames.length} active managed channels.`);
        logger.debug(`[ChannelManager] Active channels: ${channelNames.join(', ')}`);

        return channelNames;
    } catch (error) {
        logger.error({ err: error }, "[ChannelManager] Error fetching active managed channels.");
        throw new ChannelManagerError("Failed to fetch active managed channels.", error);
    }
}

/**
 * Synchronizes the EventSub subscriptions with the active managed channels.
 * @returns {Promise<void>}
 */
export async function syncManagedChannelsWithEventSub() {
    try {
        // Import subscription manager
        const { subscribeAllManagedChannelsToTtsEvents } = await import('./twitchSubs.js');

        logger.info("[ChannelManager] Syncing managed channels with EventSub...");
        const results = await subscribeAllManagedChannelsToTtsEvents();

        logger.info({
            successful: results.successful.length,
            failed: results.failed.length,
            total: results.total
        }, `[ChannelManager] EventSub sync complete.`);

        if (results.failed.length > 0) {
            logger.warn({ failures: results.failed }, "[ChannelManager] Some EventSub subscriptions failed.");
        }
    } catch (error) {
        logger.error({ err: error }, "[ChannelManager] Error syncing managed channels with EventSub.");
        throw new ChannelManagerError("Failed to sync managed channels with EventSub.", error);
    }
}

/**
 * Sets up a listener for changes to the managedChannels collection.
 * @returns {Function} Unsubscribe function to stop listening for changes
 */
export function listenForChannelChanges() {
    const db = _getDb();
    let isInitialSnapshot = true;

    logger.info("[ChannelManager] Setting up listener for channel management changes...");

    const unsubscribe = db.collection(MANAGED_CHANNELS_COLLECTION)
        .onSnapshot(async snapshot => {
            const changes = [];

            snapshot.docChanges().forEach(change => {
                const channelData = change.doc.data();
                if (channelData && typeof channelData.channelName === 'string') {
                    changes.push({
                        type: change.type,
                        channelName: channelData.channelName,
                        isActive: !!channelData.isActive,
                        twitchUserId: channelData.twitchUserId,
                        docId: change.doc.id
                    });
                }
            });

            // Skip EventSub sync on initial snapshot — syncManagedChannelsWithEventSub()
            // already handled these during startup. Allow-list updates happen below.
            if (isInitialSnapshot) {
                isInitialSnapshot = false;
                // On initial snapshot, only ADD active channels to the allow-list.
                // The allow-list starts empty so removals are unnecessary and can be
                // destructive when duplicate docs exist for the same channel (a legacy
                // name-keyed doc with isActive=false would clobber the active one).
                for (const change of changes) {
                    if (change.isActive && change.twitchUserId) {
                        addAllowedChannel(change.channelName, change.twitchUserId);
                    }
                }
                logger.info(`[ChannelManager] Initial snapshot: ${changes.length} channels loaded (skipping EventSub sync)`);
                return;
            }

            if (changes.length > 0) {
                logger.info(`[ChannelManager] Detected ${changes.length} channel management changes.`);

                const { subscribeChannelToTtsEvents } = await import('./twitchSubs.js');
                const { getUsersByLogin } = await import('./helixClient.js');

                for (const change of changes) {
                    // Update allow-list cache in real-time
                    if (change.isActive && change.twitchUserId) {
                        addAllowedChannel(change.channelName, change.twitchUserId);
                    } else if (!change.isActive) {
                        removeAllowedChannel(change.channelName, change.twitchUserId);
                    }

                    if ((change.type === 'added' || change.type === 'modified') && change.isActive) {
                        // Subscribe to events
                        try {
                            let userId = change.twitchUserId;
                            if (!userId) {
                                const users = await getUsersByLogin([change.channelName]);
                                if (users && users.length > 0) {
                                    userId = users[0].id;
                                }
                            }

                            if (userId) {
                                logger.info({ channel: change.channelName }, "[ChannelManager] Subscribing channel to EventSub events");
                                await subscribeChannelToTtsEvents(userId);
                            } else {
                                logger.warn({ channel: change.channelName }, "[ChannelManager] Could not find user ID for channel - skipping subscription");
                            }
                        } catch (error) {
                            logger.error({ err: error, channel: change.channelName }, "[ChannelManager] Failed to subscribe channel to EventSub");
                        }
                    }
                    // Clean up EventSub subscriptions when channel becomes inactive
                    else if ((change.type === 'modified' || change.type === 'removed') && !change.isActive) {
                        try {
                            const userId = change.twitchUserId;
                            if (userId) {
                                logger.info({ channel: change.channelName }, "[ChannelManager] Unsubscribing channel from EventSub events");
                                const { deleteChannelEventSubSubscriptions } = await import('./twitchSubs.js');
                                const result = await deleteChannelEventSubSubscriptions(userId);
                                logger.info({ channel: change.channelName, deleted: result.deleted, errors: result.errors }, "[ChannelManager] Completed EventSub cleanup for deactivated channel");
                            }
                        } catch (error) {
                            logger.error({ err: error, channel: change.channelName }, "[ChannelManager] Failed to unsubscribe channel from EventSub");
                        }
                    }
                }
            }
        }, error => {
            logger.error({ err: error }, "[ChannelManager] Error in channel changes listener.");
        });

    logger.info("[ChannelManager] Channel management listener set up successfully.");

    return unsubscribe;
}

/**
 * Gets a list of all channels (both active and inactive) from the managedChannels collection.
 * @returns {Promise<Array<{channelName: string, isActive: boolean, displayName: string}>>}
 */
export async function getAllManagedChannels() {
    const db = _getDb();

    try {
        const snapshot = await db.collection(MANAGED_CHANNELS_COLLECTION).get();

        const channels = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            channels.push({
                channelName: data.channelName.toLowerCase(),
                isActive: !!data.isActive,
                displayName: data.displayName || data.channelName,
                addedAt: data.addedAt ? data.addedAt.toDate() : null,
                lastStatusChange: data.lastStatusChange ? data.lastStatusChange.toDate() : null
            });
        });

        logger.debug(`[ChannelManager] Retrieved ${channels.length} managed channels.`);
        return channels;
    } catch (error) {
        logger.error({ err: error }, "[ChannelManager] Error fetching all managed channels.");
        throw new ChannelManagerError("Failed to fetch all managed channels.", error);
    }
}

// OBS token change listener removed: web UI writes obsSocketSecretName directly to ttsChannelConfigs.
