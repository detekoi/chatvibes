// src/components/commands/handlers/index.js
import logger from '../../../lib/logger.js';
import ttsBaseCommand from './tts.js'; // This handles all "!tts <subcommand>" variations

// If you had other distinct base commands, you'd import their handlers too
// import someOtherBaseCommand from './someOtherCommand.js';

const commandHandlers = {
    tts: ttsBaseCommand,
    // someOtherCommand: someOtherBaseCommand, // Example
};

const loadedCommands = Object.keys(commandHandlers);
if (loadedCommands.length > 0) {
    logger.debug(`ChatVibes: Successfully loaded base command handlers for: ${loadedCommands.join(', ')}`);
} else {
     logger.warn('ChatVibes: No base command handlers were imported or mapped in handlers/index.js');
}

export default commandHandlers;