// src/bot.js
import config from './config/index.js';
import logger from './lib/logger.js';
import http from 'http';

// Core Twitch & Cloud
import { initializeSecretManager } from './lib/secretManager.js';
import { createIrcClient, connectIrcClient, getIrcClient } from './components/twitch/ircClient.js';
// **** HELIX CLIENT IS STILL USEFUL ****
import { initializeHelixClient, getHelixClient } from './components/twitch/helixClient.js';

// ChatVibes TTS Components
import { initializeTtsState, getTtsState } from './components/tts/ttsState.js';
// **** TTSSERVICE IS ESSENTIAL ****
import * as ttsService from './components/tts/ttsService.js'; // generateSpeech, getAvailableVoices
import * as ttsQueue from './components/tts/ttsQueue.js';
import { initializeWebServer } from './components/web/server.js';

//Music Components
import { initializeMusicQueues } from './components/music/musicQueue.js';
// ++ ADD THIS IMPORT ++
import { initializeMusicState } from './components/music/musicState.js'; // [ नवे]

// Command Processing
import { initializeCommandProcessor, processMessage as processCommand } from './components/commands/commandProcessor.js';
import { initializeIrcSender, enqueueMessage, clearMessageQueue } from './lib/ircSender.js';

// Channel Management
import { initializeChannelManager, getActiveManagedChannels, syncManagedChannelsWithIrc, listenForChannelChanges } from './components/twitch/channelManager.js';

