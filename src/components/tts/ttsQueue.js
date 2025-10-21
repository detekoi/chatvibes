// src/components/tts/ttsQueue.js
import { Firestore } from '@google-cloud/firestore';
import logger from '../../lib/logger.js';
import { generateSpeech } from './ttsService.js';
import {
    getTtsState,
    getChannelTtsConfig,
    getGlobalUserPreferences,
    getUserEmotionPreference,
    getUserVoicePreference,
    getUserPitchPreference,
    getUserSpeedPreference,
    getUserLanguagePreference,
    getUserEnglishNormalizationPreference
} from './ttsState.js';
import { sendAudioToChannel, hasActiveClients } from '../web/server.js';
import { DEFAULT_TTS_SETTINGS } from './ttsConstants.js'; // Ensure this is imported

let db;
const TTS_QUEUE_PERSISTENCE_COLLECTION = 'ttsQueuePersistence';

const channelQueues = new Map();
const MAX_QUEUE_LENGTH = 50;

export function getOrCreateChannelQueue(channelName) {
    if (!channelQueues.has(channelName)) {
        channelQueues.set(channelName, {
            queue: [],
            isPaused: false,
            isProcessing: false,
            currentSpeechUrl: null,
            currentSpeechController: null,
            currentUserSpeaking: null, // Tracks who/what triggered the current/last speech
        });
    }
    return channelQueues.get(channelName);
}

