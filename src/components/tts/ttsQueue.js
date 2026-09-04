// src/components/tts/ttsQueue.js
import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import logger from '../../lib/logger.js';
import { INSTANCE_ID } from '../../lib/instanceId.js';
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
import { sendAudioToChannel, hasActiveClients, channelPrefersUrlAudio, openClipStream, STOP_CURRENT_AUDIO } from '../web/server.js';
import { DEFAULT_TTS_SETTINGS } from './ttsConstants.js'; // Ensure this is imported
import { getProfanityRules } from '../../lib/profanity/index.js';
import { applyRewrites } from '../../lib/textRewrite/replaceEngine.js';
import { resolveToChannelName } from '../../lib/allowList.js';
import { snapshotTiming, elapsed } from '../../lib/ttsTiming.js';

let db;
const TTS_QUEUE_PERSISTENCE_COLLECTION = 'ttsQueuePersistence';

const channelQueues = new Map();
const MAX_QUEUE_LENGTH = 50;
const PREFETCH_AHEAD = 2; // Number of queued items to prefetch concurrently

/**
 * Get the queue for a channel, creating it on first use.
 *
 * The key is normalised because the same channel reaches this function under two
 * identifiers: Twitch handlers pass the login name, while the YouTube chat client
 * passes the numeric broadcaster ID. Keying on the raw string gave one channel two
 * independent queues — so YouTube and Twitch messages played over each other instead
 * of taking turns, and `!tts pause`, `!tts clear` and `!tts stop` reached only the
 * Twitch one. hasActiveClients and sendAudioToChannel already normalise, which is why
 * audio still arrived and the split was invisible.
 */
export function getOrCreateChannelQueue(channelName) {
    channelName = resolveToChannelName(channelName);
    if (!channelQueues.has(channelName)) {
        channelQueues.set(channelName, {
            queue: [],
            isPaused: false,
            isProcessing: false,
            currentSpeech: null,
            currentSpeechController: null,
            currentUserSpeaking: null, // Tracks who/what triggered the current/last speech
            prefetchResults: new Map(), // event -> { promise: Promise<url>, controller: AbortController }
        });
    }
    return channelQueues.get(channelName);
}

