import logger from '../../../lib/logger.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import { enqueueMusicGeneration, getMusicQueueStatus, clearMusicQueue } from '../../music/musicQueue.js';
import { getMusicState, setMusicEnabled } from '../../music/musicState.js';
import { hasPermission } from '../commandProcessor.js';

// Import new subcommands
import musicModeCommand from '../music/mode.js';
import musicIgnoreCommand from '../music/ignoreUser.js';
import musicListIgnoredCommand from '../music/listIgnored.js'; // ++ ADD THIS IMPORT ++

const musicSubCommands = {
    mode: musicModeCommand,
    ignore: musicIgnoreCommand,
    ignored: musicListIgnoredCommand, // ++ ADD THIS MAPPING ++
    // Simple status, on, off, clear can be handled directly or be full command files
};


export default {
    name: 'music',
    description: 'Generate music using AI. Use !music <prompt> to generate 30 seconds of music.',
    usage: '!music <prompt> | !music status | !music clear | !music on/off | !music mode <all|mods> | !music ignore <add|del> <user> | !music ignored', // ++ ADDED IGNORED ++
    permission: 'everyone', 
    execute: async (context) => {
        const { channel, user, args, command: baseCommandName } = context; 
        const channelNameNoHash = channel.substring(1);
        const invokingUsername = user.username.toLowerCase();

        if (args.length === 0) {
            enqueueMessage(channel, `@${user['display-name']}, Use !music <prompt> to generate music, or try !music help for subcommands.`);
            return;
        }

        const subCommandArg = args[0].toLowerCase();
        const subCommandHandler = musicSubCommands[subCommandArg];

        if (subCommandHandler) {
            const requiredSubCommandPermission = subCommandHandler.permission || 'moderator'; 
            if (!hasPermission(requiredSubCommandPermission, user, channelNameNoHash)) {
                enqueueMessage(channel, `@${user['display-name']}, You don't have permission for '!music ${subCommandArg}'.`);
                return;
            }
            const subCommandContext = {
                ...context,
                command: subCommandArg, 
                args: args.slice(1),    
            };
            await subCommandHandler.execute(subCommandContext);
            return;
        }
        
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
                statusMsg += ` Ignored users: ${musicState.ignoredUsers.length}. Use !music ignored to list them.`; // Added hint
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
             // ++ UPDATED HELP MESSAGE ++
             enqueueMessage(channel, `@${user['display-name']}, Music commands: !music <prompt>, status, on/off, clear, mode <all|mods>, ignore <username | add/del user>, ignored. Default music role is 'everyone'.`);
            return;
        }

        const musicState = await getMusicState(channelNameNoHash);
        
        if (!musicState.enabled) {
            enqueueMessage(channel, `@${user['display-name']}, Music generation is currently disabled.`);
            return;
        }

        if (musicState.ignoredUsers && musicState.ignoredUsers.includes(invokingUsername)) {
            logger.debug(`[${channelNameNoHash}] User ${invokingUsername} is on the music ignore list. Dropping request.`);
            return;
        }

        const isAllowed = musicState.allowedRoles.some(role => 
            hasPermission(role, user, channelNameNoHash)
        );

        if (!isAllowed) {
            enqueueMessage(channel, `@${user['display-name']}, You don't have permission to generate music in the current mode.`);
            return;
        }

        const prompt = args.join(' '); 
        
        if (prompt.length < 10) {
            enqueueMessage(channel, `@${user['display-name']}, Please provide a more descriptive music prompt (at least 10 characters).`);
            return;
        }
        if (prompt.length > 200) {
            enqueueMessage(channel, `@${user['display-name']}, Music prompt is too long. Please keep it under 200 characters.`);
            return;
        }

        const result = await enqueueMusicGeneration(channelNameNoHash, {
            prompt,
            user: user.username, 
            negativePrompt: null,
            seed: null
        });

        if (!result.success) {
            switch (result.reason) {
                case 'disabled': 
                    enqueueMessage(channel, `@${user['display-name']}, Music generation is currently disabled.`);
                    break;
                case 'queue_full':
                    enqueueMessage(channel, `@${user['display-name']}, Music queue is full. Please try again later.`);
                    break;
                default:
                    enqueueMessage(channel, `@${user['display-name']}, Failed to queue music generation. Please try again.`);
            }
        }
    }
};