export async function enqueue(channelName, eventData, sharedSessionInfo = null) {
    const { text, user, type = 'chat', voiceOptions = {} } = eventData;

    const logData = {
        logKey: "TTS_ENQUEUE_CALLED",
        channelName,
        textForTTS: text,
        userForTTS: user,
        typeForTTS: type,
        timestamp_ms: Date.now()
    };

    if (sharedSessionInfo) {
        logData.sessionId = sharedSessionInfo.sessionId;
        logData.sharedChannels = sharedSessionInfo.channels;
        logger.debug(logData, `[SharedChat:${sharedSessionInfo.sessionId}] TTS_ENQUEUE_CALLED for user: ${user}, type: ${type}, text: "${text.substring(0, 30)}..." in shared session`);
    } else {
        logger.debug(logData, `TTS_ENQUEUE_CALLED for user: ${user}, type: ${type}, text: "${text.substring(0, 30)}..."`);
    }

    const ttsStatus = await getTtsState(channelName);
    if (!ttsStatus.engineEnabled) {
        logger.debug(`[${channelName}] TTS engine disabled, dropping message from ${user}.`);
        return;
    }

    const cq = getOrCreateChannelQueue(channelName);
    if (cq.queue.length >= MAX_QUEUE_LENGTH) {
        logger.warn(`[${channelName}] TTS queue full. Dropping message from ${user}.`);
        return;
    }

    const channelConfig = await getChannelTtsConfig(channelName);
    // Check if viewer preferences are allowed (defaults to true if not set)
    const allowViewerPrefs = ttsStatus && ttsStatus.allowViewerPreferences !== false;
    let globalUserPrefs = {};
    let userEmotion = null;
    let userVoice = null;
    let userPitch = null;
    let userSpeed = null;
    let userLanguage = null;
    let userEnglishNorm = null;

    if (user && allowViewerPrefs) {
        // Fetch global prefs first
        globalUserPrefs = await getGlobalUserPreferences(user);
        // Keep legacy per-channel overrides for backward compatibility
        userEmotion = await getUserEmotionPreference(channelName, user);
        userVoice = await getUserVoicePreference(channelName, user);
        userPitch = await getUserPitchPreference(channelName, user);
        userSpeed = await getUserSpeedPreference(channelName, user);
        userLanguage = await getUserLanguagePreference(channelName, user);
        userEnglishNorm = await getUserEnglishNormalizationPreference(channelName, user);
    }

    const finalVoiceOptions = {
        voiceId: globalUserPrefs.voiceId || userVoice || channelConfig.voiceId || DEFAULT_TTS_SETTINGS.voiceId,
        speed: (globalUserPrefs.speed ?? userSpeed) ?? channelConfig.speed ?? DEFAULT_TTS_SETTINGS.speed,
        pitch: (globalUserPrefs.pitch ?? userPitch) ?? channelConfig.pitch ?? DEFAULT_TTS_SETTINGS.pitch,
        emotion: globalUserPrefs.emotion || userEmotion || channelConfig.emotion || DEFAULT_TTS_SETTINGS.emotion,
        languageBoost: globalUserPrefs.languageBoost || userLanguage || channelConfig.languageBoost || DEFAULT_TTS_SETTINGS.languageBoost,
        volume: channelConfig.volume || DEFAULT_TTS_SETTINGS.volume,
        englishNormalization: (globalUserPrefs.englishNormalization ?? userEnglishNorm) ?? (channelConfig.englishNormalization !== undefined
                                ? channelConfig.englishNormalization
                                : DEFAULT_TTS_SETTINGS.englishNormalization),
        sampleRate: channelConfig.sampleRate || DEFAULT_TTS_SETTINGS.sampleRate,
        bitrate: channelConfig.bitrate || DEFAULT_TTS_SETTINGS.bitrate,
        channel: channelConfig.channel || DEFAULT_TTS_SETTINGS.channel,
        ...voiceOptions // Allow direct voiceOptions to override
    };
     if (voiceOptions.languageBoost) { // Ensure direct pass-through overrides if specified
        finalVoiceOptions.languageBoost = voiceOptions.languageBoost;
    }
    
    logger.debug(`[${channelName}] Final voice options for ${user || 'event'}: VoiceID='${finalVoiceOptions.voiceId}', Emotion='${finalVoiceOptions.emotion}', Speed=${finalVoiceOptions.speed}, Pitch=${finalVoiceOptions.pitch}, LanguageBoost='${finalVoiceOptions.languageBoost}'`);

    cq.queue.push({ type, text, user, voiceConfig: finalVoiceOptions, timestamp: new Date(), sharedSessionInfo });
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

    // Check if there are active WebSocket clients before expensive API call
    if (!hasActiveClients(channelName)) {
        logger.warn(`[${channelName}] Skipping TTS generation for ${event.user || 'event_tts'} - no active WebSocket clients. Dropping message: "${event.text.substring(0,30)}..."`);
        cq.isProcessing = false;
        // Continue processing queue in case clients reconnect
        if (!cq.isPaused && cq.queue.length > 0) {
            setTimeout(() => processQueue(channelName), 500);
        }
        return;
    }

    // Clear previous state for the new item
    if (cq.currentSpeechController) {
        logger.warn(`[${channelName}] Previous speech controller was still active when starting new item. Aborting it.`);
        cq.currentSpeechController.abort(); // Abort if a previous one was somehow stuck
    }
    cq.currentSpeechController = null;
    cq.currentSpeechUrl = null;
    cq.currentUserSpeaking = event.user || 'event_tts'; // Set user for the current item

    const controller = new AbortController();
    cq.currentSpeechController = controller; // Assign new controller for the current speech generation

    logger.info(`[${channelName}] Processing TTS for ${cq.currentUserSpeaking} (Voice: ${event.voiceConfig.voiceId}, Emotion: ${event.voiceConfig.emotion}, Lang: ${event.voiceConfig.languageBoost}): "${event.text.substring(0,30)}..."`);

    try {
        const audioUrl = await generateSpeech(event.text, event.voiceConfig.voiceId, { ...event.voiceConfig, signal: controller.signal });
        
        // Check if this specific generation was aborted
        if (controller.signal.aborted) {
            logger.info(`[${channelName}] Speech generation for "${event.text.substring(0,30)}..." by ${cq.currentUserSpeaking} was aborted while processing.`);
            // currentSpeechUrl is already null, currentUserSpeaking will be cleared in finally if controller matches
        } else if (audioUrl) {
            cq.currentSpeechUrl = audioUrl; 
            // currentUserSpeaking is already set for this audio
            
            // Send audio to all channels in shared session if applicable
            if (event.sharedSessionInfo && event.sharedSessionInfo.channels && event.sharedSessionInfo.channels.length > 0) {
                const sessionId = event.sharedSessionInfo.sessionId;
                const channels = event.sharedSessionInfo.channels;
                logger.info(`[SharedChat:${sessionId}] Sending audio to ${channels.length} channels: ${channels.join(', ')}`);
                
                // Send to all participating channels
                for (const targetChannel of channels) {
                    if (hasActiveClients(targetChannel)) {
                        sendAudioToChannel(targetChannel, audioUrl);
                        logger.info(`[SharedChat:${sessionId}] Sent audio to ${targetChannel} for ${cq.currentUserSpeaking}`);
                    } else {
                        logger.debug(`[SharedChat:${sessionId}] No active clients for ${targetChannel}, skipping`);
                    }
                }
            } else {
                // Normal single-channel audio delivery
                sendAudioToChannel(channelName, audioUrl);
                logger.info(`[${channelName}] Sent audio URL to web for ${cq.currentUserSpeaking}: ${audioUrl}`);
            }
        } else {
            // No URL and not aborted - issue in generateSpeech or Wavespeed API
            logger.warn(`[${channelName}] generateSpeech returned no URL for "${event.text.substring(0,30)}..." by ${cq.currentUserSpeaking} and was not aborted.`);
            // currentSpeechUrl remains null, currentUserSpeaking will be cleared in finally if controller matches
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            logger.info(`[${channelName}] Speech generation fetch aborted for "${event.text.substring(0,30)}..." by ${cq.currentUserSpeaking}.`);
        } else {
            logger.error({ err: error, channel: channelName, eventText: event.text.substring(0,30) }, 'Error processing TTS event in queue');
        }
        // Ensure currentSpeechUrl is null on error. currentUserSpeaking will be cleared in finally if the controller matches.
        cq.currentSpeechUrl = null; 
    } finally {
        // Only nullify the controller if it's the one we just used for this task
        // and it hasn't already been nulled by a concurrent stopCurrentSpeech call.
        if (cq.currentSpeechController === controller) {
            cq.currentSpeechController = null;
        }

        // If the speech URL is null at this point (generation failed, was aborted, or never set),
        // then the currentUserSpeaking for *this specific event* should also be cleared,
        // as there's no active speech associated with them from this attempt.
        if (!cq.currentSpeechUrl && cq.currentUserSpeaking === (event.user || 'event_tts')) {
            cq.currentUserSpeaking = null;
        }

        cq.isProcessing = false;
        
        if (!cq.isPaused && cq.queue.length > 0) {
            setTimeout(() => processQueue(channelName), 500); 
        } else if (!cq.isPaused && cq.queue.length === 0) {
            // Queue is empty.
            // If currentSpeechUrl is null (last item failed/aborted), currentUserSpeaking should also be null.
            if (!cq.currentSpeechUrl) {
                cq.currentUserSpeaking = null;
            }
            logger.debug(`[${channelName}] TTS Queue is empty and processing finished. Last speaker (if audio was sent): ${cq.currentUserSpeaking}, URL: ${cq.currentSpeechUrl}`);
        }
    }
}

