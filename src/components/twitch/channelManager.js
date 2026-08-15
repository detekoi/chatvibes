// src/components/twitch/channelManager.js
import { Firestore } from '@google-cloud/firestore';
import logger from '../../lib/logger.js';

import { updateAllowedChannels, addAllowedChannel, setChannelActive, removeAllowedChannel } from '../../lib/allowList.js';

// --- Firestore Client Initialization ---
let db = null; // Firestore database instance

// Collection name (must match the name used in chatsage-web-ui)
const MANAGED_CHANNELS_COLLECTION = 'managedChannels';

// Login names that were active as of the most recent full Firestore fetch, i.e.
// the set EventSub was subscribed for at startup. Null until the first fetch.
let lastFetchedActiveNames = null;

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
 * Retrieves all active managed channels from Firestore, and refreshes the
 * allow-list cache from the whole collection along the way.
 *
 * The read is deliberately unfiltered: approval to use the service is the
 * document existing, not isActive, so a channel that has switched the bot off
 * still belongs on the allow-list. Only the returned list — the channels the
 * bot actually runs in — is narrowed to the active ones.
 *
 * @returns {Promise<string[]>} Array of active channel names.
 */
export async function getActiveManagedChannels() {
    const db = _getDb();
    logger.info("[ChannelManager] Fetching managed channels from Firestore...");

    try {
        const snapshot = await db.collection(MANAGED_CHANNELS_COLLECTION).get();

        const channels = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            if (data && typeof data.channelName === 'string') {
                channels.push({
                    name: data.channelName.toLowerCase(),
                    twitchUserId: data.twitchUserId || null,
                    isActive: !!data.isActive
                });
            } else {
                logger.warn({ docId: doc.id }, `[ChannelManager] Document in managedChannels missing valid 'channelName'. Skipping.`);
            }
        });

        // Populate the allow-list cache from Firestore (the single source of truth)
        updateAllowedChannels(channels);

        const channelNames = channels.filter(ch => ch.isActive).map(ch => ch.name);

        // Baseline for the listener's initial snapshot: these are the channels
        // startup subscribes to, so anything that differs by the time the
        // listener attaches was changed in between and still needs syncing.
        lastFetchedActiveNames = new Set(channelNames);

        logger.info(`[ChannelManager] Successfully fetched ${channelNames.length} active managed channels (${channels.length} approved).`);
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
 * Picks out the initial-snapshot documents whose active state no longer matches
 * what the startup sync subscribed, so only those are synced with EventSub.
 * Returns nothing when no fetch has run — there is no baseline to compare with,
 * and re-syncing every channel would mean a Helix call per channel on boot.
 */
function changesMissedDuringStartup(changes) {
    if (!lastFetchedActiveNames) return [];
    return changes
        .filter(change => lastFetchedActiveNames.has(change.channelName.toLowerCase()) !== change.isActive)
        // Every initial-snapshot entry arrives as 'added', but these documents are
        // ones that changed after startup read them. Reporting them as such is what
        // lets a channel deactivated during the window be unsubscribed rather than
        // mistaken for a brand-new document that never had subscriptions.
        .map(change => ({ ...change, type: 'modified' }));
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

            // Update the caches in real-time. Deactivating switches the bot off but
            // leaves the channel approved; only a deleted document revokes approval.
            let changesToSync = changes;
            if (isInitialSnapshot) {
                isInitialSnapshot = false;
                // On initial snapshot, only ever ADD. Every document is approved
                // regardless of isActive, but nothing is switched off here: removals
                // are unnecessary against a freshly loaded cache and can be destructive
                // when duplicate docs exist for the same channel (a legacy name-keyed
                // doc with isActive=false would clobber the active one).
                for (const change of changes) {
                    if (change.isActive) {
                        setChannelActive(change.channelName, change.twitchUserId, true);
                    } else {
                        addAllowedChannel(change.channelName, change.twitchUserId);
                    }
                }

                // syncManagedChannelsWithEventSub() already subscribed these during
                // startup, so nothing is normally synced here. The exception is a
                // channel switched on or off between that sync and this listener
                // attaching: no other event covers that window, and the channel would
                // stay wrongly subscribed — or wrongly silent — until the next restart.
                changesToSync = changesMissedDuringStartup(changes);
                logger.info(
                    `[ChannelManager] Initial snapshot: ${changes.length} channels loaded, ` +
                    `${changesToSync.length} changed since the startup sync`
                );
            } else {
                for (const change of changes) {
                    if (change.type === 'removed') {
                        removeAllowedChannel(change.channelName, change.twitchUserId);
                    } else {
                        setChannelActive(change.channelName, change.twitchUserId, change.isActive);
                    }
                }
            }

            if (changesToSync.length > 0) {
                logger.info(`[ChannelManager] Detected ${changesToSync.length} channel management changes.`);

                const { subscribeChannelToTtsEvents } = await import('./twitchSubs.js');
                const { getUsersByLogin } = await import('./helixClient.js');

                for (const change of changesToSync) {
                    // A deleted document is a deactivation as far as Twitch is concerned,
                    // whatever isActive still said on it: leaving the subscriptions in
                    // place means webhooks the bot can only discard.
                    const shouldBeSubscribed = change.type !== 'removed' && change.isActive;

                    if (shouldBeSubscribed) {
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
                    else if (change.type !== 'added') {
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
