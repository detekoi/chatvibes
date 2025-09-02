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

// Channel Management
import { initializeChannelManager, getActiveManagedChannels, syncManagedChannelsWithIrc, listenForChannelChanges, listenForObsTokenChanges } from './components/twitch/channelManager.js';

let ircClientInstance = null;
let channelChangeListener = null;
let obsTokenChangeListener = null;
let isShuttingDown = false;

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

    if (obsTokenChangeListener && typeof obsTokenChangeListener === 'function') {
        try {
            logger.info('ChatVibes: Cleaning up Firestore OBS token change listener...');
            obsTokenChangeListener();
            obsTokenChangeListener = null;
            logger.info('ChatVibes: Firestore OBS token change listener cleaned up.');
        } catch (error) {
            logger.error({ err: error }, 'ChatVibes: Error cleaning up Firestore OBS token change listener.');
        }
    } else {
        logger.info('ChatVibes: No active Firestore OBS token change listener to clean up.');
    }

    clearMessageQueue();
    logger.info('ChatVibes: IRC message sender queue cleared.');

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

        logger.info('ChatVibes: Creating Twitch IRC Client instance...');
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
            
            // Always set up OBS token listener (needed for WebSocket authentication)
            if (!obsTokenChangeListener) {
                obsTokenChangeListener = listenForObsTokenChanges();
            }
        });

        ircClientInstance.on('disconnected', (reason) => {
            logger.warn(`ChatVibes: Disconnected from Twitch IRC: ${reason || 'Unknown reason'}`);
            if (channelChangeListener) {
                channelChangeListener();
                channelChangeListener = null;
            }
            if (obsTokenChangeListener) {
                obsTokenChangeListener();
                obsTokenChangeListener = null;
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

            // Clean the cheermote from the message if it has bits.
            const cleanMessage = bits > 0 ? message.replace(/^[\w]+\d+\s*/, '').trim() : message;

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

            // A. If a command was just run, decide if we should READ the command text aloud.
            if (processedCommandName) {
                // Requirement 3: Read !music commands aloud. 
                if (processedCommandName !== 'tts' && ttsConfig.mode === 'all') {
                    await ttsQueue.enqueue(channelNameNoHash, { text: cleanMessage, user: username, type: 'command' });
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
                            await ttsQueue.enqueue(channelNameNoHash, { text: cleanMessage, user: username, type: 'cheer_tts' });
                        }
                    }
                    // If bits mode is on and it's a regular message (no bits), we do nothing.
                } 
                // Requirement 1: If bits mode is OFF, check for 'all' mode to read regular chat.
                else if (ttsConfig.mode === 'all') {
                    const requiredPermission = ttsConfig.ttsPermissionLevel === 'mods' ? 'moderator' : 'everyone';
                    if (hasPermission(requiredPermission, tags, channelNameNoHash)) {
                        await ttsQueue.enqueue(channelNameNoHash, { text: cleanMessage, user: username, type: 'chat' });
                    }
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
            
            // Clean the cheermote from the message
            const cleanMessage = message.replace(/^[\w]+\d+\s*/, '').trim();
            
            if (cleanMessage) {
                // Process cheer message with content - treat like a regular message but with bits
                logger.info(`[CHEER EVENT] Channel: ${channel}, User: ${username}, Message: "${message}", Cleaned: "${cleanMessage}", Bits: ${bits}`);
                
                // Command processing for cheer messages
                const processedCommandName = await processCommand(channelNameNoHash, userstate, cleanMessage);
                
                // TTS processing for cheer messages
                const ttsConfig = await getTtsState(channelNameNoHash);
                const isTtsIgnored = ttsConfig.ignoredUsers && ttsConfig.ignoredUsers.includes(username);
                
                if (ttsConfig.engineEnabled && !isTtsIgnored) {
                    if (processedCommandName) {
                        // Read command aloud if appropriate
                        if (processedCommandName !== 'tts' && ttsConfig.mode === 'all') {
                            await ttsQueue.enqueue(channelNameNoHash, { text: cleanMessage, user: username, type: 'command' });
                        }
                    } else {
                        // Handle regular cheer messages according to TTS mode
                        if (ttsConfig.bitsModeEnabled) {
                            const minimumBits = ttsConfig.bitsMinimumAmount || 1;
                            if (bits >= minimumBits) {
                                await ttsQueue.enqueue(channelNameNoHash, { text: cleanMessage, user: username, type: 'cheer_tts' });
                            }
                        } else if (ttsConfig.mode === 'all') {
                            const requiredPermission = ttsConfig.ttsPermissionLevel === 'mods' ? 'moderator' : 'everyone';
                            if (hasPermission(requiredPermission, userstate, channelNameNoHash)) {
                                await ttsQueue.enqueue(channelNameNoHash, { text: cleanMessage, user: username, type: 'chat' });
                            }
                        }
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
                 await ttsQueue.enqueue(channelNameNoHash, { text: eventDetailsText, user: username, type: 'event' });
             }
        };

        logger.info('ChatVibes: Connecting to Twitch IRC...');
        await connectIrcClient();
        ircClientInstance = getIrcClient();

        logger.info('ChatVibes: Initializing Web Server for OBS audio...');
        const { server: webServerInstance } = initializeWebServer();
        global.healthServer = webServerInstance;

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