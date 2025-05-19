// src/components/tts/ttsQueue.js
import logger from '../../lib/logger.js';
import { generateSpeech } from './ttsService.js';
import { getTtsState, getChannelTtsConfig } from './ttsState.js'; // For voice, mode settings
import { sendAudioToChannel } from '../web/server.js'; // To send audio URL to web page

const channelQueues = new Map(); // channelName -> { queue: [], isPaused: false, isProcessing: false, ... }
const MAX_QUEUE_LENGTH = 50; // Per channel

function _getOrCreateChannelQueue(channelName) {
    if (!channelQueues.has(channelName)) {
        channelQueues.set(channelName, {
            queue: [],
            isPaused: false,
            isProcessing: false,
            currentSpeechUrl: null,
            currentSpeechController: null, // For aborting if possible
        });
    }
    return channelQueues.get(channelName);
}

export async function enqueue(channelName, eventData) {
    const { text, user, type = 'chat', voiceOptions = {} } = eventData;
    const ttsStatus = await getTtsState(channelName);
    if (!ttsStatus.engineEnabled) return; // Engine disabled

    const cq = _getOrCreateChannelQueue(channelName);
    if (cq.queue.length >= MAX_QUEUE_LENGTH) {
        logger.warn(`[${channelName}] TTS queue full. Dropping message from ${user}.`);
        return;
    }

    // Get channel-specific or default voice config
    const channelConfig = await getChannelTtsConfig(channelName);
    const finalVoiceOptions = {
        voiceId: channelConfig.voiceId || 'Friendly_Person',
        speed: channelConfig.speed || 1.0,
        // ... other defaults from channelConfig or ttsConstants
        ...voiceOptions // User/command specific overrides
    };

    cq.queue.push({ type, text, user, voiceConfig: finalVoiceOptions, timestamp: new Date() });
    logger.debug(`[${channelName}] Enqueued TTS for ${user}: "${text.substring(0,20)}..." Queue size: ${cq.queue.length}`);
    processQueue(channelName); // Attempt to process if not already doing so
}

export async function processQueue(channelName) {
    const cq = _getOrCreateChannelQueue(channelName);
    if (cq.isProcessing || cq.isPaused || cq.queue.length === 0) {
        return;
    }
    cq.isProcessing = true;

    const event = cq.queue.shift(); // Get first event
    logger.info(`[${channelName}] Processing TTS for ${event.user}: "${event.text.substring(0,20)}..."`);

    try {
        const audioUrl = await generateSpeech(event.text, event.voiceConfig.voiceId, event.voiceConfig);
        if (audioUrl) {
            cq.currentSpeechUrl = audioUrl;
            sendAudioToChannel(channelName, audioUrl); // Send to WebSocket
            // Wait for audio to finish? This is tricky.
            // The browser source will play it. We need a way to know when it's done.
            // Option 1: Estimate duration based on text length/speed.
            // Option 2: Client (browser source) sends a "finishedPlaying" event back via WebSocket.
            // For now, let's assume a simple delay or fire-and-forget for the next item.
            // A more robust solution would involve the client signaling completion.
            logger.info(`[${channelName}] Sent audio URL to web: ${audioUrl}`);
        }
    } catch (error) {
        logger.error({ err: error, channel: channelName }, 'Error processing TTS event');
    } finally {
        cq.currentSpeechUrl = null;
        cq.isProcessing = false;
        // Process next item if queue is not empty and not paused
        if (!cq.isPaused && cq.queue.length > 0) {
            // Add a small delay before processing next to avoid API hammering
            // and to give current audio a chance to start playing.
            setTimeout(() => processQueue(channelName), 500);
        }
    }
}

export async function pauseQueue(channelName) {
    const cq = _getOrCreateChannelQueue(channelName);
    cq.isPaused = true;
    logger.info(`[${channelName}] TTS queue paused.`);
}

export async function resumeQueue(channelName) {
    const cq = _getOrCreateChannelQueue(channelName);
    cq.isPaused = false;
    logger.info(`[${channelName}] TTS queue resumed.`);
    processQueue(channelName); // Attempt to process if items are in queue
}

export async function clearQueue(channelName) {
    const cq = _getOrCreateChannelQueue(channelName);
    cq.queue = [];
    logger.info(`[${channelName}] TTS queue cleared.`);
    // If something is speaking, should we stop it? Command `!tts stop` handles that.
}

export async function stopCurrentSpeech(channelName) {
    const cq = _getOrCreateChannelQueue(channelName);
    logger.info(`[${channelName}] Attempting to stop current speech: ${cq.currentSpeechUrl}`);
    if (cq.currentSpeechUrl) {
        // How to actually stop?
        // 1. If Replicate provides an abort for ongoing generation (unlikely for this model type).
        // 2. Send a "stop" command to the OBS browser source via WebSocket.
        sendAudioToChannel(channelName, 'STOP_CURRENT_AUDIO'); // Special message
        cq.currentSpeechUrl = null; // Assume it stopped or will stop soon.
        if (cq.currentSpeechController) {
            cq.currentSpeechController.abort();
            cq.currentSpeechController = null;
        }
        return true;
    }
    return false;
}