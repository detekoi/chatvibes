// src/bot.js
import config from './config/index.js';
import { getAllowedChannels, isChannelAllowed, initializeAllowList } from './lib/allowList.js';
import logger from './lib/logger.js';

// Core Twitch & Cloud
import { initializeSecretManager } from './lib/secretManager.js';
import { createIrcClient, connectIrcClient, getIrcClient } from './components/twitch/ircClient.js';
import { initializeHelixClient } from './components/twitch/helixClient.js';

// ChatVibes TTS Components
import { initializeTtsState, getTtsState } from './components/tts/ttsState.js';
import * as ttsQueue from './components/tts/ttsQueue.js';
import { initializeWebServer } from './components/web/server.js';

// Music Components
import { initializeMusicQueues } from './components/music/musicQueue.js';
import { initializeMusicState, getMusicState } from './components/music/musicState.js';

// Command Processing
import { initializeCommandProcessor, processMessage as processCommand, hasPermission } from './components/commands/commandProcessor.js';
import { initializeIrcSender, clearMessageQueue } from './lib/ircSender.js';
import { createLeaderElection } from './lib/leaderElection.js';

// URL Processing
import { processMessageUrls } from './lib/urlProcessor.js';

// Channel Management
import { initializeChannelManager, getActiveManagedChannels, syncManagedChannelsWithIrc, listenForChannelChanges } from './components/twitch/channelManager.js';

// Pub/Sub for cross-instance TTS communication
import { initializePubSub, publishTtsEvent, subscribeTtsEvents, closePubSub } from './lib/pubsub.js';

// Shared chat session tracking
import * as sharedChatManager from './components/twitch/sharedChatManager.js';
import { getUsersByLogin } from './components/twitch/helixClient.js';

let ircClientInstance = null;
let channelChangeListener = null;
let obsTokenChangeListener = null;
let isShuttingDown = false;
let leaderElection = null;
let ircStartedByThisInstance = false;

// Export shutdown state checker for use by other modules
export function getIsShuttingDown() {
    return isShuttingDown;
}

// Cache for broadcaster IDs to avoid repeated API calls
const broadcasterIdCache = new Map();

/**
 * Helper function to get shared session info for a channel
 * @param {string} channelNameNoHash - Channel name without #
 * @returns {Promise<object|null>} Shared session info or null
 */
async function getSharedSessionInfo(channelNameNoHash) {
    try {
        // Get broadcaster ID (cached)
        let broadcasterId = broadcasterIdCache.get(channelNameNoHash);
        if (!broadcasterId) {
            const users = await getUsersByLogin([channelNameNoHash]);
            if (users && users.length > 0) {
                broadcasterId = users[0].id;
                broadcasterIdCache.set(channelNameNoHash, broadcasterId);
            }
        }

        if (!broadcasterId) {
            return null;
        }

        // Check if in shared session
        const sessionId = sharedChatManager.getSessionForChannel(broadcasterId);
        if (!sessionId) {
            return null;
        }

        // Get session details
        const session = sharedChatManager.getSession(sessionId);
        if (!session) {
            return null;
        }

        const channelLogins = session.participants.map(p => p.broadcaster_user_login);
        
        return {
            sessionId,
            channels: channelLogins,
            participantCount: channelLogins.length
        };
    } catch (error) {
        logger.warn({ err: error, channel: channelNameNoHash }, 'ChatVibes: Error getting shared session info');
        return null;
    }
}

