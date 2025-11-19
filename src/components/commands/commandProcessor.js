// src/components/commands/commandProcessor.js
import logger from '../../lib/logger.js';
// Import command handlers (assuming handlers/index.js exports an object/Map)
import commandHandlers from './handlers/index.js';
import { getTtsState } from '../tts/ttsState.js';
import { enqueueMessage } from '../../lib/chatSender.js';


const COMMAND_PREFIX = '!'; // Define the prefix for commands

/**
 * Initializes the Command Processor.
 * Currently just logs, but could pre-load/validate handlers in the future.
 */
function initializeCommandProcessor() {
    logger.info('Initializing Command Processor...');
    // Log registered commands
    const registeredCommands = Object.keys(commandHandlers);
    if (registeredCommands.length > 0) {
        logger.info(`Registered commands: ${registeredCommands.join(', ')}`);
    } else {
        logger.warn('No command handlers found or loaded.');
    }
}

/**
 * Parses a message to extract command name and arguments.
 * @param {string} message - The raw message content.
 * @returns {{commandName: string, args: string[]} | null} Parsed command name and args, or null if not a command.
 */
function parseCommand(message) {
    if (!message.startsWith(COMMAND_PREFIX)) {
        return null;
    }

    const args = message.slice(COMMAND_PREFIX.length).trim().split(/ +/g);
    const commandName = args.shift()?.toLowerCase(); // Get command name (lowercase)

    if (!commandName) {
        return null; // Just the prefix was typed
    }

    return { commandName, args };
}

/**
 * Checks if the user has the required permission level for a command.
 * @param {string} requiredPermission - The permission level string (e.g., 'everyone', 'moderator', 'broadcaster').
 * @param {object} tags - The user's message tags from tmi.js.
 * @param {string} channelName - The channel the command was issued in (without '#').
 * @returns {boolean} True if the user has permission, false otherwise.
 */
function hasPermission(requiredPermission, tags, channelName) {
    const permLevel = requiredPermission || 'everyone'; // Default to everyone if undefined

    if (permLevel === 'everyone') {
        return true;
    }

    const username = tags.username?.toLowerCase(); // Ensure username is lowercase for comparison
    const cleanChannelName = channelName.toLowerCase(); // Ensure channelName is lowercase

    const isBroadcaster = tags.badges?.broadcaster === '1' || username === cleanChannelName;
    if (isBroadcaster) { // Broadcaster can generally do anything if perm level is mod or broadcaster
        return true;
    }

    // Moderator check specifically for 'moderator' permission level
    if (permLevel === 'moderator') {
        const isModByTag = tags.mod === true || tags.mod === '1';
        const isModByBadge = tags.badges?.moderator === '1'; // Corrected: was user.badges, now tags.badges
        // Broadcaster is already covered above, so mods don't need explicit isBroadcaster check here
        return isModByTag || isModByBadge;
    }

    // If a future permLevel is 'broadcaster' and only broadcaster should access (not mods)
    if (permLevel === 'broadcaster') {
        return isBroadcaster;
    }

    return false;
}

/**
 * Processes an incoming chat message to check for and execute commands.
 * @param {string} channelNameNoHash - Channel name (without '#').
 * @param {object} tags - tmi.js message tags.
 * @param {string} message - Raw message content.
 * @returns {Promise<string|null>} The name of the command if processed, null otherwise.
 */
async function processMessage(channelNameNoHash, tags, message) {
    logger.debug({ channelName: channelNameNoHash, user: tags.username, message }, 'processMessage called');

    const parsed = parseCommand(message);

    if (!parsed) {
        logger.debug('Message not a command or just prefix');
        return null; // Return null if not a command
    }

    const { commandName, args } = parsed;
    logger.debug({ command: commandName, args }, 'Parsed command');

    const handler = commandHandlers[commandName];
    logger.debug({ command: commandName, handlerExists: !!handler }, 'Command handler lookup result');

    if (!handler || typeof handler.execute !== 'function') {
        logger.debug(`Command prefix used, but no handler found for: ${commandName}`);
        return null; // Return null if no handler
    }

    // --- Permission Check for the base command ---
    logger.debug(`Checking permission for base command !${commandName}`);
    const permitted = hasPermission(handler.permission || 'everyone', tags, channelNameNoHash);
    logger.debug({ permitted }, 'Base command permission check result');

    if (!permitted) {
        logger.warn(`User ${tags.username} lacks permission for base command !${commandName} in #${channelNameNoHash}`);
        return null; // Return null if user lacks permission for base command
    }

    // --- Check if bot should respond in chat (Channel-level setting) ---
    let canReply = false; // Default: bot does not respond in chat
    try {
        const ttsState = await getTtsState(channelNameNoHash);
        canReply = ttsState.botRespondsInChat === true;
    } catch (error) {
        logger.error({ err: error, channel: channelNameNoHash }, 'Error fetching channel settings, defaulting to no chat responses');
    }

    logger.info(`Command !${commandName} for user ${tags.username} in #${channelNameNoHash} - Bot responds in chat: ${canReply}`);

    // --- Execute Command ---
    try {
        const context = {
            channel: `#${channelNameNoHash}`,
            user: tags,
            args: args,
            message: message, // Pass original message
            command: commandName, // Pass the executed command name for context within subcommand handlers
            replyToId: tags?.id || tags?.['message-id'] || null, // Add reply ID from message tags
            canReply: canReply,
            logger: logger,
            // Helper to send a message (conditionally based on mode)
            say: async (text) => {
                if (canReply) {
                    await enqueueMessage(`#${channelNameNoHash}`, text);
                } else {
                    logger.debug({ channel: channelNameNoHash, text }, 'Suppressed chat reply due to anonymous mode');
                }
            },
            // Helper to reply to the specific message (conditionally)
            reply: async (text) => {
                if (canReply) {
                    await enqueueMessage(`#${channelNameNoHash}`, text, { replyToId: tags?.id || tags?.['message-id'] });
                } else {
                    logger.debug({ channel: channelNameNoHash, text }, 'Suppressed chat reply due to anonymous mode');
                }
            }
        };

        // Backward compatibility for handlers that might try to use ircClient directly
        // We provide a mock ircClient that uses our say/reply helpers
        context.ircClient = {
            say: async (chan, text) => context.say(text),
            // raw: ... (not supported via Helix easily, ignore for now)
        };

        await handler.execute(context);
        return commandName; // Return the processed command name

    } catch (error) {
        logger.error({ err: error, command: commandName, user: tags.username, channel: channelNameNoHash },
            `Error executing command !${commandName}`);

        // Only send error message to chat if not in effective anonymous mode
        if (canReply) {
            try {
                await enqueueMessage(`#${channelNameNoHash}`, `Oops! Something went wrong trying to run !${commandName}.`);
            } catch (sayError) {
                logger.error({ err: sayError }, 'Failed to send command execution error message to chat.');
            }
        } else {
            logger.warn(`Cannot send error message to chat: bot is in effective anonymous mode.`);
        }
        return commandName; // Command was attempted, return command name
    }
}

// Export the necessary functions
export { initializeCommandProcessor, processMessage, hasPermission };