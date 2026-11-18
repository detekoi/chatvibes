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
    getChannelUserPreferences
} from './ttsState.js';
import { sendAudioToChannel, hasActiveClients, openClipStream, sendClipMeta, STOP_CURRENT_AUDIO } from '../web/server.js';
import { DEFAULT_TTS_SETTINGS } from './ttsConstants.js'; // Ensure this is imported
import { getProfanityRules } from '../../lib/profanity/index.js';
import { applyRewrites } from '../../lib/textRewrite/replaceEngine.js';
import { stripDisabledSoundTags } from '../../lib/textRewrite/soundTags.js';
import { resolveToChannelName, getChannelIdFromName, getChannelNameFromId } from '../../lib/allowList.js';
import { snapshotTiming, elapsed } from '../../lib/ttsTiming.js';
import { isGloballyOptedOut } from '../../lib/globalOptOut.js';
import { resolveVoice } from './voiceResolver.js';
import { buildStyle } from './styleBuilder.js';
import { localeFromLanguageBoost, getTranslator, resolveChannelLocale } from '../../i18n/index.js';

let db;
const TTS_QUEUE_PERSISTENCE_COLLECTION = 'ttsQueuePersistence';

const channelQueues = new Map();
const MAX_QUEUE_LENGTH = 50;
// Speech types an opted-out viewer still gets. An `event` is an announcement
// about them, spoken without their words. A `reward` is the TTS Channel Points
// reward: redeeming it is a paid request to be read. A moderator mute refuses
// it (and refunds it) in redemptionHandler.js, before it gets here.
const SPOKEN_WHEN_OPTED_OUT = new Set(['event', 'reward']);
const PREFETCH_AHEAD = 2; // Number of queued items to prefetch concurrently
// The card a browser source shows for a clip (spotlightCard). Its text is cut to
// these lengths in code points, so a long message cannot cover the stream.
const DISPLAY_KINDS = new Set(['spotlight']);
const DISPLAY_TEXT_MAX = 200;
const DISPLAY_USER_MAX = 50;

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
            currentUserSpeaking: null, // Tracks who/what triggered the current/last speech (display)
            currentUserIdSpeaking: null, // Account ID of that speaker; `!tts stop` ownership checks this
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

    // Preferences are keyed by account ID; an event without one (anonymous gift,
    // system announcement) gets channel defaults.
    const userId = eventData.userId;
    // Check if viewer preferences are allowed (defaults to true if not set)
    const allowViewerPrefs = ttsStatus && ttsStatus.allowViewerPreferences !== false;
    // Viewer preferences and the global opt-out are keyed by Twitch user ID, and
    // only Twitch chat commands and the dashboard write them. A YouTube channel ID
    // never has a document, so a YouTube item reads neither. For a Twitch viewer
    // the opt-out is read whatever allowViewerPreferences says: it is the
    // viewer's consent, not a preference, and a channel cannot turn it off. The
    // channel reads come from the cached config, so the only Firestore round trip
    // here is the viewer document, which the 60-second cache in ttsState.js
    // usually already holds.
    const isTwitchViewer = Boolean(userId) && eventData.platform !== 'youtube';
    const [channelConfig, viewerGlobalPrefs, channelUserPrefs] = await Promise.all([
        getChannelTtsConfig(channelName),
        isTwitchViewer ? getGlobalUserPreferences(userId) : {},
        isTwitchViewer && allowViewerPrefs ? getChannelUserPreferences(channelName, userId) : {},
    ]);
    const globalUserPrefs = allowViewerPrefs ? viewerGlobalPrefs : {};

    // The handlers already hold back an opted-out viewer's text before formatting
    // it. This is the backstop for every route into the queue, including ones
    // that pass the handler guards and an instance whose cache is older. A
    // failed read returns {} and the viewer is read; the error is not cached, so
    // the next message retries.
    const optedOut = isTwitchViewer && isGloballyOptedOut(viewerGlobalPrefs);
    if (optedOut && !SPOKEN_WHEN_OPTED_OUT.has(type)) {
        logger.debug({ channelName, user, userId, type }, 'Viewer opted out of TTS in every channel - dropping their speech');
        return;
    }
    // `text` never carries the viewer's own words on an announcement. The full
    // utterance comes in textWithViewerMessage and is spoken only for a viewer
    // who did not opt out, so a handler that forgets the field cannot leak them.
    const speechText = !optedOut && typeof eventData.textWithViewerMessage === 'string'
        ? eventData.textWithViewerMessage
        : text;

    // The stored voice can still be a MiniMax ID (before the backfill). The per-voice
    // volume map is keyed by whatever ID the dashboard wrote, so both spellings are tried.
    const storedVoiceId = globalUserPrefs.voiceId || channelUserPrefs.voiceId || channelConfig.voiceId || DEFAULT_TTS_SETTINGS.voiceId;
    const resolvedVoice = resolveVoice(voiceOptions.voiceId || storedVoiceId);
    const voiceVolumes = channelConfig.voiceVolumes || {};
    // The manner that the voice mapping adds for a MiniMax voice. The backfill stores
    // it beside the voice, so it is read from the document that supplied the voice.
    // Before the backfill it comes from the map, through resolveVoice.
    const voiceSource = voiceOptions.voiceId ? {}
        : globalUserPrefs.voiceId ? globalUserPrefs
            : channelUserPrefs.voiceId ? channelUserPrefs
                : channelConfig;
    const storedVoiceStyle = voiceSource.voiceStyle;

    const rawVolume = voiceVolumes[resolvedVoice.voice] || voiceVolumes[storedVoiceId]
        || channelConfig.volume || DEFAULT_TTS_SETTINGS.volume;
    const finalVoiceOptions = {
        speed: (globalUserPrefs.speed ?? channelUserPrefs.speed) ?? channelConfig.speed ?? DEFAULT_TTS_SETTINGS.speed,
        pitch: (globalUserPrefs.pitch ?? channelUserPrefs.pitch) ?? channelConfig.pitch ?? DEFAULT_TTS_SETTINGS.pitch,
        emotion: globalUserPrefs.emotion || channelUserPrefs.emotion || channelConfig.emotion || DEFAULT_TTS_SETTINGS.emotion,
        // A custom style replaces the emotion preset. A viewer who chose an emotion
        // keeps it: the channel's custom style only applies to a viewer with neither.
        style: globalUserPrefs.style || channelUserPrefs.style
            || ((globalUserPrefs.emotion || channelUserPrefs.emotion) ? '' : channelConfig.style) || '',
        voiceStyle: storedVoiceStyle ?? resolvedVoice.voiceStyle,
        // The language that the voice brings (a Cantonese voice, a pt-BR voice). The
        // backfill stores it as voiceLanguage when the new voice is a studio voice,
        // which has no language of its own. An explicit languageBoost wins over it.
        voiceLanguage: voiceSource.voiceLanguage || resolvedVoice.language || null,
        languageBoost: globalUserPrefs.languageBoost || channelUserPrefs.languageBoost || channelConfig.languageBoost || DEFAULT_TTS_SETTINGS.languageBoost,
        volume: Math.min(rawVolume, 2),
        ...voiceOptions, // Allow direct voiceOptions to override
        voiceId: resolvedVoice.voice,
    };

    logger.debug(`[${channelName}] Final voice options for ${user || 'event'}: VoiceID='${finalVoiceOptions.voiceId}', Emotion='${finalVoiceOptions.emotion}', Speed=${finalVoiceOptions.speed}, Pitch=${finalVoiceOptions.pitch}, LanguageBoost='${finalVoiceOptions.languageBoost}'`);

    // Profanity filter (opt-in). This is the last text step, and it runs here
    // rather than in formatTtsText because a viewer can override languageBoost
    // for their own messages and that override is only resolved above. When the
    // viewer's language differs from the channel's, both lists apply — filtering
    // on the channel's alone would let a viewer speaking another one through.
    // Sound tags the channel turned off come out first, so that the profanity
    // filter sees the text as it will be spoken.
    const taggedText = stripDisabledSoundTags(speechText, ttsStatus.disabledSoundTags);
    let finalText = taggedText;
    // English is always in the set, whatever the channel's language. The
    // pronunciation dictionary is English-only and runs for every channel,
    // so "lfg" becomes "let's fucking go" even on a Spanish one. Loading
    // only the Spanish list would send that straight through untouched.
    const profanityRules = ttsStatus.profanityFilterEnabled
        ? getProfanityRules([ttsStatus.languageBoost, finalVoiceOptions.languageBoost, 'English'])
        : null;
    if (profanityRules) {
        finalText = applyRewrites(taggedText, profanityRules);
        if (finalText !== taggedText) {
            logger.debug(`[${channelName}] Profanity filter applied to message from ${user || 'event'}.`);
        }
    }
    // The text shown on the card gets the same filters as the speech.
    const display = cleanDisplay(eventData.display, ttsStatus.disabledSoundTags, profanityRules);

    // A message that was only a disabled sound tag has nothing left to say.
    if (!finalText || !finalText.trim()) {
        logger.debug(`[${channelName}] Nothing left to speak for ${user || 'event'} after the text filters.`);
        return;
    }

    // The timing record travels in the async context up to here and on the queue
    // item from here, since processQueue runs outside the context that enqueued it.
    const timingSnapshot = snapshotTiming();
    const timing = timingSnapshot ? { ...timingSnapshot, enqueueStartMs, enqueuedMs: Date.now() } : null;

    cq.queue.push({
        type, text: finalText, user, userId, voiceConfig: finalVoiceOptions, timestamp: new Date(), sharedSessionInfo, timing,
        // Only when present: Firestore rejects an undefined field when the queue is persisted.
        ...(display ? { display } : {}),
    });
    logger.debug(`[${channelName}] Enqueued TTS for ${user || 'event'}: "${finalText.substring(0, 20)}..." Queue size: ${cq.queue.length}`);
    processQueue(channelName);
}