// ... (rest of the bot.js file)
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
        const packageName = config.name || 'chatvibes-tts';
        const packageVersion = config.version || '1.0.0';
        logger.info(`Starting ${packageName} v${packageVersion}...`);
        logger.info(`Node Env: ${config.app.nodeEnv}, Log Level: ${config.app.logLevel}`);
        logger.info(`Project ID: ${process.env.GOOGLE_CLOUD_PROJECT || 'ChatVibesTTS (Hardcoded fallback - Set GOOGLE_CLOUD_PROJECT)'}`);

        // Initialize core components
        logger.info('ChatVibes: Initializing Secret Manager...');
        initializeSecretManager(); //

        logger.info('ChatVibes: Initializing TTS State (Firestore)...');
        await initializeTtsState(); //

        // ++ INITIALIZE MUSIC STATE HERE ++
        logger.info('ChatVibes: Initializing Music State (Firestore)...'); // [ नवे]
        await initializeMusicState(); // [ नवे]

        logger.info('ChatVibes: Initializing Channel Manager (Firestore)...');
        await initializeChannelManager(); //

        // Music Generation System
        logger.info('ChatVibes: Initializing Music Generation system (queues)...'); // [ नवे]
        initializeMusicQueues(); //

        // Load Twitch Channels (dynamic from Firestore in prod, static from .env in dev)
        if (config.app.nodeEnv === 'development') {
            if (!process.env.TWITCH_CHANNELS || config.twitch.channels.length === 0) {
                logger.fatal('ChatVibes (DEV MODE): TWITCH_CHANNELS environment variable is not set or empty. Please set it in your .env file for the bot to join your test channel(s).');
                process.exit(1);
            }
            logger.info(`ChatVibes (DEV MODE): Loaded ${config.twitch.channels.length} channels from .env: [${config.twitch.channels.join(', ')}]`);
        } else {
            logger.info('ChatVibes: Loading active channels from Firestore...');
            try {
                const managedChannels = await getActiveManagedChannels();
                if (managedChannels && managedChannels.length > 0) {
                    config.twitch.channels = managedChannels.map(ch => ch.toLowerCase());
                    logger.info(`ChatVibes: Loaded ${config.twitch.channels.length} active channels from Firestore: [${config.twitch.channels.join(', ')}]`);
                } else {
                    logger.warn('ChatVibes: No active channels found in Firestore. The bot will connect to Twitch IRC but may not join any channels until they are added via the (future) web UI or if TWITCH_CHANNELS env var is used as a fallback.');
                    if (process.env.TWITCH_CHANNELS && process.env.TWITCH_CHANNELS.split(',').map(ch => ch.trim()).filter(ch => ch).length > 0) {
                        config.twitch.channels = process.env.TWITCH_CHANNELS.split(',').map(ch => ch.trim().toLowerCase()).filter(ch => ch);
                        logger.info(`ChatVibes (Fallback): Loaded ${config.twitch.channels.length} channels from TWITCH_CHANNELS env var: [${config.twitch.channels.join(', ')}]`);
                    } else if (config.twitch.channels.length === 0) {
                        logger.warn('ChatVibes: No channels configured from Firestore or TWITCH_CHANNELS env var.');
                    }
                }
            } catch (error) {
                logger.error({ err: error }, 'ChatVibes: Error loading channels from Firestore. Check Firestore setup and permissions.');
                if (!config.twitch.channels || config.twitch.channels.length === 0) {
                    logger.fatal("ChatVibes: Failed to load channels from any source. Exiting.");
                    process.exit(1);
                }
            }
        }
        if (!config.twitch.channels || config.twitch.channels.length === 0) {
            logger.warn('ChatVibes: No Twitch channels configured to join initially. The bot will connect but rely on the Web UI or Firestore updates to join channels.');
        }

        logger.info('ChatVibes: Initializing Twitch Helix Client...');
        await initializeHelixClient(config.twitch); //

        logger.info('ChatVibes: Initializing Command Processor for !tts commands...');
        initializeCommandProcessor(); //

        logger.info('ChatVibes: Initializing IRC Sender queue...');
        initializeIrcSender(); //

        logger.info('ChatVibes: Creating Twitch IRC Client instance...');
        ircClientInstance = await createIrcClient(config.twitch); //

        // --- Setup IRC Event Listeners ---
        ircClientInstance.on('connected', async (address, port) => {
            logger.info(`ChatVibes: Successfully connected to Twitch IRC: ${address}:${port}`);
            if (config.app.nodeEnv !== 'development') {
                logger.info('ChatVibes: Setting up Firestore channel listener and performing initial sync.');
                if (!channelChangeListener) {
                    channelChangeListener = listenForChannelChanges(ircClientInstance);
                }
                try {
                    const syncResult = await syncManagedChannelsWithIrc(ircClientInstance);
                    logger.info(`ChatVibes: Initial channel sync - Joined: ${syncResult.joined.length}, Parted: ${syncResult.parted.length}`);
                    const activeChannels = await getActiveManagedChannels();
                    config.twitch.channels = activeChannels.map(ch => ch.toLowerCase());
                    logger.info(`ChatVibes: Config updated with ${config.twitch.channels.length} active channels post-sync.`);
                } catch (error) {
                    logger.error({ err: error }, 'ChatVibes: Error during initial channel sync from Firestore.');
                }
                setInterval(async () => {
                    if (config.app.nodeEnv !== 'development') {
                        try {
                            logger.info('ChatVibes: Running scheduled channel sync...');
                            const syncResult = await syncManagedChannelsWithIrc(ircClientInstance);
                            if (syncResult.joined.length > 0 || syncResult.parted.length > 0) {
                                const currentActive = await getActiveManagedChannels();
                                config.twitch.channels = currentActive.map(ch => ch.toLowerCase());
                                logger.info(`ChatVibes: Updated config with ${config.twitch.channels.length} active channels after scheduled sync.`);
                            }
                        } catch (error) {
                            logger.error({ err: error }, 'ChatVibes: Error during scheduled channel sync.');
                        }
                    }
                }, CHANNEL_SYNC_INTERVAL_MS);
            } else {
                logger.info('ChatVibes (DEV MODE): Skipping Firestore channel listener and sync. Joining channels from .env.');
                if (config.twitch.channels.length > 0) {
                    config.twitch.channels.forEach(ch => {
                        const channelToJoin = ch.startsWith('#') ? ch : `#${ch.toLowerCase()}`;
                        logger.info(`ChatVibes (DEV MODE): Attempting to join channel from .env: ${channelToJoin}`);
                        ircClientInstance.join(channelToJoin)
                            .catch(err => logger.error({err, channel: channelToJoin}, `Failed to join ${channelToJoin} in dev mode`));
                    });
                }
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
            if (self) {
                logger.trace(`ChatVibes [${channel.substring(1).toLowerCase()}]: 'self' is true for message from ${tags.username}. Skipping further processing.`);
                return;
            }

            const channelNameNoHash = channel.substring(1).toLowerCase();
            const username = tags.username?.toLowerCase();

            // 1. Process Bot Commands (like !tts, !music)
            const commandWasProcessed = await processCommand(channelNameNoHash, tags, message);

            // 2. If not a command, consider for TTS based on mode
            if (!commandWasProcessed) {
                // Secondary Guard: Check if the message sender is the bot itself.
                // This prevents the bot's own status messages (e.g., from !music command)
                // from being enqueued for TTS when mode is 'all'.
                if (username && config.twitch.username && username === config.twitch.username.toLowerCase()) {
                    logger.trace(`ChatVibes [${channelNameNoHash}]: Message from bot user ${username} (config: ${config.twitch.username.toLowerCase()}) and not a command. Skipping TTS queueing.`);
                    return;
                }

                const ttsConfig = await getTtsState(channelNameNoHash);
                const isIgnoredUser = ttsConfig.ignoredUsers && ttsConfig.ignoredUsers.includes(username);

                if (ttsConfig.engineEnabled && ttsConfig.mode === 'all' && !isIgnoredUser) {
                    logger.debug(`ChatVibes [${channelNameNoHash}]: Mode ALL - Enqueuing message from ${username} for TTS: "${message.substring(0,30)}..."`);
                    await ttsQueue.enqueue(channelNameNoHash, {
                        text: message,
                        user: username,
                        type: 'chat',
                    });
                } else {
                    logger.trace({
                        channel: channelNameNoHash,
                        user: username,
                        engineEnabled: ttsConfig.engineEnabled,
                        mode: ttsConfig.mode,
                        isIgnored: isIgnoredUser,
                        messageWasCommand: commandWasProcessed,
                        isBotMessage: (username && config.twitch.username && username === config.twitch.username.toLowerCase())
                    }, "ChatVibes: Message not enqueued for TTS (not 'all' mode, or engine off, or ignored user, or was bot message).");
                }
            } else {
                // Message was processed as a command by the user (e.g. !music <prompt> or !tts status)
                // These original commands should not be spoken.
                logger.trace(`ChatVibes [${channelNameNoHash}]: Message from ${username} was processed as a command. No TTS for the original command text.`);
            }
        });

        // --- TTS Event Handlers ---
        const handleTwitchEventForTTS = async (channel, username, eventType, eventDetailsText) => {
            const channelNameNoHash = channel.substring(1);
            const ttsConfig = await getTtsState(channelNameNoHash);
            if (ttsConfig.engineEnabled && ttsConfig.speakEvents) {
                logger.info(`ChatVibes [${channelNameNoHash}]: TTS Event: ${eventType} by ${username}. Text: "${eventDetailsText}"`);
                await ttsQueue.enqueue(channelNameNoHash, {
                    text: eventDetailsText,
                    user: username,
                    type: 'event',
                });
            }
        };

        ircClientInstance.on('subscription', (channel, username, method, message, userstate) => {
            handleTwitchEventForTTS(channel, username, 'subscription', `${username} just subscribed! ${message || ''}`);
        });
        ircClientInstance.on('resub', (channel, username, months, message, userstate, methods) => {
            handleTwitchEventForTTS(channel, username, 'resub', `${username} resubscribed for ${months} months! ${message || ''}`);
        });
        ircClientInstance.on('cheer', (channel, userstate, message) => {
            handleTwitchEventForTTS(channel, userstate.username, 'cheer', `${userstate['display-name'] || userstate.username} cheered ${userstate.bits} bits! ${message}`);
        });
        ircClientInstance.on('raided', (channel, username, viewers, tags) => {
            handleTwitchEventForTTS(channel, username, 'raid', `${username} is raiding with ${viewers} viewers!`);
        });

        logger.info('ChatVibes: Connecting to Twitch IRC...');
        await connectIrcClient(); //
        ircClientInstance = getIrcClient();

        logger.info('ChatVibes: Initializing Web Server for OBS audio...');
        const { server: webServerInstance } = initializeWebServer(); //
        global.healthServer = webServerInstance;

        logger.info(`ChatVibes: Bot username: ${config.twitch.username}.`);
        logger.info(`ChatVibes: Initial channels to attempt join (may be updated by ChannelManager): ${ircClientInstance.getChannels().join(', ') || 'None (will join via ChannelManager)'}`);

    } catch (error) {
        logger.fatal({ err: error, stack: error.stack }, 'ChatVibes: Fatal error during initialization.');
        process.exit(1);
    }
}

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