export async function stopCurrentSpeech(channelName) {
    const cq = getOrCreateChannelQueue(channelName);
    logger.info(`[${channelName}] Attempting to stop current speech. Speaker: ${cq.currentUserSpeaking}, URL: ${cq.currentSpeechUrl}, Controller: ${!!cq.currentSpeechController}`);

    let stoppedSomethingSignificant = false;

    // If there's an active generation controller, abort it
    if (cq.currentSpeechController) {
        logger.info(`[${channelName}] Aborting active speech generation controller for ${cq.currentUserSpeaking || 'unknown task'}.`);
        cq.currentSpeechController.abort();
        cq.currentSpeechController = null; // Clear the controller as it's now aborted
        stoppedSomethingSignificant = true;
        // The currentUserSpeaking and currentSpeechUrl related to this aborted generation
        // should be cleared by the processQueue's finally block when the AbortError is caught.
    }

    // If a speech URL was set (meaning audio was likely sent to client)
    if (cq.currentSpeechUrl) {
        logger.info(`[${channelName}] Sending STOP_CURRENT_AUDIO to client for speech by ${cq.currentUserSpeaking || 'unknown/event'} (URL: ${cq.currentSpeechUrl}).`);
        sendAudioToChannel(channelName, 'STOP_CURRENT_AUDIO');
        cq.currentSpeechUrl = null;      // Clear the URL
        cq.currentUserSpeaking = null;   // Clear the associated speaker
        stoppedSomethingSignificant = true;
    }
    
    // If nothing was actively being generated or tracked as playing by the server,
    // still send a stop signal to the client as a precaution.
    if (!stoppedSomethingSignificant) {
        logger.info(`[${channelName}] No active URL or generation controller on server. Sending precautionary STOP_CURRENT_AUDIO to client.`);
        sendAudioToChannel(channelName, 'STOP_CURRENT_AUDIO');
        // Do not set stoppedSomethingSignificant = true here, as the server didn't actively stop its own tracked process.
    }
    
    return stoppedSomethingSignificant;
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
    processQueue(channelName);
}