async function gracefulShutdown(signal) {
    if (isShuttingDown) {
        logger.warn(`ChatVibes: Shutdown already in progress. Signal ${signal} received again. Please wait or force quit if necessary.`);
        return;
    }
    isShuttingDown = true;
    logger.info(`ChatVibes: Received ${signal}. Starting graceful shutdown...`);
    const shutdownTasks = [];

    // Stop the web server
    if (global.healthServer) {
        logger.info('ChatVibes: Closing web server...');
        shutdownTasks.push(
            new Promise((resolve, reject) => {
                global.healthServer.close((err) => {
                    if (err) {
                        logger.error({ err }, 'ChatVibes: Error closing web server.');
                        reject(err);
                    } else {
                        logger.info('ChatVibes: Web server closed.');
                        resolve();
                    }
                });
                setTimeout(() => {
                    logger.warn('ChatVibes: Web server close timed out. Forcing resolution.');
                    resolve();
                }, 3000).unref();
            })
        );
    } else {
        logger.warn('ChatVibes: Web server (global.healthServer) not found during shutdown.');
    }

    if (channelChangeListener && typeof channelChangeListener === 'function') {
        try {
            logger.info('ChatVibes: Cleaning up Firestore channel change listener...');
            channelChangeListener();
            channelChangeListener = null;
            logger.info('ChatVibes: Firestore channel change listener cleaned up.');
        } catch (error) {
            logger.error({ err: error }, 'ChatVibes: Error cleaning up Firestore channel change listener.');
        }
    } else {
        logger.info('ChatVibes: No active Firestore channel change listener to clean up.');
    }

    // OBS token change listener no longer used; tokens are written directly to ttsChannelConfigs by the web UI.

    clearMessageQueue();
    logger.info('ChatVibes: IRC message sender queue cleared.');

    // Persist TTS queues before shutdown to prevent message loss
    logger.info('ChatVibes: Persisting TTS queues to Firestore...');
    shutdownTasks.push(
        ttsQueue.persistAllQueues()
            .then(() => { logger.info('ChatVibes: TTS queues persisted successfully.'); })
            .catch(err => { logger.error({ err }, 'ChatVibes: Error persisting TTS queues.'); })
    );

    // Close Pub/Sub subscription and client
    logger.info('ChatVibes: Closing Pub/Sub resources...');
    shutdownTasks.push(
        closePubSub()
            .then(() => { logger.info('ChatVibes: Pub/Sub resources closed.'); })
            .catch(err => { logger.error({ err }, 'ChatVibes: Error closing Pub/Sub.'); })
    );

    let localIrcClient = null;
    try {
        localIrcClient = ircClientInstance || getIrcClient();
    } catch (e) {
        logger.warn('ChatVibes: IRC client not available during shutdown, skipping disconnect step.');
    }

    if (localIrcClient && typeof localIrcClient.readyState === 'function' && localIrcClient.readyState() === 'OPEN') {
        logger.info('ChatVibes: Disconnecting from Twitch IRC...');
        shutdownTasks.push(
            localIrcClient.disconnect()
                .then(() => { logger.info('ChatVibes: Disconnected from Twitch IRC.'); })
                .catch(err => { logger.error({ err }, 'ChatVibes: Error during IRC disconnect.'); })
        );
    } else if (localIrcClient) {
        logger.info('ChatVibes: IRC client was not in OPEN state, no explicit disconnect sent.');
    }

    logger.info(`ChatVibes: Waiting for ${shutdownTasks.length} shutdown tasks to complete...`);
    await Promise.allSettled(shutdownTasks);

    logger.info('ChatVibes: Graceful shutdown sequence complete. Exiting process.');
    process.exit(0);
}

