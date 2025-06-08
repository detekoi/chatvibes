// src/components/commands/music.js
import logger from '../../lib/logger.js';
import { enqueueMessage } from '../../lib/ircSender.js';
import { enqueueMusicGeneration, getMusicQueueStatus, clearMusicQueue } from '../music/musicQueue.js';
import { getMusicState, setMusicEnabled } from '../music/musicState.js';
import { hasPermission } from './commandProcessor.js';

// Import new subcommands
import musicModeCommand from './music/mode.js';
import musicIgnoreCommand from './music/ignoreUser.js';

const musicSubCommands = {
    mode: musicModeCommand,
    ignore: musicIgnoreCommand,
    // Simple status, on, off, clear can be handled directly or be full command files
    // For now, keeping them as direct logic in the main execute for simplicity,
    // but they could be refactored into their own files similar to `mode` and `ignore`.
};


export default {
    name: 'music',
    description: 'Generate music using AI. Use !music <prompt> to generate 30 seconds of music.',
    usage: '!music <prompt> | !music status | !music clear | !music on/off | !music mode <all|mods> | !music ignore <add|del> <user>',
    permission: 'everyone', // Base command, subcommands/actions have their own checks
    execute: async (context) => {
        const { channel, user, args, command: baseCommandName } = context; // baseCommandName is 'music'
        const channelNameNoHash = channel.substring(1);
        const invokingUsername = user.username.toLowerCase();

        if (args.length === 0) {
            enqueueMessage(channel, `@${user['display-name']}, Use !music <prompt> to generate music, or try !music help for subcommands.`);
            return;
        }

        const subCommandArg = args[0].toLowerCase();
        const subCommandHandler = musicSubCommands[subCommandArg];

        if (subCommandHandler) {
            // Check permission for the subcommand itself
            const requiredSubCommandPermission = subCommandHandler.permission || 'moderator'; // Default to moderator
            if (!hasPermission(requiredSubCommandPermission, user, channelNameNoHash)) {
                enqueueMessage(channel, `@${user['display-name']}, You don't have permission for '!music ${subCommandArg}'.`);
                return;
            }
            // Create context for the subcommand
            const subCommandContext = {
                ...context,
                command: subCommandArg, // The subcommand name itself (e.g., 'mode', 'ignore')
                args: args.slice(1),    // Remaining arguments for the subcommand
            };
            await subCommandHandler.execute(subCommandContext);
            return;
        }
        
        // Handle legacy/direct subcommands
        if (subCommandArg === 'status') {
            const musicState = await getMusicState(channelNameNoHash);
            const queueStatus = getMusicQueueStatus(channelNameNoHash);
            const currentMode = musicState.allowedRoles.includes('everyone') ? 'all (everyone)' : 'mods (moderators only)';
            
            let statusMsg = `Music generation is ${musicState.enabled ? 'ENABLED' : 'DISABLED'}. Mode: ${currentMode}.`;
            if (musicState.enabled) {
                statusMsg += ` Queue: ${queueStatus.queueLength} pending.`;
                if (queueStatus.isProcessing) {
                    statusMsg += ` Currently generating for @${queueStatus.currentUser}.`;
                }
            }
            if (musicState.ignoredUsers && musicState.ignoredUsers.length > 0 && hasPermission('moderator', user, channelNameNoHash)) {
                statusMsg += ` Ignored users: ${musicState.ignoredUsers.length}.`;
            }
            
            enqueueMessage(channel, `@${user['display-name']}, ${statusMsg}`);
            return;
        }

        if (subCommandArg === 'clear') {
            if (!hasPermission('moderator', user, channelNameNoHash)) {
                enqueueMessage(channel, `@${user['display-name']}, You need moderator permissions to clear the music queue.`);
                return;
            }
            const cleared = await clearMusicQueue(channelNameNoHash);
            enqueueMessage(channel, `@${user['display-name']}, Cleared ${cleared} music requests from the queue.`);
            return;
        }

        if (subCommandArg === 'on' || subCommandArg === 'off') {
            if (!hasPermission('moderator', user, channelNameNoHash)) {
                enqueueMessage(channel, `@${user['display-name']}, You need moderator permissions to toggle music generation.`);
                return;
            }
            const enabled = subCommandArg === 'on';
            const success = await setMusicEnabled(channelNameNoHash, enabled);
            if (success) {
                enqueueMessage(channel, `@${user['display-name']}, Music generation ${enabled ? 'enabled' : 'disabled'}.`);
            } else {
                enqueueMessage(channel, `@${user['display-name']}, Failed to update music settings.`);
            }
            return;
        }
        
        if (subCommandArg === 'help') {
             enqueueMessage(channel, `@${user['display-name']}, Music commands: !music <prompt>, status, on/off, clear, mode <all|mods>, ignore <add|del> <user>. Default music role is 'everyone'.`);
            return;
        }


        // --- Handle music generation request (prompt provided) ---
        const musicState = await getMusicState(channelNameNoHash);
        
        if (!musicState.enabled) {
            enqueueMessage(channel, `@${user['display-name']}, Music generation is currently disabled.`);
            return;
        }

        // Check ignored users FIRST
        if (musicState.ignoredUsers && musicState.ignoredUsers.includes(invokingUsername)) {
            logger.debug(`[${channelNameNoHash}] User ${invokingUsername} is on the music ignore list. Dropping request.`);
            // Optionally send a silent confirmation or no message. For now, no message.
            return;
        }

        // Check permissions based on allowedRoles
        const isAllowed = musicState.allowedRoles.some(role => 
            hasPermission(role, user, channelNameNoHash)
        );

        if (!isAllowed) {
            enqueueMessage(channel, `@${user['display-name']}, You don't have permission to generate music in the current mode.`);
            return;
        }

        const prompt = args.join(' '); // The full original arguments if not a subcommand

        const result = await enqueueMusicGeneration(channelNameNoHash, {
            prompt,
            user: user.username, // Keep original case for display/logging if needed by queue
            negativePrompt: null,
            seed: null
        });

        if (!result.success) {
            switch (result.reason) {
                case 'disabled': // Should be caught earlier, but as a fallback
                    enqueueMessage(channel, `@${user['display-name']}, Music generation is currently disabled.`);
                    break;
                case 'queue_full':
                    enqueueMessage(channel, `@${user['display-name']}, Music queue is full. Please try again later.`);
                    break;
                default:
                    enqueueMessage(channel, `@${user['display-name']}, Failed to queue music generation. Please try again.`);
            }
        }
        // Success for enqueueing is handled by the queue processor (sends "generating..." message)
    }
};