/** The first `max` code points of a string, with an ellipsis when it was longer. */
function cutCodePoints(text, max) {
    const points = Array.from(text);
    return points.length > max ? `${points.slice(0, max - 1).join('').trimEnd()}…` : text;
}

/**
 * The card data of a queue item, made safe to show: the same sound-tag and
 * profanity rules as the speech, whitespace collapsed, and cut to length. Null when
 * there is no card, an unknown kind, or no text left after the filters; the clip is
 * still spoken then.
 * @param {{kind?: string, user?: string, text?: string}|undefined} display
 * @param {string[]|undefined} disabledSoundTags
 * @param {object|null} profanityRules
 * @returns {{kind: string, user: string, text: string}|null}
 */
function cleanDisplay(display, disabledSoundTags, profanityRules) {
    if (!display || typeof display !== 'object' || !DISPLAY_KINDS.has(display.kind)) return null;
    let text = stripDisabledSoundTags(String(display.text ?? ''), disabledSoundTags);
    if (profanityRules) text = applyRewrites(text, profanityRules);
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) return null;
    const user = String(display.user ?? '').replace(/\s+/g, ' ').trim();
    return {
        kind: display.kind,
        user: cutCodePoints(user, DISPLAY_USER_MAX),
        text: cutCodePoints(text, DISPLAY_TEXT_MAX),
    };
}

