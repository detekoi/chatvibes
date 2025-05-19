// src/components/commands/handlers/tts.js
import logger from '../../../lib/logger.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
// Import individual TTS command handlers
import status from '../tts/status.js';
import voices from '../tts/voices.js';
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
    pause: pauseResume,
    resume: pauseResume,
    clear,
    stop,
    mode: modeCmd,
    commands: listCommands,
    off: toggleEngine,
    disable: toggleEngine,
    on: toggleEngine,
    enable: toggleEngine,
    ignore: ignoreUser,
    ignored: listIgnored,
    events: toggleEvents,
    emotion: emotionCmd,
    say
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
    description: 'Controls the Text-to-Speech functionality. Use !tts help for subcommands.',
    usage: '!tts <subcommand> [options]',
    permission: 'everyone', // Base command is for everyone, subcommands have their own permissions
    execute: async (context) => {
        const { channel, user, args, ircClient } = context;
        const channelNameNoHash = channel.substring(1);

        if (args.length === 0) {
            enqueueMessage(channel, `@${user['display-name']}, Please specify a TTS subcommand. Try !tts help.`);
            return;
        }

        const subCommandName = args[0].toLowerCase();
        const subCommandHandler = ttsSubCommands[subCommandName];

        if (!subCommandHandler || typeof subCommandHandler.execute !== 'function') {
            // Check if it's an alias like 'on' for 'enable'
            const aliasMap = {
                'on': 'enable',
                'off': 'disable',
                'resume': 'pause', // if pauseResume handles both
                // Add other aliases as needed
            };
            const actualCommandName = aliasMap[subCommandName];
            const actualHandler = actualCommandName ? ttsSubCommands[actualCommandName] : null;

            if (!actualHandler || typeof actualHandler.execute !== 'function') {
                enqueueMessage(channel, `@<span class="math-inline">\{user\['display\-name'\]\}, Unknown TTS subcommand '</span>{subCommandName}'. Try !tts commands.`);
                return;
            }
             // Use the actual handler for permission check and execution
            if (!hasPermission(user, channelNameNoHash, actualHandler.permission || 'moderator')) {
                enqueueMessage(channel, `@${user['display-name']}, You don't have permission for '!tts ${subCommandName}'.`);
                return;
            }
            await actualHandler.execute({ ...context, args: args.slice(1) }); // Pass remaining args
            return;
        }

        // Permission check for the subcommand
        if (!hasPermission(user, channelNameNoHash, subCommandHandler.permission || 'moderator')) {
             enqueueMessage(channel, `@${user['display-name']}, You don't have permission for '!tts ${subCommandName}'.`);
            return;
        }

        // Execute the subcommand, passing the rest of the arguments
        await subCommandHandler.execute({ ...context, args: args.slice(1) });
    },
};