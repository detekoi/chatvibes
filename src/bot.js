// src/bot.js
import config from './config/index.js';
import logger from './lib/logger.js';
import http from 'http';

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
import { initializeMusicState } from './components/music/musicState.js';

// Command Processing
import { initializeCommandProcessor, processMessage as processCommand } from './components/commands/commandProcessor.js';
import { initializeIrcSender, enqueueMessage, clearMessageQueue } from './lib/ircSender.js';

// Channel Management
import { initializeChannelManager, getActiveManagedChannels, syncManagedChannelsWithIrc, listenForChannelChanges } from './components/twitch/channelManager.js';

let ircClientInstance = null;
let channelChangeListener = null;
const CHANNEL_SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
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

        logger.info('ChatVibes: Initializing TTS State (Firestore)...');
        await initializeTtsState();

        logger.info('ChatVibes: Initializing Music State (Firestore)...');
        await initializeMusicState();

        logger.info('ChatVibes: Initializing Channel Manager (Firestore)...');
        await initializeChannelManager();
        
        logger.info('ChatVibes: Initializing Music Generation system (queues)...');
        initializeMusicQueues();

        // Load Twitch Channels
        if (config.app.nodeEnv === 'development') {
            const devChannelsRaw = process.env.TWITCH_CHANNELS || "";
            const devChannels = devChannelsRaw.split(',').map(ch => ch.trim().toLowerCase()).filter(ch => ch);
            if (devChannels.length === 0) {
                logger.fatal('ChatVibes (DEV MODE): TWITCH_CHANNELS environment variable is not set or results in an empty list. Please set it.');
                process.exit(1);
            }
            config.twitch.channels = [...new Set(devChannels)];
            logger.info(`ChatVibes (DEV MODE): Unique channels prepared for TMI client options: [${config.twitch.channels.join(', ')}]`);
        } else {
            logger.info('ChatVibes: Loading active channels from Firestore for TMI client options...');
            try {
                const managedChannels = await getActiveManagedChannels();
                config.twitch.channels = [...new Set(managedChannels || [])];
                logger.info(`ChatVibes: Unique channels from Firestore for TMI client options: [${config.twitch.channels.join(', ')}]`);
                if (config.twitch.channels.length === 0) {
                    logger.warn('ChatVibes: No active channels from Firestore. Bot will rely on dynamic joins.');
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
        });

        ircClientInstance.on('disconnected', (reason) => {
            logger.warn(`ChatVibes: Disconnected from Twitch IRC: ${reason || 'Unknown reason'}`);
            if (channelChangeListener) {
                channelChangeListener();
                channelChangeListener = null;
            }
        });

        // --- MESSAGE HANDLER for ChatVibes ---
        ircClientInstance.on('message', async (channel, tags, message, self) => {
            if (self) return;

            const channelNameNoHash = channel.substring(1).toLowerCase();
            const username = tags.username?.toLowerCase();

            const processedCommandName = await processCommand(channelNameNoHash, tags, message);

            if (processedCommandName) {
                // Special handling for music command to also be read by TTS if mode is 'all'
                if (processedCommandName === 'music') {
                    const ttsConfig = await getTtsState(channelNameNoHash);
                    if (ttsConfig.engineEnabled && ttsConfig.mode === 'all' && !(ttsConfig.ignoredUsers && ttsConfig.ignoredUsers.includes(username))) {
                        await ttsQueue.enqueue(channelNameNoHash, { text: message, user: username, type: 'command_music' });
                    }
                }
            } else {
                // --- TTS for regular chat messages ---
                const ttsConfig = await getTtsState(channelNameNoHash);
                const isIgnoredUser = ttsConfig.ignoredUsers && ttsConfig.ignoredUsers.includes(username);

                // **MERGED LOGIC**: Only enqueue if engine is on, mode is 'all', user isn't ignored, AND bits mode is OFF.
                if (ttsConfig.engineEnabled && ttsConfig.mode === 'all' && !isIgnoredUser && !ttsConfig.bitsModeEnabled) {
                    logger.debug(`ChatVibes [${channelNameNoHash}]: Mode ALL - Enqueuing message from ${username} for TTS: "${message.substring(0,30)}..."`);
                    await ttsQueue.enqueue(channelNameNoHash, {
                        text: message,
                        user: username,
                        type: 'chat',
                    });
                } else {
                     logger.debug({
                        channel: channelNameNoHash, user: username,
                        engineEnabled: ttsConfig.engineEnabled, mode: ttsConfig.mode, isIgnored: isIgnoredUser,
                        bitsModeEnabled: ttsConfig.bitsModeEnabled,
                        messageWasCommand: !!processedCommandName
                    }, "ChatVibes: Message not enqueued for TTS.");
                }
            }
        });

        // --- Event Handlers ---
        ircClientInstance.on('subscription', (channel, username, method, message, userstate) => {
            handleTwitchEventForTTS(channel, username, 'subscription', `${username} just subscribed! ${message || ''}`);
        });
        ircClientInstance.on('resub', (channel, username, months, message, userstate, methods) => {
            handleTwitchEventForTTS(channel, username, 'resub', `${username} resubscribed for ${months} months! ${message || ''}`);
        });
        
        // Cheer handler with Bits-for-TTS feature
        ircClientInstance.on('cheer', async (channel, userstate, message) => {
            const channelNameNoHash = channel.substring(1);
            const ttsConfig = await getTtsState(channelNameNoHash);

            if (ttsConfig.bitsModeEnabled) {
                const minimumBits = ttsConfig.bitsMinimumAmount || 1;
                const userBits = parseInt(userstate.bits, 10);

                if (userBits >= minimumBits) {
                    if (message && message.trim().length > 0) {
                        logger.info(`[${channelNameNoHash}] Bits-for-TTS: User ${userstate.username} cheered ${userBits}. Enqueuing message.`);
                        await ttsQueue.enqueue(channelNameNoHash, { text: message, user: userstate.username, type: 'cheer_tts' });
                    }
                }
            } else if (ttsConfig.engineEnabled && ttsConfig.speakEvents) {
                // Fallback to default cheer announcement if bits mode is off but events are on
                const cheerAnnouncement = `${userstate['display-name'] || userstate.username} cheered ${userstate.bits} bits! ${message}`;
                await handleTwitchEventForTTS(channel, userstate.username, 'cheer', cheerAnnouncement);
            }
        });

        ircClientInstance.on('raided', (channel, username, viewers, tags) => {
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