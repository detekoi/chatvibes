import logger from '../../lib/logger.js';
import { enqueueMessage } from '../../lib/ircSender.js';
import { enqueueMusicGeneration, getMusicQueueStatus, clearMusicQueue } from '../music/musicQueue.js';
import { getMusicState, setMusicEnabled } from '../music/musicState.js';
import { hasPermission } from './commandProcessor.js';

export default {
    name: 'music',
    description: 'Generate music using AI. Use !music <prompt> to generate 30 seconds of music.',
    usage: '!music <prompt> | !music status | !music clear | !music on/off',
    permission: 'everyone', // Base command, but actual generation may be restricted
    execute: async (context) => {
        const { channel, user, args } = context;
        const channelNameNoHash = channel.substring(1);

        if (args.length === 0) {
            enqueueMessage(channel, `@${user['display-name']}, Use !music <prompt> to generate music. Example: !music peaceful piano melody`);
            return;
        }

        const subCommand = args[0].toLowerCase();

        // Handle subcommands
        if (subCommand === 'status') {
            const musicState = await getMusicState(channelNameNoHash);
            const queueStatus = getMusicQueueStatus(channelNameNoHash);
            
            let statusMsg = `Music generation is ${musicState.enabled ? 'enabled' : 'disabled'}.`;
            if (musicState.enabled) {
                statusMsg += ` Queue: ${queueStatus.queueLength} pending.`;
                if (queueStatus.isProcessing) {
                    statusMsg += ` Currently generating for @${queueStatus.currentUser}.`;
                }
            }
            
            enqueueMessage(channel, `@${user['display-name']}, ${statusMsg}`);
            return;
        }

        if (subCommand === 'clear') {
            if (!hasPermission('moderator', user, channelNameNoHash)) {
                enqueueMessage(channel, `@${user['display-name']}, You need moderator permissions to clear the music queue.`);
                return;
            }
            
            const cleared = await clearMusicQueue(channelNameNoHash);
            enqueueMessage(channel, `@${user['display-name']}, Cleared ${cleared} music requests from the queue.`);
            return;
        }

        if (subCommand === 'on' || subCommand === 'off') {
            if (!hasPermission('moderator', user, channelNameNoHash)) {
                enqueueMessage(channel, `@${user['display-name']}, You need moderator permissions to toggle music generation.`);
                return;
            }
            
            const enabled = subCommand === 'on';
            const success = await setMusicEnabled(channelNameNoHash, enabled);
            
            if (success) {
                enqueueMessage(channel, `@${user['display-name']}, Music generation ${enabled ? 'enabled' : 'disabled'}.`);
            } else {
                enqueueMessage(channel, `@${user['display-name']}, Failed to update music settings.`);
            }
            return;
        }

        // Handle music generation request
        const musicState = await getMusicState(channelNameNoHash);
        
        if (!musicState.enabled) {
            enqueueMessage(channel, `@${user['display-name']}, Music generation is currently disabled.`);
            return;
        }

        // Check permissions
        const isAllowed = musicState.allowedRoles.some(role => 
            hasPermission(role, user, channelNameNoHash)
        );

        if (!isAllowed) {
            enqueueMessage(channel, `@${user['display-name']}, You don't have permission to generate music.`);
            return;
        }

        const prompt = args.join(' ');
        
        // Basic prompt validation
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
        // Success case is handled by the queue processor (sends generation start message)
    }
};