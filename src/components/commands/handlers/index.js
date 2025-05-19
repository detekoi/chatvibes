// src/components/commands/handlers/index.js
import logger from '../../../lib/logger.js';
import ttsBaseCommand from './tts.js';
import status from '../tts/status.js';
import voices from '../tts/voices.js';
import pauseResume from '../tts/pauseResume.js';
import clear from '../tts/clear.js';
import stop from '../tts/stop.js';
import modeCmd from '../tts/mode.js'; // Renamed to avoid conflict with ttsState.mode
import listCommands from '../tts/listCommands.js';
import toggleEngine from '../tts/toggleEngine.js';
import ignoreUser from '../tts/ignoreUser.js';
import listIgnored from '../tts/listIgnored.js';
import toggleEvents from '../tts/toggleEvents.js';
import emotionCmd from '../tts/emotion.js';
import say from '../tts/say.js';

const commandHandlers = {
    tts: ttsBaseCommand,
    status,
    voices,
    pause: pauseResume, // Assuming pauseResume handles both
    resume: pauseResume,
    clear,
    stop,
    mode: modeCmd,
    commands: listCommands,
    off: toggleEngine, // Assuming toggleEngine handles on/off/disable/enable
    disable: toggleEngine,
    on: toggleEngine,
    enable: toggleEngine,
    ignore: ignoreUser,
    ignored: listIgnored,
    events: toggleEvents,
    emotion: emotionCmd, 
    say: say,
};

const loadedCommands = Object.keys(commandHandlers);
if (loadedCommands.length > 0) {
    logger.debug(`ChatVibes: Successfully loaded base command handlers for: ${loadedCommands.join(', ')}`);
} else {
     logger.warn('ChatVibes: No base command handlers were imported or mapped in handlers/index.js');
}

export default commandHandlers;