export async function enqueue(channelName, eventData, sharedSessionInfo = null) {
    const enqueueStartMs = Date.now();
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

    const userId = eventData.userId; // Extract User ID from eventData

    if (user && allowViewerPrefs) {
        // Fetch all user preferences in parallel to minimize latency
        [globalUserPrefs, userEmotion, userVoice, userPitch, userSpeed, userLanguage, userEnglishNorm] = await Promise.all([
            getGlobalUserPreferences(user, userId),
            getUserEmotionPreference(channelName, user, userId),
            getUserVoicePreference(channelName, user, userId),
            getUserPitchPreference(channelName, user, userId),
            getUserSpeedPreference(channelName, user, userId),
            getUserLanguagePreference(channelName, user, userId),
            getUserEnglishNormalizationPreference(channelName, user, userId),
        ]);
    }

    const finalVoiceOptions = {
        voiceId: globalUserPrefs.voiceId || userVoice || channelConfig.voiceId || DEFAULT_TTS_SETTINGS.voiceId,
        speed: (globalUserPrefs.speed ?? userSpeed) ?? channelConfig.speed ?? DEFAULT_TTS_SETTINGS.speed,
        pitch: (globalUserPrefs.pitch ?? userPitch) ?? channelConfig.pitch ?? DEFAULT_TTS_SETTINGS.pitch,
        emotion: globalUserPrefs.emotion || userEmotion || channelConfig.emotion || DEFAULT_TTS_SETTINGS.emotion,
        languageBoost: globalUserPrefs.languageBoost || userLanguage || channelConfig.languageBoost || DEFAULT_TTS_SETTINGS.languageBoost,

        volume: (channelConfig.voiceVolumes && channelConfig.voiceVolumes[globalUserPrefs.voiceId || userVoice || channelConfig.voiceId || DEFAULT_TTS_SETTINGS.voiceId])
            || channelConfig.volume || DEFAULT_TTS_SETTINGS.volume,
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

    // Profanity filter (opt-in). This is the last text step, and it runs here
    // rather than in formatTtsText because a viewer can override languageBoost
    // for their own messages and that override is only resolved above. When the
    // viewer's language differs from the channel's, both lists apply — filtering
    // on the channel's alone would let a viewer speaking another one through.
    let finalText = text;
    if (ttsStatus.profanityFilterEnabled) {
        // English is always in the set, whatever the channel's language. The
        // pronunciation dictionary is English-only and runs for every channel,
        // so "lfg" becomes "let's fucking go" even on a Spanish one. Loading
        // only the Spanish list would send that straight through untouched.
        const rules = getProfanityRules([
            ttsStatus.languageBoost,
            finalVoiceOptions.languageBoost,
            'English',
        ]);
        if (rules) {
            finalText = applyRewrites(text, rules);
            if (finalText !== text) {
                logger.debug(`[${channelName}] Profanity filter applied to message from ${user || 'event'}.`);
            }
        }
    }

    // The timing record travels in the async context up to here and on the queue
    // item from here, since processQueue runs outside the context that enqueued it.
    const timingSnapshot = snapshotTiming();
    const timing = timingSnapshot ? { ...timingSnapshot, enqueueStartMs, enqueuedMs: Date.now() } : null;

    cq.queue.push({ type, text: finalText, user, voiceConfig: finalVoiceOptions, timestamp: new Date(), sharedSessionInfo, timing });
    logger.debug(`[${channelName}] Enqueued TTS for ${user || 'event'}: "${text.substring(0, 20)}..." Queue size: ${cq.queue.length}`);
    processQueue(channelName);
}

/**
 * The slices of one clip as the provider renders them.
 *
 * generateSpeech pushes into this through `onChunk`; beginChunkedDelivery replays
 * what has arrived and subscribes for the rest. Keeping the slices on the queue
 * item rather than forwarding them straight from `onChunk` is what lets a
 * prefetched clip stream: its slices land while an earlier clip is still playing,
 * and are sent the moment its own turn comes.
 */
function createClip() {
    const clip = { chunks: [], listeners: new Set(), firstChunkMs: null };
    clip.push = buf => {
        clip.chunks.push(buf);
        if (clip.firstChunkMs === null) clip.firstChunkMs = Date.now();
        for (const listener of clip.listeners) listener(buf);
    };
    return clip;
}

/**
 * Forward a clip's slices to every target channel's chunk-capable players.
 *
 * Returns null when no target has such a player, and the caller falls back to
 * sending the finished buffer. Otherwise slices already collected are replayed
 * first (a prefetched clip may be complete by now), then live ones follow in
 * order. `end()` must be called exactly once, on success or failure: the player
 * holds the clip open until it arrives.
 */
function beginChunkedDelivery(targets, event) {
    const clip = event.clip;
    if (!clip) return null;

    const clipId = randomUUID();
    const streams = new Map();
    for (const target of targets) {
        const stream = openClipStream(target, clipId);
        if (stream) streams.set(target, stream);
    }
    if (streams.size === 0) return null;

    const forward = buf => {
        for (const stream of streams.values()) stream.chunk(buf);
        if (event.timing && event.timing.firstChunkSentMs === undefined) {
            event.timing.firstChunkSentMs = Date.now();
        }
    };
    for (const buf of clip.chunks) forward(buf);
    clip.listeners.add(forward);

    return {
        clipId,
        recipientsFor: target => streams.get(target)?.recipients,
        end(opts) {
            clip.listeners.delete(forward);
            for (const stream of streams.values()) stream.end(opts);
        },
    };
}

/**
 * Start prefetching speech generation for upcoming queued items.
 * Called after a message starts processing so the next N items
 * have their API calls running in parallel.
 */
function startPrefetch(channelName) {
    const cq = getOrCreateChannelQueue(channelName);
    if (cq.isPaused || cq.queue.length === 0) return;

    const count = Math.min(PREFETCH_AHEAD, cq.queue.length);
    for (let i = 0; i < count; i++) {
        const event = cq.queue[i];
        if (cq.prefetchResults.has(event)) continue; // Already prefetching this item

        const controller = new AbortController();
        if (event.timing) event.timing.prefetchStartMs = Date.now();
        event.clip = createClip();
        const promise = generateSpeech(event.text, event.voiceConfig.voiceId, {
            ...event.voiceConfig,
            preferUrlOutput: channelPrefersUrlAudio(channelName),
            signal: controller.signal,
            onChunk: event.clip.push,
        }).catch(err => {
            // Swallow abort errors; log others as warnings.
            // processQueue will handle the null result gracefully.
            if (err.name !== 'AbortError' && err.name !== 'CanceledError') {
                logger.warn({ err, channel: channelName, text: event.text.substring(0, 30) }, 'Prefetch generation failed');
            }
            return null;
        });

        cq.prefetchResults.set(event, { promise, controller });
        logger.debug(`[${channelName}] Started prefetch for "${event.text.substring(0, 30)}..." by ${event.user || 'event_tts'}`);
    }
}

/**
 * Abort and clear all active prefetch requests for a channel.
 */
function cancelAllPrefetches(channelName) {
    const cq = getOrCreateChannelQueue(channelName);
    if (cq.prefetchResults.size === 0) return;

    for (const [, { controller }] of cq.prefetchResults) {
        controller.abort();
    }
    logger.debug(`[${channelName}] Cancelled ${cq.prefetchResults.size} active prefetch(es)`);
    cq.prefetchResults.clear();
}

/**
 * One line per clip sent, with the wait broken down by stage so the slow one can
 * be read straight off the logs. All values are milliseconds; a stage that did
 * not happen on this message's route is null. `totalMs` runs from Twitch's own
 * timestamp when there is one (Twitch and Cloud Run clocks are both NTP-synced,
 * so a few ms of skew is possible), otherwise from receipt.
 *
 * Query: jsonPayload.logKey="TTS_TIMING"
 */
function logTiming(channelName, event, audio, wasPrefetched, chunked) {
    const t = event.timing;
    if (!t) return;
    t.sentMs = Date.now();

    logger.info({
        logKey: 'TTS_TIMING',
        channel: channelName,
        user: event.user || 'event_tts',
        type: event.type,
        source: t.source ?? null,
        route: t.route ?? null,
        prefetched: wasPrefetched,
        // Whether the player got the clip slice by slice; firstAudioMs is then the
        // moment the first slice went out, which is when speech can start
        chunked,
        firstAudioMs: elapsed(t, t.originMs != null ? 'originMs' : 'receivedMs', 'firstChunkSentMs'),
        textLength: event.text.length,
        audioKind: audio.kind,
        audioBytes: audio.kind === 'buffer' ? audio.data.length : null,
        // Twitch -> our webhook (network + any Twitch-side delay)
        twitchToWebhookMs: elapsed(t, 'originMs', 'receivedMs'),
        // Firestore dedup claim before any handling starts
        claimMs: elapsed(t, 'receivedMs', 'claimedMs'),
        // Handler work between receipt and the start of enqueue: config reads,
        // command processing, emote describe, formatting, and the Pub/Sub hop
        // when the route is 'pubsub'
        handlerMs: elapsed(t, 'receivedMs', 'enqueueStartMs'),
        pubsubHopMs: elapsed(t, 'publishedMs', 'pubsubReceivedMs'),
        // Preference lookups and the profanity pass inside enqueue
        enqueueMs: elapsed(t, 'enqueueStartMs', 'enqueuedMs'),
        // Time sat behind earlier items before this one was picked up
        queueWaitMs: elapsed(t, 'enqueuedMs', 'genStartMs'),
        // Provider round trip, from whichever call actually produced the audio
        generateMs: elapsed(t, t.prefetchStartMs ? 'prefetchStartMs' : 'genStartMs', 'genEndMs'),
        // How long processQueue itself blocked on audio (shorter than generateMs
        // when the prefetch had a head start)
        waitedForAudioMs: elapsed(t, 'genStartMs', 'genEndMs'),
        totalMs: elapsed(t, 'originMs', 'sentMs') ?? elapsed(t, 'receivedMs', 'sentMs'),
    }, `[${channelName}] TTS timing for ${event.user || 'event_tts'}`);
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
        // This is expected in multi-instance setups - only instances with WebSocket clients process messages
        logger.debug(`[${channelName}] Skipping TTS generation for ${event.user || 'event_tts'} - no active WebSocket clients. Message will be processed by instance with active clients.`);
        // Clean up any prefetch for this event since we are skipping it
        const prefetched = cq.prefetchResults.get(event);
        if (prefetched) {
            prefetched.controller.abort();
            cq.prefetchResults.delete(event);
        }
        cq.queue.unshift(event);
        cq.isProcessing = false;
        // Leave the item in the queue; processing resumes when a client reconnects.
        return;
    }

    // Clear previous state for the new item
    if (cq.currentSpeechController) {
        logger.warn(`[${channelName}] Previous speech controller was still active when starting new item. Aborting it.`);
        cq.currentSpeechController.abort(); // Abort if a previous one was somehow stuck
    }
    cq.currentSpeechController = null;
    cq.currentSpeech = null;
    cq.currentUserSpeaking = event.user || 'event_tts'; // Set user for the current item

    // Start prefetching upcoming items while we process the current one
    startPrefetch(channelName);

    logger.info(`[${channelName}] Processing TTS for ${cq.currentUserSpeaking} (Voice: ${event.voiceConfig.voiceId}, Emotion: ${event.voiceConfig.emotion}, Lang: ${event.voiceConfig.languageBoost}): "${event.text.substring(0, 30)}..."`);

    // Channels this clip is delivered to: every participant of a shared-chat
    // session, or just this one.
    const sharedChannels = event.sharedSessionInfo?.channels;
    const targets = Array.isArray(sharedChannels) && sharedChannels.length > 0 ? sharedChannels : [channelName];
    let delivery = null;

    try {
        let audio;
        const genStartMs = Date.now();

        // Check if this event was already prefetched
        const prefetched = cq.prefetchResults.get(event);
        const wasPrefetched = !!prefetched;
        let promise;
        let controller = null;
        if (prefetched) {
            cq.prefetchResults.delete(event);
            // The prefetch controller is separate — we don't assign it to
            // currentSpeechController because the request is already in-flight.
            // If stopCurrentSpeech is called, cancelAllPrefetches handles it.
            logger.debug(`[${channelName}] Using prefetched result for "${event.text.substring(0, 30)}..."`);
            promise = prefetched.promise;
        } else {
            // No prefetch available — generate normally with a new controller
            controller = new AbortController();
            cq.currentSpeechController = controller;
            event.clip = createClip();
            promise = generateSpeech(event.text, event.voiceConfig.voiceId, {
                ...event.voiceConfig,
                preferUrlOutput: channelPrefersUrlAudio(channelName),
                signal: controller.signal,
                onChunk: event.clip.push,
            });
        }

        // Players that can start on a partial clip get the slices as they land —
        // the ones a prefetch already collected go out right now.
        delivery = beginChunkedDelivery(targets, event);

        audio = await promise;

        // Check if this specific generation was aborted
        if (controller && controller.signal.aborted) {
            logger.info(`[${channelName}] Speech generation for "${event.text.substring(0, 30)}..." by ${cq.currentUserSpeaking} was aborted while processing.`);
            audio = null;
        }

        if (event.timing) {
            event.timing.genStartMs = genStartMs;
            event.timing.genEndMs = Date.now();
        }

        if (audio) {
            cq.currentSpeech = audio;
            // currentUserSpeaking is already set for this audio

            // A buffer is complete on the chunked players once end() lands, so they
            // are excluded from the whole-buffer send below. A URL (the Wavespeed
            // fallback) cannot have been streamed: the player drops whatever slices
            // it saw and plays the URL like everyone else.
            const streamedComplete = delivery && audio.kind === 'buffer';
            if (delivery) delivery.end({ discard: !streamedComplete });
            const sendWhole = target => {
                const exclude = streamedComplete ? delivery.recipientsFor(target) : null;
                if (exclude) sendAudioToChannel(target, audio, { exclude });
                else sendAudioToChannel(target, audio);
            };

            // Send audio to all channels in shared session if applicable
            if (event.sharedSessionInfo && event.sharedSessionInfo.channels && event.sharedSessionInfo.channels.length > 0) {
                const sessionId = event.sharedSessionInfo.sessionId;
                const channels = event.sharedSessionInfo.channels;
                logger.info(`[SharedChat:${sessionId}] Sending audio to ${channels.length} channels: ${channels.join(', ')}`);

                // Send to all participating channels
                for (const targetChannel of channels) {
                    if (hasActiveClients(targetChannel)) {
                        sendWhole(targetChannel);
                        logger.info(`[SharedChat:${sessionId}] Sent audio to ${targetChannel} for ${cq.currentUserSpeaking}`);
                    } else {
                        // Only this instance's sockets are reachable from here, and only
                        // one instance ever wins the claim for a message. So a participant
                        // whose browser source is attached to a *different* instance is
                        // silently skipped and hears nothing.
                        //
                        // This cannot distinguish that from a participant who simply has
                        // no browser source open anywhere — both look identical locally.
                        // To tell them apart, cross-reference `logKey: WS_CLIENT_REGISTERED`
                        // for this channel around the same timestamp: if some instance had
                        // a client for it, this was real audio loss.
                        logger.warn({
                            logKey: 'SHARED_CHAT_PARTICIPANT_UNREACHABLE',
                            sessionId,
                            targetChannel,
                            originChannel: channelName,
                            participants: channels,
                            instance: INSTANCE_ID,
                        }, `[SharedChat:${sessionId}] No local clients for ${targetChannel} — audio not delivered to that participant`);
                    }
                }
            } else {
                // Normal single-channel audio delivery
                sendWhole(channelName);
                logger.info(`[${channelName}] Sent audio to web for ${cq.currentUserSpeaking} (${audio.kind}${streamedComplete ? ', streamed' : ''})`);
            }

            logTiming(channelName, event, audio, wasPrefetched, !!streamedComplete);
        } else {
            // No audio — issue in generateSpeech, prefetch failure, or aborted
            if (delivery) delivery.end({ discard: true });
            logger.warn(`[${channelName}] generateSpeech returned no audio for "${event.text.substring(0, 30)}..." by ${cq.currentUserSpeaking}.`);
            // currentSpeech remains null, currentUserSpeaking will be cleared in finally
        }
    } catch (error) {
        // The player is holding the clip open; tell it to let go.
        if (delivery) delivery.end({ discard: true });
        if (error.name === 'AbortError') {
            logger.info(`[${channelName}] Speech generation fetch aborted for "${event.text.substring(0, 30)}..." by ${cq.currentUserSpeaking}.`);
        } else {
            logger.error({ err: error, channel: channelName, eventText: event.text.substring(0, 30) }, 'Error processing TTS event in queue');
        }
        // Ensure currentSpeech is null on error. currentUserSpeaking will be cleared in finally if the controller matches.
        cq.currentSpeech = null;
    } finally {
        // Only nullify the controller if it's the one we just used for this task
        // and it hasn't already been nulled by a concurrent stopCurrentSpeech call.
        if (cq.currentSpeechController) {
            cq.currentSpeechController = null;
        }

        // If the speech is null at this point (generation failed, was aborted, or never set),
        // then the currentUserSpeaking for *this specific event* should also be cleared,
        // as there's no active speech associated with them from this attempt.
        if (!cq.currentSpeech && cq.currentUserSpeaking === (event.user || 'event_tts')) {
            cq.currentUserSpeaking = null;
        }

        cq.isProcessing = false;

        if (!cq.isPaused && cq.queue.length > 0) {
            setImmediate(() => processQueue(channelName));
        } else if (!cq.isPaused && cq.queue.length === 0) {
            // Queue is empty.
            // If currentSpeech is null (last item failed/aborted), currentUserSpeaking should also be null.
            if (!cq.currentSpeech) {
                cq.currentUserSpeaking = null;
            }
            logger.debug(`[${channelName}] TTS Queue is empty and processing finished. Last speaker (if audio was sent): ${cq.currentUserSpeaking}`);
        }
    }
}

