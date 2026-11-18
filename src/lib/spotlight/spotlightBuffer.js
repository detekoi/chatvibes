// src/lib/spotlight/spotlightBuffer.js
// Spotlight mode: chat is collected per channel and sent to the router in batches.
// The router picks the few messages worth reading aloud, and only those are spoken.
//
// A batch goes out windowMs after its first candidate arrives, or at once when
// maxBatch candidates are waiting. One router call runs per channel at a time;
// candidates that arrive during a call wait for the next batch. The buffer keeps at
// most maxBuffered candidates and drops the oldest. The last contextSize messages
// that were sent to the router go with the next call as context, so the model can
// see repeats and running jokes. All limits come from config.spotlight.
//
// The buffer holds state that only the channel's owner has whole (docs/multi-
// instance.md), so it accepts and flushes only where ownsBroadcaster() is true, and
// a channel's buffer is dropped when this instance loses the channel. A handover
// loses at most one window of candidates.
//
// Nothing is formatted before a pick: the caller hands over the clean text and a
// `speak` closure, and the closure does the formatting (emote descriptions are a
// model call) only for a message the router picked.
//
// Timing: the flush runs from a timer, which carries the async context of whichever
// message started the window. Each pick therefore gets a fresh TTS_TIMING record,
// with route 'spotlight' and receivedMs at the pick decision, so the router wait
// does not count as speech latency. spotlightWaitMs on the record is the time from
// the chat message to the decision.

import config from '../../config/index.js';
import logger from '../logger.js';
import { ownsBroadcaster, onOwnershipChange } from '../channelOwnership.js';
import { getTtsState } from '../../components/tts/ttsState.js';
import { resolveChannelLocale, languageNameForLocale } from '../../i18n/index.js';
import { runWithTiming } from '../ttsTiming.js';
import { pickNotable } from './spotlightRouter.js';
import { recordPick } from './spotlightLog.js';

// An idle channel keeps its context this long, then its entry is deleted.
const IDLE_MS = 5 * 60 * 1000;
const HAS_WORD = /[\p{L}\p{N}]/u;

const channels = new Map();
let unsubscribeOwnership = null;

/**
 * @typedef {object} SpotlightCandidate
 * @property {string} broadcasterId Twitch channel ID; a YouTube message uses the bound Twitch channel.
 * @property {string} channelName Twitch login (or the ID when no login is known); used to read the config.
 * @property {string|null} [id] Platform message ID.
 * @property {string} user Display name, sent to the router and written to the pick log.
 * @property {string|null} [userId] Platform account ID.
 * @property {string} text Clean message text, not formatted.
 * @property {'twitch'|'youtube'} platform
 * @property {(pick: {reason: string}) => Promise<boolean>} speak Formats and dispatches the
 *   message as a spotlight clip. Resolves true when something was dispatched.
 */

function entryFor(broadcasterId, channelName) {
    let entry = channels.get(broadcasterId);
    if (!entry) {
        entry = { broadcasterId, channelName, pending: [], context: [], timer: null, idleTimer: null, inFlight: false };
        channels.set(broadcasterId, entry);
    }
    entry.channelName = channelName || entry.channelName;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    return entry;
}

function arm(entry, ms) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => { entry.timer = null; void flush(entry.broadcasterId); }, Math.max(0, ms));
    entry.timer.unref?.();
}

function armIdle(entry) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
        if (channels.get(entry.broadcasterId) === entry && !entry.pending.length && !entry.inFlight) {
            channels.delete(entry.broadcasterId);
        }
    }, IDLE_MS);
    entry.idleTimer.unref?.();
}

function remember(entry, batch) {
    const { contextSize } = config.spotlight;
    entry.context.push(...batch.map(c => ({ user: c.user, text: c.text })));
    if (entry.context.length > contextSize) entry.context.splice(0, entry.context.length - contextSize);
}

/** After a call, or after a discarded batch: send what waits, or go idle. */
function schedule(entry) {
    if (channels.get(entry.broadcasterId) !== entry) return;
    if (!entry.pending.length) { armIdle(entry); return; }
    const { windowMs, maxBatch } = config.spotlight;
    const waited = Date.now() - entry.pending[0].at;
    if (entry.pending.length >= maxBatch || waited >= windowMs) void flush(entry.broadcasterId);
    else arm(entry, windowMs - waited);
}

/**
 * Hand a chat message to the channel's buffer.
 * @param {SpotlightCandidate} candidate
 * @returns {boolean} true when the message was buffered.
 */
