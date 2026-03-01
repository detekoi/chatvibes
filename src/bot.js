// src/bot.js
import config from './config/index.js';
import { initializeAllowList } from './lib/allowList.js';
import logger from './lib/logger.js';

// Core Twitch & Cloud
import { initializeSecretManager } from './lib/secretManager.js';
import { initializeHelixClient } from './components/twitch/helixClient.js';

// WildcatTTS TTS Components
import { initializeTtsState } from './components/tts/ttsState.js';
import { initGeminiClient } from './lib/geminiEmoteDescriber.js';
import * as ttsQueue from './components/tts/ttsQueue.js';
import { initializeWebServer } from './components/web/server.js';
import { Firestore, Timestamp } from '@google-cloud/firestore';
import crypto from 'crypto';


// Command Processing
import { initializeCommandProcessor } from './components/commands/commandProcessor.js';
import { initializeChatSender } from './lib/chatSender.js';
import { createLeaderElection } from './lib/leaderElection.js';

// Channel Management
import { initializeChannelManager, getActiveManagedChannels, syncManagedChannelsWithEventSub, listenForChannelChanges } from './components/twitch/channelManager.js';

// Pub/Sub for cross-instance TTS communication
import { initializePubSub, subscribeTtsEvents, closePubSub } from './lib/pubsub.js';

// Shared chat session tracking



let channelChangeListener = null;
let isShuttingDown = false;
let leaderElection = null;
let eventSubStartedByThisInstance = false;

// Pub/Sub event de-duplication (guards against overlapping revisions delivering same TTS event)
const PUBSUB_DEDUP_TTL_MS = 30 * 1000; // 30 seconds
const recentPubSubKeys = new Map(); // key: channel|user|text -> timestamp

function isDuplicatePubSubEvent(channelName, eventData) {
    try {
        const user = (eventData?.user || '').toLowerCase();
        const text = (eventData?.text || '').trim();
        const messageId = eventData?.messageId || '';

        // Use messageId if available (from EventSub), otherwise fall back to text-based dedup
        const usingMessageId = !!messageId;
        const key = messageId
            ? `${channelName}|${messageId}`
            : `${channelName}|${user}|${text}`;

        const now = Date.now();
        const lastTs = recentPubSubKeys.get(key);

        // Cleanup occasionally to bound memory
        if (recentPubSubKeys.size > 1000) {
            for (const [k, ts] of recentPubSubKeys) {
                if (now - ts > PUBSUB_DEDUP_TTL_MS) recentPubSubKeys.delete(k);
            }
        }

        if (lastTs && now - lastTs < PUBSUB_DEDUP_TTL_MS) {
            const dedupMethod = usingMessageId ? 'messageId' : 'text-based';
            const keyDisplay = key.substring(0, 80);
            logger.info({
                channel: channelName,
                user,
                textPreview: text?.substring(0, 30),
                messageId: messageId || 'N/A',
                dedupMethod,
                keyPreview: keyDisplay,
                ageMs: now - lastTs
            }, `TTS message blocked: Duplicate in local cache (${dedupMethod}) - msgId: ${messageId || 'NONE'} - key: ${keyDisplay}`);
            return true;
        }

        recentPubSubKeys.set(key, now);
        return false;
    } catch (_) {
        return false;
    }
}

// Cross-instance dedup using Firestore (authoritative claim) to avoid multi-revision double-enqueue
const firestore = new Firestore();
const processedEventsCollection = firestore.collection('processedTtsEvents');

