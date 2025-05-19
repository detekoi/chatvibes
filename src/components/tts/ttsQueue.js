// src/components/tts/ttsQueue.js
import logger from '../../lib/logger.js';
import { generateSpeech } from './ttsService.js';
import { getTtsState, getChannelTtsConfig, getUserEmotionPreference } from './ttsState.js'; // For voice, mode settings and user emotion
import { sendAudioToChannel } from '../web/server.js'; // To send audio URL to web page

const channelQueues = new Map(); // channelName -> { queue: [], isPaused: false, isProcessing: false, ... }
const MAX_QUEUE_LENGTH = 50; // Per channel

export function getOrCreateChannelQueue(channelName) {
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
    const ttsStatus = await getTtsState(channelName); // Full state for engineEnabled check
    if (!ttsStatus.engineEnabled) {
        logger.debug(`[${channelName}] TTS engine disabled, dropping message from ${user}.`);
        return;
    }

    const cq = getOrCreateChannelQueue(channelName);
    if (cq.queue.length >= MAX_QUEUE_LENGTH) {
        logger.warn(`[${channelName}] TTS queue full. Dropping message from ${user}.`);
        return;
    }

    // Get channel-wide TTS config (voice, speed, default emotion etc.)
    const channelConfig = await getChannelTtsConfig(channelName);
    let userEmotion = null;
    if (user) { // Only fetch user preference if a user is associated with the event
        userEmotion = await getUserEmotionPreference(channelName, user);
    }

    const finalVoiceOptions = {
        voiceId: channelConfig.voiceId || 'Friendly_Person',
        speed: channelConfig.speed || 1.0,
        volume: channelConfig.volume || 1.0,
        pitch: channelConfig.pitch || 0,
        // Prioritize user's emotion, then channel's default emotion, then 'auto'
        emotion: userEmotion || channelConfig.emotion || 'auto',
        englishNormalization: channelConfig.englishNormalization !== undefined ? channelConfig.englishNormalization : true,
        sampleRate: channelConfig.sampleRate || 32000,
        bitrate: channelConfig.bitrate || 128000,
        channel: channelConfig.channel || 'mono',
        languageBoost: channelConfig.languageBoost || 'English',
        ...voiceOptions // Event-specific overrides (e.g., from a !tts say command with options)
    };
    
    logger.debug(`[${channelName}] Final voice options for ${user || 'event'}: Emotion='${finalVoiceOptions.emotion}' (User: ${userEmotion}, Channel: ${channelConfig.emotion})`);

    cq.queue.push({ type, text, user, voiceConfig: finalVoiceOptions, timestamp: new Date() });
    logger.debug(`[${channelName}] Enqueued TTS for ${user || 'event'}: "${text.substring(0,20)}..." Queue size: ${cq.queue.length}`);
    processQueue(channelName);
}

export async function processQueue(channelName) {
    const cq = getOrCreateChannelQueue(channelName);
    if (cq.isProcessing || cq.isPaused || cq.queue.length === 0) {
        return;
    }
    cq.isProcessing = true;

    const event = cq.queue.shift();
    logger.info(`[${channelName}] Processing TTS for ${event.user || 'event'} with emotion ${event.voiceConfig.emotion}: "${event.text.substring(0,20)}..."`);

    try {
        // generateSpeech will use event.voiceConfig which includes the emotion
        const audioUrl = await generateSpeech(event.text, event.voiceConfig.voiceId, event.voiceConfig);
        if (audioUrl) {
            cq.currentSpeechUrl = audioUrl;
            sendAudioToChannel(channelName, audioUrl);
            logger.info(`[${channelName}] Sent audio URL to web: ${audioUrl}`);
        }
    } catch (error) {
        logger.error({ err: error, channel: channelName }, 'Error processing TTS event in queue');
    } finally {
        cq.currentSpeechUrl = null;
        cq.isProcessing = false;
        if (!cq.isPaused && cq.queue.length > 0) {
            setTimeout(() => processQueue(channelName), 500);
        }
    }
}

export async function pauseQueue(channelName) {
    const cq = getOrCreateChannelQueue(channelName);
    cq.isPaused = true;
    logger.info(`[${channelName}] TTS queue paused.`);
}

export async function resumeQueue(channelName) {
    const cq = getOrCreateChannelQueue(channelName);
    cq.isPaused = false;
    logger.info(`[${channelName}] TTS queue resumed.`);
    processQueue(channelName); // Attempt to process if items are in queue
}

export async function clearQueue(channelName) {
    const cq = getOrCreateChannelQueue(channelName);
    cq.queue = [];
    logger.info(`[${channelName}] TTS queue cleared.`);
    // If something is speaking, should we stop it? Command `!tts stop` handles that.
}

export async function stopCurrentSpeech(channelName) {
    const cq = getOrCreateChannelQueue(channelName);
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