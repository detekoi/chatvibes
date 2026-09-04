// src/lib/ttsTiming.js
// Per-message timing record, carried through the async context from the moment a
// message arrives until its audio leaves over the WebSocket.
//
// AsyncLocalStorage is used rather than a parameter because the record has to cross
// the webhook router, the chat handler, the command processor, the dispatcher and
// the queue, none of which should know about it. The record is a plain object of
// epoch-millisecond marks plus a couple of labels; ttsQueue copies it onto the
// queue item at enqueue time and emits one TTS_TIMING log line per clip sent.
//
// Marks (all epoch ms):
//   originMs          when Twitch stamped the EventSub message (its own clock)
//   receivedMs        when the webhook / proxy message reached this process
//   claimedMs         when the cross-instance dedup claim came back
//   publishedMs       when the event went out over Pub/Sub (Pub/Sub route only)
//   pubsubReceivedMs  when the serving instance got it back (Pub/Sub route only)
//   firstChunkSentMs  when the first audio slice went out to a chunked player
//                     (set by ttsQueue on the queue item's copy, not in the context)
// Labels:
//   source            'eventsub' | 'youtube'
//   route             'local' | 'pubsub'
//
// A message that arrives outside any context (a queue restored from Firestore,
// a test that calls enqueue directly) simply carries no record and logs nothing.

import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

/**
 * Run fn with a fresh timing record bound to the async context.
 * @param {object} timing - Initial marks and labels.
 * @param {() => any} fn
 */
export function runWithTiming(timing, fn) {
    return storage.run({ ...timing }, fn);
}

/** The record for the current async context, or null outside one. */
export function currentTiming() {
    return storage.getStore() ?? null;
}

/**
 * Set one field on the current record. No-op outside a context.
 * @param {string} field
 * @param {*} [value] - Defaults to Date.now().
 */
export function markTiming(field, value = Date.now()) {
    const timing = storage.getStore();
    if (timing) timing[field] = value;
    return timing ?? null;
}

/** A detached copy of the current record, safe to serialize. Null outside a context. */
export function snapshotTiming() {
    const timing = storage.getStore();
    return timing ? { ...timing } : null;
}

/**
 * Milliseconds between two marks on a record, or null if either is missing.
 * @param {object|null} timing
 * @param {string} from
 * @param {string} to
 */
export function elapsed(timing, from, to) {
    const a = timing?.[from];
    const b = timing?.[to];
    return Number.isFinite(a) && Number.isFinite(b) ? b - a : null;
}
