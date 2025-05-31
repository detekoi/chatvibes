// src/components/music/musicQueue.js
import logger from '../../lib/logger.js';
import { generateMusic } from './musicServiceBridge.js';
import { getMusicState } from './musicState.js';
import { sendAudioToChannel } from '../web/server.js';
import { enqueueMessage } from '../../lib/ircSender.js';

const channelQueues = new Map();
const MAX_MUSIC_QUEUE_LENGTH = 8; // Limit due to up to 90-second generation time

export function getOrCreateMusicQueue(channelName) {
    if (!channelQueues.has(channelName)) {
        channelQueues.set(channelName, {
            queue: [],
            isProcessing: false,
            currentGeneration: null,
            currentGenerationUser: null
        });
    }
    return channelQueues.get(channelName);
}

export async function enqueueMusicGeneration(channelName, eventData) {
    const { prompt, user, negativePrompt, seed } = eventData;
    const musicStatus = await getMusicState(channelName);
    
    if (!musicStatus.enabled) {
        logger.debug(`[${channelName}] Music generation disabled, dropping request from ${user}.`);
        return { success: false, reason: 'disabled' };
    }

    const mq = getOrCreateMusicQueue(channelName);
    if (mq.queue.length >= MAX_MUSIC_QUEUE_LENGTH) {
        logger.warn(`[${channelName}] Music queue full. Dropping request from ${user}.`);
        return { success: false, reason: 'queue_full' };
    }

    mq.queue.push({ prompt, user, negativePrompt, seed, timestamp: new Date() });
    logger.info(`[${channelName}] Enqueued music generation for ${user}: "${prompt.substring(0,30)}..." Queue size: ${mq.queue.length}`);
    
    processMusicQueue(channelName);
    return { success: true };
}

export async function processMusicQueue(channelName) {
    const mq = getOrCreateMusicQueue(channelName);

    // ++ ADDED DIAGNOSTIC LOGGING ++
    logger.debug(`[${channelName}] processMusicQueue called. isProcessing: ${mq.isProcessing}, queueLength: ${mq.queue.length}`);

    if (mq.isProcessing || mq.queue.length === 0) {
        if (mq.isProcessing) {
            logger.debug(`[${channelName}] processMusicQueue returning: Music queue is already processing.`);
        }
        if (mq.queue.length === 0 && !mq.isProcessing) { // Only log if not processing and queue is empty
             logger.debug(`[${channelName}] processMusicQueue returning: Music queue is empty.`);
        }
        return;
    }

    mq.isProcessing = true;
    const event = mq.queue.shift();
    mq.currentGeneration = event;
    mq.currentGenerationUser = event.user;

    // Notify chat that generation has started
    enqueueMessage(`#${channelName}`, `🎵 Generating music for @${event.user}: "${event.prompt.substring(0,50)}${event.prompt.length > 50 ? '...' : ''}" (This may take up to 90 seconds)`);

    logger.info(`[${channelName}] Starting music generation for ${event.user}: "${event.prompt}"`);

    try {
        const result = await generateMusic(event.prompt, {
            negativePrompt: event.negativePrompt,
            seed: event.seed
        });

        if (result.success) {
            // Send audio to WebSocket clients
            sendAudioToChannel(channelName, result.audio_url);
            
            // Notify chat that music is ready
            enqueueMessage(`#${channelName}`, `🎶 Music generated for @${event.user} is now playing!`);
            
            logger.info(`[${channelName}] Music generation completed for ${event.user}: ${result.audio_url}`);
        } else {
            // Handle error cases with user-friendly messages from bridge
            const errorMessage = `@${event.user}, ${result.message}`;
            enqueueMessage(`#${channelName}`, errorMessage);
            logger.error(`[${channelName}] Music generation failed for ${event.user}: ${result.message}`);
        }
    } catch (error) {
        // This should rarely happen now since bridge handles errors gracefully
        enqueueMessage(`#${channelName}`, `@${event.user}, Sorry, there was an unexpected error generating your music. Please try again later.`);
        logger.error({ err: error, channel: channelName, user: event.user, prompt: event.prompt }, 'Unexpected music generation error in processMusicQueue');
    } finally {
        mq.isProcessing = false;
        mq.currentGeneration = null;
        mq.currentGenerationUser = null;
        logger.debug(`[${channelName}] Music processing finished for prompt by ${event.user}. isProcessing set to false.`);
        
        // Process next item in queue after a short delay
        if (mq.queue.length > 0) {
            logger.debug(`[${channelName}] Music queue has ${mq.queue.length} items remaining. Scheduling next processing.`);
            setTimeout(() => processMusicQueue(channelName), 1000);
        } else {
            logger.debug(`[${channelName}] Music queue is now empty.`);
        }
    }
}

export async function clearMusicQueue(channelName) {
    const mq = getOrCreateMusicQueue(channelName);
    const itemsCleared = mq.queue.length;
    mq.queue = [];
    logger.info(`[${channelName}] Music queue cleared of ${itemsCleared} pending requests.`);
    return itemsCleared;
}

export function getMusicQueueStatus(channelName) {
    const mq = getOrCreateMusicQueue(channelName);
    return {
        queueLength: mq.queue.length,
        isProcessing: mq.isProcessing,
        currentUser: mq.currentGenerationUser,
        currentPrompt: mq.currentGeneration?.prompt?.substring(0, 30)
    };
}

export function initializeMusicQueues() {
    // No-op for now. Add any music system initialization logic here if needed in the future.
    logger.info('Music Queues initialized.');
}