export function offerSpotlightCandidate(candidate) {
    const broadcasterId = candidate?.broadcasterId ? String(candidate.broadcasterId) : null;
    if (!broadcasterId || typeof candidate.speak !== 'function') return false;
    if (!ownsBroadcaster(broadcasterId)) return false;
    const text = String(candidate.text || '').trim();
    // Emote-only and punctuation-only messages are never worth a router call.
    if (!HAS_WORD.test(text)) return false;

    const { maxBatch, maxBuffered, windowMs } = config.spotlight;
    const entry = entryFor(broadcasterId, candidate.channelName);
    entry.pending.push({
        id: candidate.id ?? null,
        user: String(candidate.user || ''),
        userId: candidate.userId ?? null,
        text,
        platform: candidate.platform === 'youtube' ? 'youtube' : 'twitch',
        speak: candidate.speak,
        at: Date.now(),
    });
    if (entry.pending.length > maxBuffered) {
        entry.pending.splice(0, entry.pending.length - maxBuffered);
        logger.debug({ broadcasterId, maxBuffered }, 'Spotlight buffer full; dropped the oldest candidate');
    }
    if (entry.inFlight) return true;
    if (entry.pending.length >= maxBatch) {
        clearTimeout(entry.timer);
        entry.timer = null;
        void flush(broadcasterId);
    } else if (!entry.timer) {
        arm(entry, windowMs);
    }
    return true;
}

async function speakPicks(entry, batch, picks) {
    const { maxAgeMs } = config.spotlight;
    const decidedAt = Date.now();
    const byLabel = new Map(batch.map((c, i) => [`m${i + 1}`, { candidate: c, index: i }]));
    const chosen = picks
        .map(p => ({ ...byLabel.get(p.id), reason: p.reason }))
        .filter(p => p.candidate)
        .sort((a, b) => a.index - b.index);

    for (const { candidate, reason } of chosen) {
        if (decidedAt - candidate.at > maxAgeMs) {
            logger.debug({ broadcasterId: entry.broadcasterId, ageMs: decidedAt - candidate.at }, 'Spotlight pick is too old; not spoken');
            continue;
        }
        try {
            const dispatched = await runWithTiming({
                source: candidate.platform === 'youtube' ? 'youtube' : 'eventsub',
                route: 'spotlight',
                receivedMs: Date.now(),
                spotlightWaitMs: decidedAt - candidate.at,
            }, () => candidate.speak({ reason }));
            if (dispatched) {
                void recordPick(entry.broadcasterId, {
                    user: candidate.user, userId: candidate.userId, text: candidate.text,
                    reason, at: Date.now(), platform: candidate.platform,
                });
            }
        } catch (err) {
            logger.warn({ err, broadcasterId: entry.broadcasterId }, 'Could not speak a spotlight pick');
        }
    }
}

async function flush(broadcasterId) {
    const entry = channels.get(broadcasterId);
    if (!entry || entry.inFlight || !entry.pending.length) return;
    clearTimeout(entry.timer);
    entry.timer = null;
    if (!ownsBroadcaster(broadcasterId)) {
        dropSpotlightChannel(broadcasterId);
        return;
    }

    const { maxBatch } = config.spotlight;
    const batch = entry.pending.splice(0, maxBatch);
    entry.inFlight = true;
    try {
        // Read again at flush time: the mode or the engine may have changed during the window.
        const ttsConfig = await getTtsState(entry.channelName || broadcasterId);
        if (ttsConfig.mode !== 'spotlight' || !ttsConfig.engineEnabled) {
            logger.debug({ broadcasterId, mode: ttsConfig.mode, engineEnabled: ttsConfig.engineEnabled }, 'Spotlight batch discarded; the channel is no longer in spotlight mode');
            entry.pending.length = 0;
            return;
        }
        const context = entry.context.slice();
        const picks = await pickNotable({
            candidates: batch.map((c, i) => ({ id: `m${i + 1}`, user: c.user, text: c.text })),
            context,
            guidance: ttsConfig.spotlightGuidance || null,
            language: languageNameForLocale(resolveChannelLocale(ttsConfig)) || 'English',
            channel: entry.channelName,
        });
        remember(entry, batch);
        // The channel may have been dropped (ownership lost) while the router worked.
        if (channels.get(broadcasterId) !== entry || !ownsBroadcaster(broadcasterId)) return;
        if (picks?.length) await speakPicks(entry, batch, picks);
    } catch (err) {
        logger.warn({ err, broadcasterId }, 'Spotlight batch failed');
    } finally {
        entry.inFlight = false;
        schedule(entry);
    }
}

/** Forget a channel's buffer, its timers and its context. */
function dropSpotlightChannel(broadcasterId) {
    const key = String(broadcasterId);
    const entry = channels.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    clearTimeout(entry.idleTimer);
    entry.pending.length = 0;
    channels.delete(key);
}

/**
 * Drop a channel's buffer when this instance loses the channel. Called once at
 * startup, beside wireChannelHandover. With ownership off no change is ever
 * announced, and every instance counts as the owner of every channel.
 */
export function wireSpotlightOwnership() {
    if (unsubscribeOwnership) return;
    unsubscribeOwnership = onOwnershipChange(({ type, broadcasterId }) => {
        if (type === 'lost') dropSpotlightChannel(broadcasterId);
    });
}

export const _internals = {
    channels,
    flush,
    reset() {
        for (const key of [...channels.keys()]) dropSpotlightChannel(key);
        unsubscribeOwnership?.();
        unsubscribeOwnership = null;
    },
};