export async function stopCurrentSpeech(channelName) {
    const cq = getOrCreateChannelQueue(channelName);
    logger.info(`[${channelName}] Attempting to stop current speech. Speaker: ${cq.currentUserSpeaking}, Playing: ${!!cq.currentSpeech}, Controller: ${!!cq.currentSpeechController}`);

    let stoppedSomethingSignificant = false;

    // Abort all active prefetches — no point generating audio for upcoming items
    cancelAllPrefetches(channelName);

    // If there's an active generation controller, abort it
    if (cq.currentSpeechController) {
        logger.info(`[${channelName}] Aborting active speech generation controller for ${cq.currentUserSpeaking || 'unknown task'}.`);
        cq.currentSpeechController.abort();
        cq.currentSpeechController = null; // Clear the controller as it's now aborted
        stoppedSomethingSignificant = true;
        // The currentUserSpeaking and currentSpeech related to this aborted generation
        // should be cleared by the processQueue's finally block when the AbortError is caught.
    }

    // If audio was set (meaning it was likely already sent to the client)
    if (cq.currentSpeech) {
        logger.info(`[${channelName}] Sending STOP_CURRENT_AUDIO to client for speech by ${cq.currentUserSpeaking || 'unknown/event'}.`);
        sendAudioToChannel(channelName, STOP_CURRENT_AUDIO);
        cq.currentSpeech = null;         // Clear the audio
        cq.currentUserSpeaking = null;   // Clear the associated speaker
        stoppedSomethingSignificant = true;
    }

    // If nothing was actively being generated or tracked as playing by the server,
    // still send a stop signal to the client as a precaution.
    if (!stoppedSomethingSignificant) {
        logger.info(`[${channelName}] No active audio or generation controller on server. Sending precautionary STOP_CURRENT_AUDIO to client.`);
        sendAudioToChannel(channelName, STOP_CURRENT_AUDIO);
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
    // Abort all active prefetches since their queue items are now gone
    cancelAllPrefetches(channelName);
    logger.info(`[${channelName}] TTS queue cleared of ${itemsCleared} pending messages. This does not stop actively playing/generating audio.`);
    // Does NOT affect cq.currentSpeech, cq.currentUserSpeaking, or cq.currentSpeechController
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