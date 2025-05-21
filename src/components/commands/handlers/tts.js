// src/components/commands/handlers/tts.js
import logger from '../../../lib/logger.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
// Import individual TTS command handlers
import status from '../tts/status.js';
import defaultVoice from '../tts/defaultVoice.js';
import defaultPitch from '../tts/defaultPitch.js';
import defaultSpeed from '../tts/defaultSpeed.js';
import defaultEmotion from '../tts/defaultEmotion.js';
import defaultLanguage from '../tts/defaultLanguage.js';
import language from '../tts/language.js';
import languageslist from '../tts/languagesList.js';
import voices from '../tts/voices.js';
import voice from '../tts/voice.js';
import pitch from '../tts/pitch.js';
import speed from '../tts/speed.js';
import pauseResume from '../tts/pauseResume.js';
import clear from '../tts/clear.js';
import stop from '../tts/stop.js';
import modeCmd from '../tts/mode.js';
import listCommands from '../tts/listCommands.js';
import toggleEngine from '../tts/toggleEngine.js';
import ignoreUser from '../tts/ignoreUser.js';
import listIgnored from '../tts/listIgnored.js';
import toggleEvents from '../tts/toggleEvents.js';
import emotionCmd from '../tts/emotion.js';
import say from '../tts/say.js';
import { hasPermission } from '../commandProcessor.js'; // Import the centralized function
// Create subcommands object
const ttsSubCommands = {
    status,
    voices,
    defaultvoice: defaultVoice,
    defaultpitch: defaultPitch,
    defaultspeed: defaultSpeed,
    defaultemotion: defaultEmotion,
    defaultlanguage: defaultLanguage,
    language,
    languageslist,
    voice,
    pitch,
    speed,
    emotion: emotionCmd,
    pause: pauseResume,
    resume: pauseResume,
    clear,
    stop,
    mode: modeCmd,
    commands: listCommands,
    help: listCommands,
    off: toggleEngine,
    disable: toggleEngine,
    on: toggleEngine,
    enable: toggleEngine,
    ignore: ignoreUser,
    ignored: listIgnored,
    events: toggleEvents,
    say,
};

export default {
    name: 'tts',
    description: 'Controls the Text-to-Speech functionality. Use !tts commands for a link to all subcommands.',
    usage: '!tts <subcommand> [options]',
    permission: 'everyone', // Base command is for everyone, subcommands have their own permissions
    execute: async (context) => {
        const { channel, user, args, ircClient } = context;
        const channelNameNoHash = channel.substring(1).toLowerCase(); // Ensure lowercase

        if (args.length === 0) {
            // Direct call to listCommands handler if no args
            const helpHandler = ttsSubCommands['commands'];
            if (helpHandler && typeof helpHandler.execute === 'function') {
                // Pass context with command: 'commands' and args: []
                const helpContext = { ...context, command: 'commands', args: [] };
                await helpHandler.execute(helpContext);
            } else {
                enqueueMessage(channel, `@${user['display-name']}, For command info, see: https://detekoi.github.io/chatvibesdocs.html#commands`);
            }
            return;
        }

        const subCommandNameFromArgs = args[0].toLowerCase(); // e.g., "on", "off", "status"
        let actualSubCommandHandler = ttsSubCommands[subCommandNameFromArgs];
        let effectiveSubCommandName = subCommandNameFromArgs;

        if (!actualSubCommandHandler || typeof actualSubCommandHandler.execute !== 'function') {
            enqueueMessage(channel, `@${user['display-name']}, Unknown TTS subcommand '${subCommandNameFromArgs}'. For commands, see: https://detekoi.github.io/chatvibesdocs.html#commands`);
            logger.debug(`Unknown TTS subcommand: ${subCommandNameFromArgs} for user ${user.username} in ${channel}`);
            return;
        }

        // Permission check for the specific subcommand using the imported hasPermission
        // The 'user' object is context.user (tmi.js tags)
        // channelNameNoHash is already without '#' and now ensured lowercase
        // actualSubCommandHandler.permission is the required permission string
        const requiredSubCommandPermission = actualSubCommandHandler.permission || 'moderator'; // Default to moderator if not specified
        if (!hasPermission(requiredSubCommandPermission, user, channelNameNoHash)) {
            enqueueMessage(channel, `@${user['display-name']}, You don't have permission for '!tts ${effectiveSubCommandName}'.`);
            logger.warn(`Permission denied for user ${user.username} on command !tts ${effectiveSubCommandName} in ${channel}. Required: ${requiredSubCommandPermission}`);
            return;
        }

        // Create a new context for the subcommand, passing the *original* subcommand name
        // so that handlers like toggleEngine can know if it was 'on' or 'off'
        const subCommandContext = {
            ...context,
            command: effectiveSubCommandName, // This is what toggleEngine.js will see as context.command
            args: args.slice(1), // Pass remaining args to the subcommand handler
        };

        logger.info(`Executing TTS subcommand '!tts ${effectiveSubCommandName}' for user ${user.username} in ${channel}`);
        await actualSubCommandHandler.execute(subCommandContext);
    },
};