export async function clearQueue(channelName) {
    const cq = getOrCreateChannelQueue(channelName);
    const itemsCleared = cq.queue.length;
    cq.queue = []; // Clear pending items
    logger.info(`[${channelName}] TTS queue cleared of ${itemsCleared} pending messages. This does not stop actively playing/generating audio.`);
    // Does NOT affect cq.currentSpeechUrl, cq.currentUserSpeaking, or cq.currentSpeechController
}

/**
 * Persist all TTS queues to Firestore to prevent message loss during shutdown
 * Only persists pending items, not currently processing item
 */
export async function persistAllQueues() {
    if (!db) db = new Firestore();

    const persistenceTasks = [];
    let totalPersisted = 0;

    for (const [channelName, cq] of channelQueues.entries()) {
        if (cq.queue.length === 0) {
            // No pending items, delete persistence doc if it exists
            persistenceTasks.push(
                db.collection(TTS_QUEUE_PERSISTENCE_COLLECTION).doc(channelName).delete()
                    .catch(err => {
                        if (err.code !== 5) { // Ignore "NOT_FOUND" errors (code 5)
                            logger.warn({ err, channel: channelName }, 'Failed to delete empty queue persistence doc');
                        }
                    })
            );
            continue;
        }

        // Serialize queue items (convert Date objects to ISO strings)
        const serializedQueue = cq.queue.map(item => ({
            ...item,
            timestamp: item.timestamp instanceof Date ? item.timestamp.toISOString() : item.timestamp
        }));

        totalPersisted += cq.queue.length;

        persistenceTasks.push(
            db.collection(TTS_QUEUE_PERSISTENCE_COLLECTION).doc(channelName).set({
                channelName,
                queue: serializedQueue,
                queueLength: cq.queue.length,
                isPaused: cq.isPaused,
                persistedAt: new Date(),
            }).catch(err => {
                logger.error({ err, channel: channelName }, 'Failed to persist TTS queue');
            })
        );
    }

    await Promise.allSettled(persistenceTasks);
    logger.info(`TTS queue persistence complete. Persisted ${totalPersisted} messages across ${channelQueues.size} channels.`);
}

/**
 * Restore TTS queues from Firestore after startup
 * Call this after TTS state is initialized but before processing new messages
 */
export async function restoreAllQueues() {
    if (!db) db = new Firestore();

    try {
        const snapshot = await db.collection(TTS_QUEUE_PERSISTENCE_COLLECTION).get();

        if (snapshot.empty) {
            logger.info('No persisted TTS queues found to restore.');
            return;
        }

        let totalRestored = 0;
        const deleteTasks = [];

        snapshot.forEach(doc => {
            const data = doc.data();
            const { channelName, queue, isPaused } = data;

            if (!queue || queue.length === 0) {
                logger.debug(`[${channelName}] Persisted queue was empty, skipping restore.`);
                deleteTasks.push(doc.ref.delete());
                return;
            }

            // Restore queue items (convert ISO strings back to Date objects)
            const restoredQueue = queue.map(item => ({
                ...item,
                timestamp: typeof item.timestamp === 'string' ? new Date(item.timestamp) : item.timestamp
            }));

            // Get or create channel queue and restore items
            const cq = getOrCreateChannelQueue(channelName);
            cq.queue = restoredQueue;
            cq.isPaused = isPaused || false;

            totalRestored += restoredQueue.length;
            logger.info(`[${channelName}] Restored ${restoredQueue.length} TTS messages from persistence (paused: ${cq.isPaused})`);

            // Delete the persistence doc after successful restore
            deleteTasks.push(doc.ref.delete());

            // Start processing the queue if not paused
            if (!cq.isPaused && cq.queue.length > 0) {
                logger.info(`[${channelName}] Starting TTS queue processing for restored messages`);
                // Use setImmediate to avoid blocking the restore loop
                setImmediate(() => processQueue(channelName));
            }
        });

        // Clean up persistence docs
        await Promise.allSettled(deleteTasks);

        logger.info(`TTS queue restoration complete. Restored ${totalRestored} messages across ${snapshot.size} channels.`);
    } catch (error) {
        logger.error({ err: error }, 'Failed to restore TTS queues from Firestore');
    }
}