/**
 * What generateSpeech needs from a queue item's settings. The settings are stored on
 * the item in their own terms (emotion, speed, pitch), because an item can be persisted
 * and adopted by another instance, and the style is built from them only here.
 */
function speechOptions(voiceConfig) {
    return {
        style: buildStyle(voiceConfig),
        language: localeFromLanguageBoost(voiceConfig.languageBoost) ?? (voiceConfig.voiceLanguage || undefined),
        volume: voiceConfig.volume,
    };
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
function beginChunkedDelivery(targets, event, meta = null) {
    const clip = event.clip;
    if (!clip) return null;

    const clipId = randomUUID();
    const streams = new Map();
    for (const target of targets) {
        // The card data goes out directly before audioStart, to the same sockets
        // (sendClipMeta with streamOnly selects as openClipStream does).
        if (meta) sendClipMeta(target, clipId, meta, { streamOnly: true });
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
 * The card data to send with a clip, or null. Only an item that carries `display`
 * and a channel with spotlightCard on gets one. The label is resolved here, in the
 * channel's language, because the player has no catalogs. The config read is the
 * cached one that enqueue uses.
 */
async function clipMetaFor(channelName, event) {
    if (!event.display) return null;
    const ttsConfig = await getTtsState(channelName);
    if (ttsConfig.spotlightCard !== true) return null;
    const locale = resolveChannelLocale(ttsConfig);
    return { ...event.display, label: getTranslator(locale)('overlay.spotlight.label'), lang: locale };
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
        const clip = createClip();
        event.clip = clip;
        const promise = generateSpeech(event.text, event.voiceConfig.voiceId, {
            ...speechOptions(event.voiceConfig),
            signal: controller.signal,
            onChunk: clip.push,
        }).then(audio => {
            // The provider round trip ends here, not when processQueue gets round
            // to awaiting it — for a clip queued behind a long one the two can be
            // seconds apart, and generateMs must not absorb the queue wait.
            if (event.timing) event.timing.prefetchEndMs = Date.now();
            return audio;
        }).catch(err => {
            // Swallow abort errors; log others as warnings.
            // processQueue will handle the null result gracefully.
            // The slices that arrived before the failure are not a clip. Without
            // this, processQueue sends them to the players and then discards them.
            // A later prefetch of the same item has its own clip, which stays.
            if (event.clip === clip) event.clip = null;
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
        provider: 'gemini',
        model: audio.model ?? null,
        usedFallbackModel: audio.usedFallbackModel ?? null,
        // The provider bills by the length of the audio, so this is the cost figure
        audioSeconds: audio.audioSeconds ?? null,
        style: buildStyle(event.voiceConfig) || null,
        // Twitch -> our webhook (network + any Twitch-side delay)
        twitchToWebhookMs: elapsed(t, 'originMs', 'receivedMs'),
        // Spotlight picks only: chat message to the router's decision. The record of
        // a pick starts at the decision, so this wait is outside totalMs.
        spotlightWaitMs: t.spotlightWaitMs ?? null,
        // Firestore dedup claim before any handling starts
        claimMs: elapsed(t, 'receivedMs', 'claimedMs'),
        // Handler work between receipt and the start of enqueue: config reads,
        // command processing, emote describe, formatting, and the Pub/Sub or
        // inbox hop when the route is 'pubsub' or 'inbox'
        handlerMs: elapsed(t, 'receivedMs', 'enqueueStartMs'),
        pubsubHopMs: elapsed(t, 'publishedMs', 'pubsubReceivedMs'),
        // Webhook forwarded to the channel's owning instance through Firestore
        inboxHopMs: elapsed(t, 'forwardedMs', 'inboxReceivedMs'),
        // Preference lookups and the profanity pass inside enqueue
        enqueueMs: elapsed(t, 'enqueueStartMs', 'enqueuedMs'),
        // Time sat behind earlier items before this one was picked up
        queueWaitMs: elapsed(t, 'enqueuedMs', 'genStartMs'),
        // Provider round trip, from whichever call actually produced the audio. A
        // prefetch that was cancelled leaves its start mark behind, so the flag
        // decides, not the mark.
        generateMs: wasPrefetched
            ? elapsed(t, 'prefetchStartMs', t.prefetchEndMs !== undefined ? 'prefetchEndMs' : 'genEndMs')
            : elapsed(t, 'genStartMs', 'genEndMs'),
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
    cq.currentUserIdSpeaking = event.userId || null;

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
            // The request is already in flight under the prefetch controller. It is
            // adopted as the current one so that `!tts stop` can abort it: the
            // entry has just left prefetchResults, so cancelAllPrefetches no longer
            // sees it, and without this the clip landed and played after the stop.
            controller = prefetched.controller;
            cq.currentSpeechController = controller;
            logger.debug(`[${channelName}] Using prefetched result for "${event.text.substring(0, 30)}..."`);
            promise = prefetched.promise;
        } else {
            // No prefetch available — generate normally with a new controller
            controller = new AbortController();
            cq.currentSpeechController = controller;
            event.clip = createClip();
            promise = generateSpeech(event.text, event.voiceConfig.voiceId, {
                ...speechOptions(event.voiceConfig),
                signal: controller.signal,
                onChunk: event.clip.push,
            });
        }

        // Read when the clip is delivered, never at prefetch: a card shows only
        // while its own clip plays.
        const meta = await clipMetaFor(channelName, event).catch(err => {
            logger.warn({ err, channel: channelName }, 'Could not build the clip card; the clip plays without it');
            return null;
        });

        // Players that can start on a partial clip get the slices as they land —
        // the ones a prefetch already collected go out right now.
        delivery = beginChunkedDelivery(targets, event, meta);

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
            // are excluded from the whole-buffer send below, which carries the same
            // audio as one WAV file to every other player.
            const streamedComplete = delivery && audio.kind === 'buffer';
            if (delivery) delivery.end({ discard: !streamedComplete });
            const wholeClipId = delivery?.clipId ?? randomUUID();
            const sendWhole = target => {
                const exclude = streamedComplete ? delivery.recipientsFor(target) : null;
                if (meta) {
                    // Directly before the WAV frame, to the sockets that get it. A socket
                    // that took the slices is excluded, and so is one that was sent this
                    // meta before a stream that was then discarded: each socket gets the
                    // meta once.
                    const metaExclude = new Set([...(exclude || []), ...(delivery?.recipientsFor(target) || [])]);
                    sendClipMeta(target, wholeClipId, meta, { exclude: metaExclude });
                }
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
            cq.currentUserIdSpeaking = null;
        }

        cq.isProcessing = false;

        if (!cq.isPaused && cq.queue.length > 0) {
            setImmediate(() => processQueue(channelName));
        } else if (!cq.isPaused && cq.queue.length === 0) {
            // Queue is empty.
            // If currentSpeech is null (last item failed/aborted), currentUserSpeaking should also be null.
            if (!cq.currentSpeech) {
                cq.currentUserSpeaking = null;
                cq.currentUserIdSpeaking = null;
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
        cq.currentUserIdSpeaking = null;
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
 * Queue items as plain data, for Firestore or the channel inbox. `clip` and
 * `timing` are runtime-only: the clip holds a listener Set and a function, which
 * Firestore rejects, and a timing record carried across a restart or a handover
 * would report the gap as queue wait.
 * @param {object[]} queue
 * @returns {object[]}
 */
function serializeQueueItems(queue) {
    return queue.map(({ clip: _clip, timing: _timing, ...item }) => ({
        ...item,
        timestamp: item.timestamp instanceof Date ? item.timestamp.toISOString() : item.timestamp
    }));
}

/**
 * Inverse of serializeQueueItems.
 * @param {object[]} items
 * @returns {object[]}
 */
function deserializeQueueItems(items) {
    return items.map(item => ({
        ...item,
        timing: null,
        clip: undefined,
        timestamp: typeof item.timestamp === 'string' ? new Date(item.timestamp) : item.timestamp
    }));
}

/**
 * Empties a channel's queue for handing to the instance that now owns the
 * channel (see channelOwnership.js). The clip already playing or generating is
 * left alone: its audio is bound for this instance's browser source, if any.
 * The login travels with the clips: the receiving instance's allow-list may not
 * map the broadcaster ID yet, and a queue adopted under the numeric ID would
 * never match the browser source, which registers under the login.
 * @param {string} channelName
 * @returns {{channelName: string, items: object[], isPaused: boolean}|null} Null when there is nothing to hand on.
 */
export function takeQueueForHandoff(channelName) {
    const name = resolveToChannelName(channelName);
    const cq = channelQueues.get(name);
    if (!cq || (cq.queue.length === 0 && !cq.isPaused)) return null;
    const handoff = { channelName: name, items: serializeQueueItems(cq.queue), isPaused: cq.isPaused };
    cq.queue = [];
    cq.isPaused = false;
    cancelAllPrefetches(name);
    return handoff;
}

/**
 * Takes on clips another instance queued for this channel before it lost it.
 * They were queued earlier than anything queued here since, so they go first.
 * A pause travels with them: it was a moderator's instruction, not an
 * instance's state.
 * @param {string} channelName
 * @param {{items?: object[], isPaused?: boolean}} handoff
 */
export function adoptQueue(channelName, { items = [], isPaused = false } = {}) {
    const cq = getOrCreateChannelQueue(channelName);
    const combined = [...deserializeQueueItems(items), ...cq.queue];
    if (combined.length > MAX_QUEUE_LENGTH) {
        logger.warn({ channel: channelName, dropped: combined.length - MAX_QUEUE_LENGTH }, 'Adopted TTS queue exceeds the limit; dropping the newest items');
    }
    cq.queue = combined.slice(0, MAX_QUEUE_LENGTH);
    if (isPaused) cq.isPaused = true;
    logger.info({ channel: channelName, adopted: items.length, queueLength: cq.queue.length, isPaused: cq.isPaused }, 'Adopted TTS queue from another instance');
    processQueue(channelName);
}

/**
 * Restores one channel's queue persisted by persistAllQueues, if any. Called when
 * this instance takes the channel over, so a queue saved at shutdown lands on the
 * instance holding the browser source rather than whichever one started first.
 * @param {string} broadcasterId
 */
export async function restoreQueue(broadcasterId) {
    if (!db) db = new Firestore();
    const ref = db.collection(TTS_QUEUE_PERSISTENCE_COLLECTION).doc(String(broadcasterId));
    const data = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return null;
        tx.delete(ref);
        return snap.data();
    });
    if (!data?.queue?.length && !data?.isPaused) return;
    const channelName = getChannelNameFromId(broadcasterId) || data.channelName;
    adoptQueue(channelName, { items: data.queue || [], isPaused: !!data.isPaused });
}

/**
 * Names of channels with clips waiting in this instance's queues.
 * @returns {string[]}
 */
export function getChannelsWithPendingQueue() {
    return [...channelQueues.entries()]
        .filter(([, cq]) => cq.queue.length > 0 || cq.isPaused)
        .map(([name]) => name);
}

/**
 * Persist all TTS queues to Firestore to prevent message loss during shutdown
 * Only persists pending items, not currently processing item
 * @param {{deleteEmpty?: boolean}} [opts] - deleteEmpty: remove the doc of a
 *   channel whose queue is empty here. Off when channel ownership is on.
 */
export async function persistAllQueues({ deleteEmpty = true } = {}) {
    if (!db) db = new Firestore();

    const persistenceTasks = [];
    let totalPersisted = 0;

    for (const [channelName, cq] of channelQueues.entries()) {
        // Keyed by broadcaster ID so a rename across the restart cannot orphan the queue.
        const channelId = getChannelIdFromName(channelName);
        if (!channelId) {
            if (cq.queue.length > 0) {
                logger.warn({ channel: channelName, pending: cq.queue.length }, 'No Twitch user ID known for channel; not persisting its TTS queue');
            }
            continue;
        }
        const docRef = db.collection(TTS_QUEUE_PERSISTENCE_COLLECTION).doc(channelId);

        if (cq.queue.length === 0) {
            // With channel ownership on, another instance may have just written
            // this channel's doc; an empty queue here says nothing about it.
            if (!deleteEmpty) continue;
            // No pending items, delete persistence doc if it exists
            persistenceTasks.push(
                docRef.delete()
                    .catch(err => {
                        if (err.code !== 5) { // Ignore "NOT_FOUND" errors (code 5)
                            logger.warn({ err, channel: channelName }, 'Failed to delete empty queue persistence doc');
                        }
                    })
            );
            continue;
        }

        const serializedQueue = serializeQueueItems(cq.queue);

        totalPersisted += cq.queue.length;

        persistenceTasks.push(
            docRef.set({
                channelName, // Display only; the document ID is the key
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
 * Restore TTS queues from Firestore after startup. Only with channel ownership
 * off; with it on, each queue is restored by the instance that takes the
 * channel (restoreQueue). Call this after the channel manager has loaded the allow-list (persisted queues
 * are keyed by broadcaster ID, mapped back to a login through it) and before
 * processing new messages.
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
            const { queue, isPaused } = data;
            // The login may have changed since the queue was persisted.
            const channelName = getChannelNameFromId(doc.id) || data.channelName;

            if (!queue || queue.length === 0) {
                logger.debug(`[${channelName}] Persisted queue was empty, skipping restore.`);
                deleteTasks.push(doc.ref.delete());
                return;
            }

            const restoredQueue = deserializeQueueItems(queue);

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