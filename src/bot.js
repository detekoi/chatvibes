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
        const packageName = /*config.name ||*/ 'chatvibes-tts';
        const packageVersion = /*config.version ||*/ '1.0.0';
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

        // Load Twitch Channels for tmi.js clientOptions.channels
        // This list will be de-duplicated before being passed to createIrcClient.
        if (config.app.nodeEnv === 'development') {
            const devChannelsRaw = process.env.TWITCH_CHANNELS || "";
            const devChannels = devChannelsRaw.split(',').map(ch => ch.trim().toLowerCase()).filter(ch => ch);
            if (devChannels.length === 0) {
                logger.fatal('ChatVibes (DEV MODE): TWITCH_CHANNELS environment variable is not set or results in an empty list. Please set it.');
                process.exit(1);
            }
            config.twitch.channels = [...new Set(devChannels)]; // Ensure unique for TMI client options
            logger.info(`ChatVibes (DEV MODE): Unique channels prepared for TMI client options: [${config.twitch.channels.join(', ')}]`);
        } else { // Production or other environments
            logger.info('ChatVibes: Loading active channels from Firestore for TMI client options...');
            try {
                const managedChannels = await getActiveManagedChannels(); // Returns array of lowercase channel name strings
                config.twitch.channels = [...new Set(managedChannels || [])]; // Ensure unique
                logger.info(`ChatVibes: Unique channels from Firestore for TMI client options: [${config.twitch.channels.join(', ')}]`);

                if (config.twitch.channels.length === 0) {
                    logger.warn('ChatVibes: No active channels from Firestore. Checking TWITCH_CHANNELS env var as fallback.');
                    const fallbackChannelsRaw = process.env.TWITCH_CHANNELS || "";
                    const fallbackChannels = fallbackChannelsRaw.split(',').map(ch => ch.trim().toLowerCase()).filter(ch => ch);
                    if (fallbackChannels.length > 0) {
                         config.twitch.channels = [...new Set(fallbackChannels)];
                         logger.info(`ChatVibes (Prod Fallback): Loaded ${config.twitch.channels.length} unique channels from TWITCH_CHANNELS env var: [${config.twitch.channels.join(', ')}]`);
                    } else {
                        logger.warn('ChatVibes: No channels configured from Firestore or TWITCH_CHANNELS env var for initial join.');
                    }
                }
            } catch (error) {
                logger.error({ err: error }, 'ChatVibes: Error loading channels from Firestore. Bot might not join channels initially.');
                config.twitch.channels = []; // Default to empty if error
            }
        }
        if (!config.twitch.channels) config.twitch.channels = []; // Ensure it's an array

        logger.info('ChatVibes: Initializing Twitch Helix Client...');
        await initializeHelixClient(); // Pass twitchConfig if needed by your helix init

        logger.info('ChatVibes: Initializing Command Processor for commands...');
        initializeCommandProcessor();

        logger.info('ChatVibes: Initializing IRC Sender queue...');
        initializeIrcSender();

        logger.info('ChatVibes: Creating Twitch IRC Client instance...');
        // createIrcClient in ircClient.js already de-duplicates the channels list passed to it.
        ircClientInstance = await createIrcClient(config.twitch);

        // --- Setup IRC Event Listeners ---
        ircClientInstance.on('connected', async (address, port) => {
            logger.info(`ChatVibes: Successfully connected to Twitch IRC: ${address}:${port}`);
            if (config.app.nodeEnv !== 'development') {
                // Production: Firestore-driven dynamic joins/parts
                logger.info('ChatVibes: Setting up Firestore channel listener and performing initial sync.');
                if (!channelChangeListener) {
                    channelChangeListener = listenForChannelChanges(ircClientInstance);
                }
                try {
                    const syncResult = await syncManagedChannelsWithIrc(ircClientInstance);
                    logger.info(`ChatVibes: Initial channel sync - Joined: ${syncResult.joined.length}, Parted: ${syncResult.parted.length}`);
                    const activeChannels = await getActiveManagedChannels();
                    // Update the in-memory config.twitch.channels to reflect actual state for other parts of the app if needed.
                    config.twitch.channels = [...new Set(activeChannels.map(ch => ch.toLowerCase()))];
                    logger.info(`ChatVibes: In-memory channel list updated with ${config.twitch.channels.length} active channels post-sync.`);
                } catch (error) {
                    logger.error({ err: error }, 'ChatVibes: Error during initial channel sync from Firestore.');
                }
                // Scheduled sync (if still desired, often the listener is enough)
                // setInterval(async () => { ... }); // Keep or remove based on preference
            } else { // Development mode
                logger.info('ChatVibes (DEV MODE): Relying on TMI.js auto-join for channels specified in client options. Explicit join loop in on(connected) removed.');
                // TMI.js should have automatically joined channels provided in `createIrcClient`'s `clientOptions.channels`.
                // Log channels TMI is actually in after a brief moment for TMI to process joins.
                setTimeout(() => {
                    const currentTmiChannels = ircClientInstance.getChannels().map(ch => ch.replace(/^#/, '').toLowerCase());
                    logger.info(`ChatVibes (DEV MODE): Channels TMI reports being in: [${currentTmiChannels.join(', ')}]`);
                    // You can compare currentTmiChannels with config.twitch.channels (which was used for clientOptions)
                    // to see if all intended dev channels were joined by TMI.
                }, 3000); // 3-second delay
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
            logger.debug({
                logKey: "RAW_MESSAGE_EVENT_RECEIVED_BOTJS", // Unique key
                channel_raw: channel,
                message_raw: message,
                tags_raw: tags, // Log the whole tags object to inspect username, badges etc.
                self_flag: self,
                timestamp_ms: Date.now()
            }, `RAW_MESSAGE_EVENT_RECEIVED_BOTJS from user: ${tags['display-name'] || tags.username}, self: ${self}, msg: "${message.substring(0,50)}..."`);

            if (self) {
                logger.debug({ // Changed from TRACE to DEBUG for better visibility
                    logKey: "BOTJS_SELF_MESSAGE_SKIPPED_PRIMARY_CHECK",
                    message_text: message,
                    tags_username: tags.username,
                    self_flag_is_true: true
                },`BOTJS_SELF_MESSAGE_SKIPPED_PRIMARY_CHECK for user: ${tags.username}, msg: "${message.substring(0,30)}..."`);
                return;
            }

            const channelNameNoHash = channel.substring(1).toLowerCase();
            const username = tags.username?.toLowerCase(); // User sending the message
            const configuredBotUsername = config.twitch.username?.toLowerCase(); // Bot's configured username

            // 1. Process Bot Commands.
            const processedCommandName = await processCommand(channelNameNoHash, tags, message);

            if (processedCommandName) { // A command was processed
                logger.info({ logKey: "BOTJS_COMMAND_PROCESSING", user: username, command: processedCommandName, args_text: message }, `BOTJS_COMMAND_PROCESSING: User: ${username}, Command: ${processedCommandName}`);

                if (processedCommandName === 'music') {
                    const ttsConfig = await getTtsState(channelNameNoHash);
                    const isIgnoredUser = ttsConfig.ignoredUsers && ttsConfig.ignoredUsers.includes(username);
                    if (ttsConfig.engineEnabled && !isIgnoredUser && ttsConfig.mode === 'all') {
                        logger.info({logKey: "BOTJS_MUSIC_COMMAND_TTS_ENQUEUE", user: username, text: message.substring(0,50)}, `BOTJS_MUSIC_COMMAND_TTS_ENQUEUE: User: ${username}, Text: "${message.substring(0,50)}..."`);
                        await ttsQueue.enqueue(channelNameNoHash, {
                            text: message, user: username, type: 'command_music',
                        });
                    } else {
                         logger.debug({
                            logKey: "BOTJS_MUSIC_COMMAND_TTS_SKIPPED",
                            reason: "Music command TTS conditions not met",
                            channel: channelNameNoHash, user: username, command: processedCommandName,
                            engineEnabled: ttsConfig.engineEnabled, mode: ttsConfig.mode, isIgnoredUser
                        }, "BOTJS_MUSIC_COMMAND_TTS_SKIPPED");
                    }
                }
                // For other commands, their own handlers decide if TTS is needed (e.g., !tts say)

            } else { // Not a command (processedCommandName is null)
                // Check if this non-command message is from the bot itself
                if (username && configuredBotUsername && username === configuredBotUsername) {
                    logger.debug({
                        logKey: "BOTJS_SELF_MESSAGE_SKIPPED_SECONDARY_CHECK",
                        message_text: message,
                        tags_username: tags.username, // original case from tags
                        checked_username_lowercase: username,
                        configured_bot_username_lowercase: configuredBotUsername,
                        is_match: (username === configuredBotUsername)
                    },`BOTJS_SELF_MESSAGE_SKIPPED_SECONDARY_CHECK for user: ${username}, msg: "${message.substring(0,30)}..."`);
                    return;
                }

                // TTS for regular chat messages if mode is 'all'
                const ttsConfig = await getTtsState(channelNameNoHash);
                const isIgnoredUser = ttsConfig.ignoredUsers && ttsConfig.ignoredUsers.includes(username);

                if (ttsConfig.engineEnabled && ttsConfig.mode === 'all' && !isIgnoredUser) {
                    logger.info({logKey: "BOTJS_GENERAL_CHAT_TTS_ENQUEUE", user: username, text: message.substring(0,30)}, `BOTJS_GENERAL_CHAT_TTS_ENQUEUE: User: ${username}, Text: "${message.substring(0,30)}..."`);
                    await ttsQueue.enqueue(channelNameNoHash, {
                        text: message,
                        user: username,
                        type: 'chat',
                    });
                } else {
                    logger.debug({
                        logKey: "BOTJS_GENERAL_CHAT_TTS_SKIPPED",
                        reason: "General chat TTS conditions not met",
                        channel: channelNameNoHash, user: username,
                        engineEnabled: ttsConfig.engineEnabled, mode: ttsConfig.mode, isIgnoredUser,
                        isBotMessageFalseCondition: (username && configuredBotUsername && username === configuredBotUsername) // should be false here
                    }, `BOTJS_GENERAL_CHAT_TTS_SKIPPED for user: ${username}, msg: "${message.substring(0,30)}..."`);
                }
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