// src/components/commands/handlers/index.js
import logger from '../../../lib/logger.js';
import tts from './tts.js';
import music from '../music.js';


const commandHandlers = {
    tts,
    music,
    // someOtherBaseCommand, // Example
};

const loadedCommands = Object.keys(commandHandlers);
if (loadedCommands.length > 0) {
    logger.debug(`ChatVibes: Successfully loaded base command handlers for: ${loadedCommands.join(', ')}`);
} else {
     logger.warn('ChatVibes: No base command handlers were imported or mapped in handlers/index.js');
}

export default commandHandlers;