async function main() {
    try {
        const packageName = 'chatvibes-tts';
        const packageVersion = '1.0.0';
        logger.info(`Starting ${packageName} v${packageVersion}...`);
        logger.info(`Node Env: ${config.app.nodeEnv}, Log Level: ${config.app.logLevel}`);
        logger.info(`Project ID: ${process.env.GOOGLE_CLOUD_PROJECT || 'ChatVibesTTS (Hardcoded fallback - Set GOOGLE_CLOUD_PROJECT)'}`);

        // Initialize core components
        logger.info('ChatVibes: Initializing Secret Manager...');
        initializeSecretManager();

        // Initialize allow-list from secret if configured (before loading channels)
        await initializeAllowList();
        
        // Note: Periodic refresh disabled to allow scale-to-zero
        // The allowlist will refresh on each bot restart (which happens when needed)

        logger.info('ChatVibes: Initializing TTS State (Firestore)...');
        await initializeTtsState();

        logger.info('ChatVibes: Restoring TTS queues from previous session...');
        await ttsQueue.restoreAllQueues();

        logger.info('ChatVibes: Initializing Music State (Firestore)...');
        await initializeMusicState();

        logger.info('ChatVibes: Initializing Channel Manager (Firestore)...');
        await initializeChannelManager();
        
        logger.info('ChatVibes: Initializing Music Generation system (queues)...');
        initializeMusicQueues();

        // --- Load Twitch Channels ---
        // Use env-based channels locally (development) and Firestore when deployed on Cloud Run.
        const isCloudRun = !!(process.env.K_SERVICE || process.env.K_REVISION || process.env.K_CONFIGURATION);
        if (!isCloudRun && config.app.nodeEnv === 'development') {
            logger.info('ChatVibes: Local development detected. Using TWITCH_CHANNELS from .env');
            const envChannels = (process.env.TWITCH_CHANNELS || '')
                .split(',')
                .map(ch => ch.trim().toLowerCase())
                .filter(Boolean);
            // Apply allow-list if present
            const allowList = getAllowedChannels();
            const filteredChannels = allowList.length > 0 ? envChannels.filter(ch => allowList.includes(ch)) : envChannels;
            
            if (envChannels.length === 0) {
                logger.fatal('ChatVibes: TWITCH_CHANNELS is empty or not set in .env for development. Please set it.');
                process.exit(1);
            }
            if (allowList.length > 0 && filteredChannels.length === 0) {
                logger.fatal('ChatVibes: All configured dev channels are blocked by allow-list. Update ALLOWED_CHANNELS or TWITCH_CHANNELS.');
                process.exit(1);
            }
            config.twitch.channels = [...new Set(filteredChannels)];
            logger.info(`ChatVibes: Loaded ${config.twitch.channels.length} channels from .env: [${config.twitch.channels.join(', ')}]`);
        } else {
            logger.info('ChatVibes: Cloud environment detected or not development. Loading channels from Firestore.');
            try {
                const managedChannels = await getActiveManagedChannels();
                if (managedChannels && managedChannels.length > 0) {
                    config.twitch.channels = [...new Set(managedChannels)];
                    logger.info(`ChatVibes: Loaded ${config.twitch.channels.length} channels from Firestore.`);
                } else {
                    logger.warn('ChatVibes: No active channels found in Firestore managedChannels collection. Bot will wait for dynamic joins.');
                    config.twitch.channels = [];
                }
            } catch (error) {
                logger.error({ err: error }, 'ChatVibes: Error loading channels from Firestore.');
                config.twitch.channels = [];
            }
        }
        if (!config.twitch.channels) config.twitch.channels = [];

        logger.info('ChatVibes: Initializing Twitch Helix Client...');
        await initializeHelixClient();

        logger.info('ChatVibes: Initializing Command Processor for commands...');
        initializeCommandProcessor();

        logger.info('ChatVibes: Initializing IRC Sender queue...');
        initializeIrcSender();

        // Initialize Pub/Sub for cross-instance TTS communication
        logger.info('ChatVibes: Initializing Pub/Sub for TTS message distribution...');
        await initializePubSub();

        // Subscribe to TTS events from Pub/Sub
        // All instances subscribe, but only process if they have active WebSocket clients
        logger.info('ChatVibes: Setting up Pub/Sub subscriber for TTS events...');
        await subscribeTtsEvents(async (channelName, eventData, sharedSessionInfo) => {
            // This handler is called on ALL instances when a TTS event is published
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
            
            await ttsQueue.enqueue(channelName, eventData, sharedSessionInfo);
        });
        logger.info('ChatVibes: Pub/Sub subscriber ready');

        // Start the Web Server early (independent of IRC leadership)
        logger.info('ChatVibes: Initializing Web Server for OBS audio...');
        const { server: webServerInstance } = initializeWebServer();
        global.healthServer = webServerInstance;

        // Functions to start/stop IRC subsystem under leader election
        const startIrcSubsystem = async () => {
            if (ircStartedByThisInstance) {
                logger.info('ChatVibes: IRC subsystem already started by this instance.');
                return;
            }
            logger.info('ChatVibes: Creating Twitch IRC Client instance (leader acquired)...');
            ircClientInstance = await createIrcClient(config.twitch);

            // --- Setup IRC Event Listeners ---
            ircClientInstance.on('connected', async (address, port) => {
                logger.info(`ChatVibes: Successfully connected to Twitch IRC: ${address}:${port}`);
                if (config.app.nodeEnv !== 'development') {
                    logger.info('ChatVibes: Setting up Firestore channel listener and performing initial sync.');
                    if (!channelChangeListener) {
                        channelChangeListener = listenForChannelChanges(ircClientInstance);
                    }
                    await syncManagedChannelsWithIrc(ircClientInstance);
                } else {
                    logger.info('ChatVibes (DEV MODE): Relying on TMI.js auto-join for channels specified in client options.');
                }
            });

            ircClientInstance.on('disconnected', (reason) => {
                logger.warn(`ChatVibes: Disconnected from Twitch IRC: ${reason || 'Unknown reason'}`);
                if (channelChangeListener) {
                    channelChangeListener();
                    channelChangeListener = null;
                }
            });

            // --- MESSAGE HANDLER ---
            ircClientInstance.on('message', async (channel, tags, message, self) => {
            if (self) return;

            // --- 1. PREPARATION ---
            const channelNameNoHash = channel.substring(1).toLowerCase();
            if (!isChannelAllowed(channelNameNoHash)) return;
            const username = tags.username?.toLowerCase();
            const bits = parseInt(tags.bits, 10) || 0;

            // Check for shared chat session
            const sharedSessionInfo = await getSharedSessionInfo(channelNameNoHash);
            if (sharedSessionInfo) {
                logger.debug({
                    channel: channelNameNoHash,
                    sessionId: sharedSessionInfo.sessionId,
                    sharedChannels: sharedSessionInfo.channels
                }, `[SharedChat:${sharedSessionInfo.sessionId}] Processing message in shared session with: ${sharedSessionInfo.channels.join(', ')}`);
            }

            // Intercept Channel Points redemption messages for the TTS reward
            if (tags['custom-reward-id']) {
                try {
                    const ttsConfig = await getTtsState(channelNameNoHash);
                    const configuredRewardId = ttsConfig.channelPoints?.rewardId || ttsConfig.channelPointRewardId;
                    const enabledViaNewConfig = ttsConfig.channelPoints ? ttsConfig.channelPoints.enabled === true : true;
                    if (configuredRewardId && tags['custom-reward-id'] === configuredRewardId && enabledViaNewConfig) {
                        const redeemingUser = username;
                        const redeemMessage = (message || '').trim();
                        if (redeemMessage.length > 0) {
                            // Enforce content policy if configured
                            const policy = (ttsConfig.channelPoints && ttsConfig.channelPoints.contentPolicy) || {};
                            const minChars = typeof policy.minChars === 'number' ? policy.minChars : 1;
                            const maxChars = typeof policy.maxChars === 'number' ? policy.maxChars : 200;
                            const blockLinks = policy.blockLinks !== false; // default block links
                            const bannedWords = Array.isArray(policy.bannedWords) ? policy.bannedWords : [];
                            if (redeemMessage.length < minChars) return;
                            if (redeemMessage.length > maxChars) return;
                            if (blockLinks && /\bhttps?:\/\//i.test(redeemMessage)) return;
                            const lowered = redeemMessage.toLowerCase();
                            if (bannedWords.some(w => w && lowered.includes(String(w).toLowerCase()))) return;

                            const isIgnored = Array.isArray(ttsConfig.ignoredUsers) && ttsConfig.ignoredUsers.includes(redeemingUser);
                            if (ttsConfig.engineEnabled && !isIgnored) {
                                // Process URLs based on channel configuration
                                const processedMessage = processMessageUrls(redeemMessage, ttsConfig.readFullUrls);
                                await publishTtsEvent(channelNameNoHash, { text: processedMessage, user: redeemingUser, type: 'reward' }, sharedSessionInfo);
                            }
                        }
                        return; // Do not process further as normal chat/command
                    }
                    // If it's some other reward, ignore for TTS and do not treat as normal chat
                    return;
                } catch (e) {
                    logger.warn({ err: e }, `ChatVibes: Error handling custom reward redemption for ${channelNameNoHash}`);
                    return;
                }
            }

            // Clean the cheermote from the message if it has bits.
            // Handle both "Cheer100 hello", "Cheer 100 hello", "!tts Cheer100 hello", and "!tts Cheer 100 hello" formats
            let cleanMessage = message;
            if (bits > 0) {
                // Remove cheermotes from beginning: "Cheer100 hello" or "Cheer 100 hello" -> "hello"
                cleanMessage = cleanMessage.replace(/^[\w]+\s*\d+\s*/, '').trim();
                // Remove cheermotes after !tts: "!tts Cheer100 hello" or "!tts Cheer 100 hello" -> "!tts hello"
                cleanMessage = cleanMessage.replace(/^(!tts\s+)[\w]+\s*\d+\s*/, '$1').trim();
            }

            if (!cleanMessage) return;

            // --- 2. COMMAND PROCESSING ---
            const processedCommandName = await processCommand(channelNameNoHash, tags, cleanMessage);

            // --- 3. TTS PROCESSING ---
            const ttsConfig = await getTtsState(channelNameNoHash);
            const isTtsIgnored = ttsConfig.ignoredUsers && ttsConfig.ignoredUsers.includes(username);

            // If TTS is globally off for the channel or the user is on the ignore list, do no TTS.
            if (!ttsConfig.engineEnabled || isTtsIgnored) {
                return;
            }

            // Skip TTS processing for cheer messages in the regular handler - they'll be handled by the dedicated cheer handler
            if (bits > 0) {
                return;
            }

            // A. If a command was just run, decide if we should READ the command text aloud.
            if (processedCommandName) {
                // Requirement 3: Read !music commands aloud. 
                if (processedCommandName !== 'tts' && ttsConfig.mode === 'all') {
                    // Process URLs based on channel configuration
                    const processedMessage = processMessageUrls(cleanMessage, ttsConfig.readFullUrls);
                    await publishTtsEvent(channelNameNoHash, { text: processedMessage, user: username, type: 'command' }, sharedSessionInfo);
                } else if (ttsConfig.mode === 'bits_points_only') {
                    // In bits/points only mode, do not read commands
                    return;
                }
            }
            // B. If it was NOT a command, it's a regular chat message.
            else {
                // Handle regular chat messages according to the TTS mode.
                if (ttsConfig.bitsModeEnabled) {
                    // In bits mode, only messages with enough bits get read.
                    if (bits > 0) {
                        const minimumBits = ttsConfig.bitsMinimumAmount || 1;
                        if (bits >= minimumBits) {
                            // Process URLs based on channel configuration
                            const processedMessage = processMessageUrls(cleanMessage, ttsConfig.readFullUrls);
                            await publishTtsEvent(channelNameNoHash, { text: processedMessage, user: username, type: 'cheer_tts' }, sharedSessionInfo);
                        }
                    }
                    // If bits mode is on and it's a regular message (no bits), we do nothing.
                } 
                // Requirement 1: If bits mode is OFF, check for 'all' mode to read regular chat.
                else if (ttsConfig.mode === 'all') {
                    const requiredPermission = ttsConfig.ttsPermissionLevel === 'mods' ? 'moderator' : 'everyone';
                    if (hasPermission(requiredPermission, tags, channelNameNoHash)) {
                        // Process URLs based on channel configuration
                        const processedMessage = processMessageUrls(cleanMessage, ttsConfig.readFullUrls);
                        await publishTtsEvent(channelNameNoHash, { text: processedMessage, user: username, type: 'chat' }, sharedSessionInfo);
                    }
                } else if (ttsConfig.mode === 'bits_points_only') {
                    // In bits/points only mode, ignore normal chat
                    return;
                }
            }
            });

            // --- Event Handlers ---
            ircClientInstance.on('subscription', (channel, username, _method, message, _userstate) => {
            const channelNameNoHash = channel.substring(1).toLowerCase();
            if (!isChannelAllowed(channelNameNoHash)) return;
            handleTwitchEventForTTS(channel, username, 'subscription', `${username} just subscribed! ${message || ''}`);
            });
            ircClientInstance.on('resub', (channel, username, months, message, _userstate, _methods) => {
            const channelNameNoHash = channel.substring(1).toLowerCase();
            if (!isChannelAllowed(channelNameNoHash)) return;
            handleTwitchEventForTTS(channel, username, 'resub', `${username} resubscribed for ${months} months! ${message || ''}`);
            });

            // Handle cheer messages - both with and without text
            ircClientInstance.on('cheer', async (channel, userstate, message) => {
            const channelNameNoHash = channel.substring(1);
            if (!isChannelAllowed(channelNameNoHash.toLowerCase())) return;
            const username = userstate.username?.toLowerCase();
            const bits = parseInt(userstate.bits, 10) || 0;
            
            // Check for shared session
            const sharedSessionInfo = await getSharedSessionInfo(channelNameNoHash);
            
            // Clean the cheermote from the message - handle both "Cheer100" and "Cheer 100" formats
            const cleanMessage = message.replace(/^[\w]+\s*\d+\s*/, '').trim();
            
            if (cleanMessage) {
                // Skip processing if this is a !tts command, as it's already handled by the regular message handler
                if (message.trim().toLowerCase().startsWith('!tts')) {
                    return;
                }

                // Process cheer message with content - treat like a regular message but with bits
                logger.info(`[CHEER EVENT] Channel: ${channel}, User: ${username}, Message: "${message}", Cleaned: "${cleanMessage}", Bits: ${bits}`);

                // Command processing for cheer messages
                const processedCommandName = await processCommand(channelNameNoHash, userstate, cleanMessage);
                
                // TTS processing for cheer messages
                const ttsConfig = await getTtsState(channelNameNoHash);
                const isTtsIgnored = ttsConfig.ignoredUsers && ttsConfig.ignoredUsers.includes(username);
                
                if (ttsConfig.engineEnabled && !isTtsIgnored) {
                    if (processedCommandName) {
                        // Read commands aloud in 'all' mode or 'command' mode, but not in 'bits_points_only' mode
                        if (processedCommandName !== 'tts' && (ttsConfig.mode === 'all' || ttsConfig.mode === 'command')) {
                            await publishTtsEvent(channelNameNoHash, { text: cleanMessage, user: username, type: 'command' }, sharedSessionInfo);
                        }
                        // In bits_points_only mode, do not read commands
                    } else {
                        // For non-command cheer messages, respect the TTS mode
                        if (ttsConfig.bitsModeEnabled) {
                            const minimumBits = ttsConfig.bitsMinimumAmount || 1;
                            if (bits >= minimumBits) {
                                // In command mode, even with bits enabled, we should not read non-command cheer messages
                                if (ttsConfig.mode === 'all' || ttsConfig.mode === 'bits_points_only') {
                                    await publishTtsEvent(channelNameNoHash, { text: cleanMessage, user: username, type: 'cheer_tts' }, sharedSessionInfo);
                                }
                                // In command mode, non-command cheer messages should be ignored even with bits
                            }
                        } else if (ttsConfig.mode === 'all') {
                            // Only read non-command cheer messages in 'all' mode, not in 'command' mode
                            const requiredPermission = ttsConfig.ttsPermissionLevel === 'mods' ? 'moderator' : 'everyone';
                            if (hasPermission(requiredPermission, userstate, channelNameNoHash)) {
                                await publishTtsEvent(channelNameNoHash, { text: cleanMessage, user: username, type: 'chat' }, sharedSessionInfo);
                            }
                        } // else command mode or bits_points_only with bitsMode disabled => do nothing for non-command messages
                    }
                }
            } else {
                // Cheer without message - announce the event if appropriate
                const displayName = userstate['display-name'] || userstate.username;
                const ttsConfig = await getTtsState(channelNameNoHash);
                const musicState = await getMusicState(channelNameNoHash);

                if (!ttsConfig.bitsModeEnabled && !musicState.bitsModeEnabled && ttsConfig.engineEnabled && ttsConfig.speakEvents) {
                    const cheerAnnouncement = `${displayName} cheered ${userstate.bits} bits!`;
                    await handleTwitchEventForTTS(channel, userstate.username, 'cheer', cheerAnnouncement);
                }
            }
            });

            ircClientInstance.on('raided', (channel, username, viewers) => {
            const channelNameNoHash = channel.substring(1).toLowerCase();
            if (!isChannelAllowed(channelNameNoHash)) return;
            handleTwitchEventForTTS(channel, username, 'raid', `${username} is raiding with ${viewers} viewers!`);
            });

            const handleTwitchEventForTTS = async (channel, username, eventType, eventDetailsText) => {
             const channelNameNoHash = channel.substring(1);
             const ttsConfig = await getTtsState(channelNameNoHash);
             if (ttsConfig.engineEnabled && ttsConfig.speakEvents) {
                 logger.info(`ChatVibes [${channelNameNoHash}]: TTS Event: ${eventType} by ${username}.`);
                 const sharedSessionInfo = await getSharedSessionInfo(channelNameNoHash);
                 await publishTtsEvent(channelNameNoHash, { text: eventDetailsText, user: username, type: 'event' }, sharedSessionInfo);
             }
            };

            logger.info('ChatVibes: Connecting to Twitch IRC...');
            await connectIrcClient();
            ircClientInstance = getIrcClient();
            ircStartedByThisInstance = true;
        };

        const stopIrcSubsystem = async () => {
            if (!ircStartedByThisInstance) return;
            try {
                const client = ircClientInstance || getIrcClient();
                if (client && typeof client.disconnect === 'function') {
                    await client.disconnect();
                }
            } catch (e) {
                logger.warn({ err: e }, 'ChatVibes: Error while stopping IRC subsystem');
            }
            if (channelChangeListener) {
                try { channelChangeListener(); } catch {}
                channelChangeListener = null;
            }
            ircStartedByThisInstance = false;
        };

        // Start leader election to ensure only one active IRC processor
        if (config.app.nodeEnv === 'development') {
            logger.info('ChatVibes (DEV MODE): Skipping leader election, starting IRC subsystem directly...');
            await startIrcSubsystem();
        } else {
            leaderElection = createLeaderElection();
            await leaderElection.start({
                onStartedLeading: startIrcSubsystem,
                onStoppedLeading: stopIrcSubsystem,
            });
        }

        logger.info(`ChatVibes: Bot username: ${config.twitch.username}.`);

    } catch (error) {
        logger.fatal({ err: error, stack: error.stack }, 'ChatVibes: Fatal error during initialization.');
        process.exit(1);
    }
}

// Graceful shutdown hooks
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (error) => {
    logger.fatal({ err: error, stack: error.stack }, 'ChatVibes: Uncaught Exception!');
    gracefulShutdown('UNCAUGHT_EXCEPTION').catch(err => {
        logger.error({ err: err.stack }, 'ChatVibes: Error during graceful shutdown from uncaught exception.');
        process.exit(1);
    });
    setTimeout(() => process.exit(1), 10000).unref();
});
process.on('unhandledRejection', (reason, promise) => {
    const errorReason = reason instanceof Error ? { message: reason.message, stack: reason.stack } : reason;
    logger.error({ reason: errorReason, promise }, 'ChatVibes: Unhandled Rejection at Promise');
});

main();