// src/components/commands/handlers/music.js
import logger from '../../../lib/logger.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import { enqueueMusicGeneration, getMusicQueueStatus, clearMusicQueue } from '../../music/musicQueue.js';
import { getMusicState, setMusicEnabled } from '../../music/musicState.js';
import { hasPermission } from '../commandProcessor.js';

// Import subcommands
import musicModeCommand from '../music/mode.js';
import musicIgnoreCommand from '../music/ignoreUser.js';
import musicListIgnoredCommand from '../music/listIgnored.js';
import musicBitsCommand from '../music/bits.js';

const musicSubCommands = {
    mode: musicModeCommand,
    ignore: musicIgnoreCommand,
    ignored: musicListIgnoredCommand,
    bits: musicBitsCommand,
};


export default {
    name: 'music',
    description: 'Generate music using AI. Use !music <prompt> to generate music.',
    usage: '!music <prompt> | !music status | !music clear | !music on/off | !music mode <all|mods> | !music ignore <add|del> <user> | !music ignored | !music bits <on|off|min>',
    permission: 'everyone', 
    execute: async (context) => {
        const { channel, user, args, replyToId } = context; 
        const channelNameNoHash = channel.substring(1);
        const invokingUsername = user.username.toLowerCase();

        if (args.length === 0) {
            enqueueMessage(channel, `Use !music <prompt> to generate music, or try !music help for subcommands.`, { replyToId });
            return;
        }

        const subCommandArg = args[0].toLowerCase();
        const subCommandHandler = musicSubCommands[subCommandArg];

        if (subCommandHandler) {
            const requiredSubCommandPermission = subCommandHandler.permission || 'moderator'; 
            if (!hasPermission(requiredSubCommandPermission, user, channelNameNoHash)) {
                enqueueMessage(channel, `You don't have permission for '!music ${subCommandArg}'.`, { replyToId });
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
                statusMsg += ` Bits Mode: ${musicState.bitsModeEnabled ? `ON (min ${musicState.bitsMinimumAmount})` : 'OFF'}.`;
                statusMsg += ` Queue: ${queueStatus.queueLength} pending.`;
                if (queueStatus.isProcessing) {
                    statusMsg += ` Currently generating for @${queueStatus.currentUser}.`;
                }
            }
            if (musicState.ignoredUsers && musicState.ignoredUsers.length > 0 && hasPermission('moderator', user, channelNameNoHash)) {
                statusMsg += ` Ignored users: ${musicState.ignoredUsers.length}. Use !music ignored to list them.`;
            }
            
            enqueueMessage(channel, statusMsg, { replyToId });
            return;
        }

        if (subCommandArg === 'clear') {
            if (!hasPermission('moderator', user, channelNameNoHash)) {
                enqueueMessage(channel, `You need moderator permissions to clear the music queue.`, { replyToId });
                return;
            }
            const cleared = await clearMusicQueue(channelNameNoHash);
            enqueueMessage(channel, `Cleared ${cleared} music requests from the queue.`, { replyToId });
            return;
        }

        if (subCommandArg === 'on' || subCommandArg === 'off') {
            if (!hasPermission('moderator', user, channelNameNoHash)) {
                enqueueMessage(channel, `You need moderator permissions to toggle music generation.`, { replyToId });
                return;
            }
            const enabled = subCommandArg === 'on';
            const success = await setMusicEnabled(channelNameNoHash, enabled);
            if (success) {
                enqueueMessage(channel, `Music generation ${enabled ? 'enabled' : 'disabled'}.`, { replyToId });
            } else {
                enqueueMessage(channel, `Failed to update music settings.`, { replyToId });
            }
            return;
        }
        
        if (subCommandArg === 'help') {
             enqueueMessage(channel, `Music commands: !music <prompt>, status, on/off, clear, mode <all|mods>, ignore <add|del user>, ignored, bits <on|off|min>.`, { replyToId });
            return;
        }

        const musicState = await getMusicState(channelNameNoHash);
        
        if (!musicState.enabled) {
            enqueueMessage(channel, `Music generation is currently disabled.`, { replyToId });
            return;
        }
        
        if (musicState.bitsModeEnabled) {
            const bits = parseInt(user.bits, 10) || 0;
            const minimumBits = musicState.bitsMinimumAmount || 1;
            if (bits < minimumBits) {
                enqueueMessage(channel, `music generation requires a cheer of at least ${minimumBits} bits with your prompt.`, { replyToId });
                return;
            }
        }

        if (musicState.ignoredUsers && musicState.ignoredUsers.includes(invokingUsername)) {
            logger.debug(`[${channelNameNoHash}] User ${invokingUsername} is on the music ignore list. Dropping request.`);
            return;
        }
        
        const isAllowed = musicState.allowedRoles.some(role => 
            hasPermission(role, user, channelNameNoHash)
        );

        if (!isAllowed) {
            enqueueMessage(channel, `You don't have permission to generate music in the current mode.`, { replyToId });
            return;
        }

        const prompt = args.join(' '); 
        
        if (prompt.length < 10) {
            enqueueMessage(channel, `Please provide a more descriptive music prompt (at least 10 characters).`, { replyToId });
            return;
        }
        if (prompt.length > 200) {
            enqueueMessage(channel, `Music prompt is too long. Please keep it under 200 characters.`, { replyToId });
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
                    enqueueMessage(channel, `Music generation is currently disabled.`, { replyToId });
                    break;
                case 'queue_full':
                    enqueueMessage(channel, `Music queue is full. Please try again later.`, { replyToId });
                    break;
                default:
                    enqueueMessage(channel, `Failed to queue music generation. Please try again.`, { replyToId });
            }
        }
    }
};