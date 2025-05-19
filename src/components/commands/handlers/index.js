// src/components/commands/tts/index.js
import ttsBaseCommand from './tts.js';
import status from './status.js';
import voices from './voices.js';
import pauseResume from './pauseResume.js';
import clear from './clear.js';
import stop from './stop.js';
import modeCmd from './mode.js'; // Renamed to avoid conflict with ttsState.mode
import listCommands from './listCommands.js';
import toggleEngine from './toggleEngine.js';
import ignoreUser from './ignoreUser.js';
import listIgnored from './listIgnored.js';
import toggleEvents from './toggleEvents.js';
import emotionCmd from './emotion.js';
import say from './say.js';

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