// src/components/commands/handlers/tts.js
import logger from '../../../lib/logger.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
// Import individual TTS command handlers
import status from '../tts/status.js';
import defaultVoice from '../tts/defaultVoice.js';
import voices from '../tts/voices.js';
import voice from '../tts/voice.js';
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

// Create subcommands object
const ttsSubCommands = {
    status,
    voices,
    defaultvoice: defaultVoice,
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
    emotion: emotionCmd,
    say,
    voice,
};

// Helper to check permissions (can be centralized)
function hasPermission(userTags, channelName, requiredPermission) {
    if (requiredPermission === 'everyone') return true;
    const isBroadcaster = userTags.badges?.broadcaster === '1' || userTags.username === channelName;
    if (isBroadcaster) return true; // Broadcaster can do anything
    if (requiredPermission === 'moderator') {
        return userTags.mod === '1';
    }
    // Add other permission levels if needed
    return false;
}

export default {
    name: 'tts',
    description: 'Controls the Text-to-Speech functionality. Use !tts commands for a link to all subcommands.',
    usage: '!tts <subcommand> [options]',
    permission: 'everyone', // Base command is for everyone, subcommands have their own permissions
    execute: async (context) => {
        const { channel, user, args, ircClient } = context;
        const channelNameNoHash = channel.substring(1);

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

        // Permission check for the specific subcommand
        if (!hasPermission(user, channelNameNoHash, actualSubCommandHandler.permission || 'moderator')) {
            enqueueMessage(channel, `@${user['display-name']}, You don't have permission for '!tts ${effectiveSubCommandName}'.`);
            logger.warn(`Permission denied for user ${user.username} on command !tts ${effectiveSubCommandName} in ${channel}. Required: ${actualSubCommandHandler.permission || 'moderator'}`);
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