async function claimTtsEventGlobal(channelName, eventData, ttlMs = PUBSUB_DEDUP_TTL_MS) {
    const user = (eventData?.user || '').toLowerCase();
    const text = (eventData?.text || '').trim();
    const messageId = eventData?.messageId || '';
    // If messageId is available, we only need channelName for deduplication key.
    // If messageId is missing, we need both channelName and text for the fallback key.
    if (!channelName || (!messageId && !text)) return true; // if missing data, do not block

    // Use messageId if available (from EventSub), otherwise fall back to text-based dedup
    const usingMessageId = !!messageId;
    const keyRaw = messageId
        ? `${channelName}|${messageId}`
        : `${channelName}|${user}|${text}`;
    const keyHash = crypto.createHash('sha1').update(keyRaw).digest('hex');
    const docRef = processedEventsCollection.doc(keyHash);
    const now = Date.now();
    const expireAt = Timestamp.fromMillis(now + ttlMs);

    try {
        const result = await firestore.runTransaction(async (tx) => {
            const snap = await tx.get(docRef);
            if (snap.exists) {
                const data = snap.data() || {};
                // Check both old (expireAtMs) and new (expireAt) formats for backward compatibility
                let expired = true;
                if (data.expireAt instanceof Timestamp) {
                    expired = data.expireAt.toMillis() <= now;
                } else if (typeof data.expireAtMs === 'number') {
                    expired = data.expireAtMs <= now;
                }

                if (!expired) {
                    const dedupMethod = usingMessageId ? 'messageId' : 'text-based';
                    const keyDisplay = keyRaw.substring(0, 80);
                    logger.info({
                        channel: channelName,
                        user,
                        textPreview: text?.substring(0, 30),
                        messageId: messageId || 'N/A',
                        dedupMethod,
                        keyRawPreview: keyDisplay,
                        ageMs: now - (data.createdAtMs || 0)
                    }, `TTS message blocked: Duplicate in Firestore (${dedupMethod}) - msgId: ${messageId || 'NONE'} - key: ${keyDisplay}`);
                    return false; // already claimed recently
                }
            }
            tx.set(docRef, {
                channel: channelName,
                user,
                messageId: messageId || null,
                createdAtMs: now,
                expireAt: expireAt, // Firestore Timestamp for TTL policy
            }, { merge: true });
            return true;
        });
        return result;
    } catch (err) {
        // On Firestore error, fail-open to avoid message loss
        logger.warn({ err }, 'Pub/Sub global dedupe claim failed; proceeding without dedupe');
        return true;
    }
}

// Export shutdown state checker for use by other modules
export function getIsShuttingDown() {
    return isShuttingDown;
}



/**
 * Helper function to get shared session info for a channel
 * @param {string} channelNameNoHash - Channel name without #
 * @returns {Promise<object|null>} Shared session info or null
 */


async function gracefulShutdown(signal) {
    if (isShuttingDown) {
        logger.warn(`WildcatTTS: Shutdown already in progress. Signal ${signal} received again. Please wait or force quit if necessary.`);
        return;
    }
    isShuttingDown = true;
    logger.info(`WildcatTTS: Received ${signal}. Starting graceful shutdown...`);
    const shutdownTasks = [];

    // Stop the web server
    if (global.healthServer) {
        logger.info('WildcatTTS: Closing web server...');
        shutdownTasks.push(
            new Promise((resolve, reject) => {
                global.healthServer.close((err) => {
                    if (err) {
                        logger.error({ err }, 'WildcatTTS: Error closing web server.');
                        reject(err);
                    } else {
                        logger.info('WildcatTTS: Web server closed.');
                        resolve();
                    }
                });
                setTimeout(() => {
                    logger.warn('WildcatTTS: Web server close timed out. Forcing resolution.');
                    resolve();
                }, 3000).unref();
            })
        );
    } else {
        logger.warn('WildcatTTS: Web server (global.healthServer) not found during shutdown.');
    }

    if (channelChangeListener && typeof channelChangeListener === 'function') {
        try {
            logger.info('WildcatTTS: Cleaning up Firestore channel change listener...');
            channelChangeListener();
            channelChangeListener = null;
            logger.info('WildcatTTS: Firestore channel change listener cleaned up.');
        } catch (error) {
            logger.error({ err: error }, 'WildcatTTS: Error cleaning up Firestore channel change listener.');
        }
    } else {
        logger.info('WildcatTTS: No active Firestore channel change listener to clean up.');
    }

    // Persist TTS queues before shutdown to prevent message loss
    logger.info('WildcatTTS: Persisting TTS queues to Firestore...');
    shutdownTasks.push(
        ttsQueue.persistAllQueues()
            .then(() => { logger.info('WildcatTTS: TTS queues persisted successfully.'); })
            .catch(err => { logger.error({ err }, 'WildcatTTS: Error persisting TTS queues.'); })
    );

    // Close Pub/Sub subscription and client
    logger.info('WildcatTTS: Closing Pub/Sub resources...');
    shutdownTasks.push(
        closePubSub()
            .then(() => { logger.info('WildcatTTS: Pub/Sub resources closed.'); })
            .catch(err => { logger.error({ err }, 'WildcatTTS: Error closing Pub/Sub.'); })
    );

    logger.info(`WildcatTTS: Waiting for ${shutdownTasks.length} shutdown tasks to complete...`);
    await Promise.allSettled(shutdownTasks);

    logger.info('WildcatTTS: Graceful shutdown sequence complete. Exiting process.');
    process.exit(0);
}

