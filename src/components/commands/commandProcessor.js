import logger from '../../lib/logger.js';
import config from '../../config/index.js';
// Import command handlers (assuming handlers/index.js exports an object/Map)
import commandHandlers from './handlers/index.js';
// We might need access to the IRC client to send command responses
import { getIrcClient } from '../twitch/ircClient.js';


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
 * @returns {{command: string, args: string[]} | null} Parsed command and args, or null if not a command.
 */
function parseCommand(message) {
    if (!message.startsWith(COMMAND_PREFIX)) {
        return null;
    }

    const args = message.slice(COMMAND_PREFIX.length).trim().split(/ +/g);
    const command = args.shift()?.toLowerCase(); // Get command name (lowercase)

    if (!command) {
        return null; // Just the prefix was typed
    }

    return { command, args };
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
        const isModByBadge = tags.badges?.moderator === '1';
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
 * @returns {Promise<boolean>} True if a command was successfully found and executed (or attempted), false otherwise.
 */
async function processMessage(channelNameNoHash, tags, message) {
    logger.debug({ channelName: channelNameNoHash, user: tags.username, message }, 'processMessage called');

    const parsed = parseCommand(message);

    if (!parsed) {
        logger.debug('Message not a command or just prefix');
        return false;
    }

    const { command, args } = parsed;
    logger.debug({ command, args }, 'Parsed command');

    const handler = commandHandlers[command];
    logger.debug({ command, handlerExists: !!handler }, 'Command handler lookup result');

    if (!handler || typeof handler.execute !== 'function') {
        logger.debug(`Command prefix used, but no handler found for: ${command}`);
        return false;
    }

    // --- Permission Check for the base command ---
    logger.debug(`Checking permission for base command !${command}`);
    // Use the exported hasPermission, passing handler.permission
    const permitted = hasPermission(handler.permission || 'everyone', tags, channelNameNoHash);
    logger.debug({ permitted }, 'Base command permission check result');

    if (!permitted) {
        logger.warn(`User ${tags.username} lacks permission for base command !${command} in #${channelNameNoHash}`);
        // Optional: Send a whisper or message indicating lack of permission? Be careful about spam.
        // e.g., enqueueMessage(`#${channelNameNoHash}`, `@${tags['display-name']}, You don't have permission for !${command}.`);
        return false; // Command found but user lacks permission for base command
    }

    // --- Execute Command ---
    logger.info(`Executing command !${command} for user ${tags.username} in #${channelNameNoHash}`);
    try {
        const context = {
            channel: `#${channelNameNoHash}`,
            user: tags,
            args: args,
            message: message,
            ircClient: getIrcClient(),
            logger: logger
        };
        await handler.execute(context);
        return true;

    } catch (error) {
        logger.error({ err: error, command: command, user: tags.username, channel: channelNameNoHash },
            `Error executing command !${command}`);
        try {
            const ircClient = getIrcClient();
            // Do not await here, just enqueue
            // enqueueMessage(`#${channelNameNoHash}`, `Oops! Something went wrong trying to run !${command}.`);
            await ircClient.say(`#${channelNameNoHash}`, `Oops! Something went wrong trying to run !${command}.`);
        } catch (sayError) {
             logger.error({ err: sayError }, 'Failed to send command execution error message to chat.');
        }
        return true; // Command was attempted, even though it failed
    }
}

// Export the necessary functions
export { initializeCommandProcessor, processMessage, hasPermission };