async function main() {
    try {
        const packageName = 'wildcat-tts';
        const packageVersion = '1.0.0';
        logger.info(`Starting ${packageName} v${packageVersion}...`);
        logger.info(`Node Env: ${config.app.nodeEnv}, Log Level: ${config.app.logLevel}`);
        logger.info(`Project ID: ${process.env.GOOGLE_CLOUD_PROJECT || 'WildcatTTS (Hardcoded fallback - Set GOOGLE_CLOUD_PROJECT)'}`);

        // Initialize core components
        logger.info('WildcatTTS: Initializing Secret Manager...');
        initializeSecretManager();

        // Initialize allow-list from secret if configured (before loading channels)
        await initializeAllowList();

        logger.info('WildcatTTS: Initializing TTS State (Firestore)...');
        await initializeTtsState();

        // Initialize Gemini for AI-powered emote descriptions
        logger.info('WildcatTTS: Initializing Gemini client for emote descriptions...');
        initGeminiClient(process.env.GEMINI_API_KEY);

        logger.info('WildcatTTS: Restoring TTS queues from previous session...');
        await ttsQueue.restoreAllQueues();

        logger.info('WildcatTTS: Initializing Channel Manager (Firestore)...');
        await initializeChannelManager();

        // --- Load Twitch Channels ---
        // Use env-based channels locally (development) and Firestore when deployed on Cloud Run.
        const isCloudRun = !!(process.env.K_SERVICE || process.env.K_REVISION || process.env.K_CONFIGURATION);
        if (!isCloudRun && config.app.nodeEnv === 'development') {
            logger.info('WildcatTTS: Local development detected. Using TWITCH_CHANNELS from .env');
            const envChannels = (process.env.TWITCH_CHANNELS || '')
                .split(',')
                .map(ch => ch.trim().toLowerCase())
                .filter(Boolean);

            if (envChannels.length === 0) {
                logger.fatal('WildcatTTS: TWITCH_CHANNELS is empty or not set in .env for development. Please set it.');
                process.exit(1);
            }
            config.twitch.channels = [...new Set(envChannels)];
            logger.info(`WildcatTTS: Loaded ${config.twitch.channels.length} channels from .env: [${config.twitch.channels.join(', ')}]`);
        } else {
            logger.info('WildcatTTS: Cloud environment detected or not development. Loading channels from Firestore.');
            try {
                const managedChannels = await getActiveManagedChannels();
                if (managedChannels && managedChannels.length > 0) {
                    config.twitch.channels = [...new Set(managedChannels)];
                    logger.info(`WildcatTTS: Loaded ${config.twitch.channels.length} channels from Firestore.`);
                } else {
                    logger.warn('WildcatTTS: No active channels found in Firestore managedChannels collection. Bot will wait for dynamic joins.');
                    config.twitch.channels = [];
                }
            } catch (error) {
                logger.error({ err: error }, 'WildcatTTS: Error loading channels from Firestore.');
                config.twitch.channels = [];
            }
        }
        if (!config.twitch.channels) config.twitch.channels = [];

        logger.info('WildcatTTS: Initializing Twitch Helix Client...');
        await initializeHelixClient();

        // Load bot's access token into config for EventSub subscriptions
        logger.info('WildcatTTS: Loading bot access token...');
        const { loadBotAccessToken } = await import('./components/twitch/ircAuthHelper.js');
        const tokenLoaded = await loadBotAccessToken();
        if (!tokenLoaded) {
            logger.warn('WildcatTTS: Bot access token not loaded. EventSub chat message subscriptions may fail.');
        }

        // Note: We rely on reactive 401 error handling in chatClient.js for token refresh
        // This allows the bot to shut down when idle to save costs, and tokens are
        // refreshed on-demand when they expire (following Twitch's recommended approach)

        logger.info('WildcatTTS: Initializing Command Processor for commands...');
        initializeCommandProcessor();

        logger.info('WildcatTTS: Initializing Chat Sender queue...');
        initializeChatSender();

        // Start the Web Server early
        logger.info('WildcatTTS: Initializing Web Server for OBS audio...');
        const { server: webServerInstance, hasActiveClients } = initializeWebServer();
        global.healthServer = webServerInstance;

        // Initialize Pub/Sub for cross-instance TTS communication
        logger.info('WildcatTTS: Initializing Pub/Sub for TTS message distribution...');
        await initializePubSub();

        // Subscribe to TTS events from Pub/Sub
        // All instances subscribe, but only process if they have active WebSocket clients
        logger.info('WildcatTTS: Setting up Pub/Sub subscriber for TTS events...');
        await subscribeTtsEvents(async (channelName, eventData, sharedSessionInfo) => {
            // This handler is called on ALL instances when a TTS event is published

            // optimization: Check if this instance has active clients for this channel BEFORE dedup/claiming
            // This prevents "idle" instances from claiming the event and then failing to play it
            if (!hasActiveClients(channelName)) {
                // If this is a shared session, check if ANY of the shared channels have clients on this instance
                let hasSharedClients = false;
                if (sharedSessionInfo && sharedSessionInfo.channels) {
                    hasSharedClients = sharedSessionInfo.channels.some(ch => hasActiveClients(ch));
                }

                if (!hasSharedClients) {
                    // Log at debug level to avoid noise in multi-instance setups
                    // logger.debug({ channel: channelName }, 'Skipping TTS event - no active WebSocket clients on this instance');
                    return;
                }
            }

            // The ttsQueue.enqueue will check if there are active WebSocket clients
            const logData = {
                channel: channelName,
                user: eventData.user,
                textPreview: eventData.text?.substring(0, 30)
            };

            if (sharedSessionInfo) {
                logData.sessionId = sharedSessionInfo.sessionId;
                logData.sharedChannels = sharedSessionInfo.channels;
                logger.debug(logData, `[SharedChat:${sharedSessionInfo.sessionId}] Received TTS event from Pub/Sub for shared session, processing locally`);
            } else {
                logger.debug(logData, 'Received TTS event from Pub/Sub, processing locally');
            }

            // Pub/Sub dedupe: local memory check
            if (isDuplicatePubSubEvent(channelName, eventData)) {
                logger.info({ channel: channelName, user: eventData.user, textPreview: eventData.text?.substring(0, 30) }, 'Skipping duplicate TTS enqueue (blocked by local cache)');
                return;
            }
            // Pub/Sub dedupe: cross-instance Firestore claim (authoritative)
            const claimed = await claimTtsEventGlobal(channelName, eventData);
            if (!claimed) {
                logger.info({ channel: channelName, user: eventData.user, textPreview: eventData.text?.substring(0, 30) }, 'Skipping duplicate TTS enqueue (blocked by global Firestore claim)');
                return;
            }
            await ttsQueue.enqueue(channelName, eventData, sharedSessionInfo);
        });
        logger.info('WildcatTTS: Pub/Sub subscriber ready');

        // Functions to start/stop EventSub subsystem under leader election
        const startEventSubSubsystem = async () => {
            if (eventSubStartedByThisInstance) {
                logger.info('WildcatTTS: EventSub subsystem already started by this instance.');
                return;
            }

            logger.info('WildcatTTS: Starting EventSub subsystem (Subscription Management)...');

            // Sync channels on connect
            if (config.app.nodeEnv !== 'development') {
                await syncManagedChannelsWithEventSub();

                if (!channelChangeListener) {
                    logger.info('WildcatTTS: Setting up Firestore channel change listener.');
                    channelChangeListener = listenForChannelChanges();
                }
            } else {
                logger.info('WildcatTTS (DEV MODE): Skipping EventSub sync (assuming manual setup or ngrok).');
            }

            eventSubStartedByThisInstance = true;
        };

        const stopEventSubSubsystem = async () => {
            if (!eventSubStartedByThisInstance) return;
            try {
                logger.info('WildcatTTS: Stopping EventSub subsystem');

                // Clean up channel listener first
                if (channelChangeListener) {
                    try { channelChangeListener(); } catch { /* ignore */ }
                    channelChangeListener = null;
                }

                logger.info('WildcatTTS: EventSub subsystem stopped successfully');
            } catch (e) {
                logger.warn({ err: e }, 'WildcatTTS: Error while stopping EventSub subsystem');
            }
            eventSubStartedByThisInstance = false;
        };

        // Start leader election to ensure only one active EventSub manager
        if (config.app.nodeEnv === 'development') {
            logger.info('WildcatTTS (DEV MODE): Skipping leader election, starting EventSub subsystem directly...');
            await startEventSubSubsystem();
        } else {
            leaderElection = createLeaderElection();
            await leaderElection.start({
                onStartedLeading: startEventSubSubsystem,
                onStoppedLeading: stopEventSubSubsystem,
            });
        }

        logger.info('WildcatTTS: Bot username loaded successfully.');

    } catch (error) {
        logger.fatal({ err: error, stack: error.stack }, 'WildcatTTS: Fatal error during initialization.');
        process.exit(1);
    }
}

// Graceful shutdown hooks
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (error) => {
    logger.fatal({ err: error, stack: error.stack }, 'WildcatTTS: Uncaught Exception!');
    gracefulShutdown('UNCAUGHT_EXCEPTION').catch(err => {
        logger.error({ err: err.stack }, 'WildcatTTS: Error during graceful shutdown from uncaught exception.');
        process.exit(1);
    });
    setTimeout(() => process.exit(1), 10000).unref();
});
process.on('unhandledRejection', (reason, promise) => {
    const errorReason = reason instanceof Error ? { message: reason.message, stack: reason.stack } : reason;
    logger.error({ reason: errorReason, promise }, 'WildcatTTS: Unhandled Rejection at Promise');
});

main();