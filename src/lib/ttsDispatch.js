// src/lib/ttsDispatch.js
// Chooses how a TTS event reaches the queue: straight into the local queue, or out
// over Pub/Sub to whichever instance is holding the listener's browser source.
//
// Pub/Sub exists because the instance that receives a Twitch webhook is not
// necessarily the one holding the OBS WebSocket — Cloud Run may be running several.
// But when it *is* the same instance, and with --session-affinity it often is,
// publishing means a full publish + delivery round trip to reach a function in the
// same process. That round trip is pure latency on the path a viewer actually hears.
//
// Deliberately kept out of lib/pubsub.js: that module is the Pub/Sub transport and
// must not depend on the TTS queue.

import crypto from 'crypto';
import { Firestore, Timestamp } from '@google-cloud/firestore';
import logger from './logger.js';
import { INSTANCE_ID } from './instanceId.js';
import { publishTtsEvent } from './pubsub.js';
import { hasActiveClients } from '../components/web/server.js';
import * as ttsQueue from '../components/tts/ttsQueue.js';
import { claimOnce } from './firestoreClaim.js';
import { markTiming } from './ttsTiming.js';

let db;
const YT_CLAIM_COLLECTION = 'processedYouTubeMessages';
const YT_CLAIM_TTL_MS = 10 * 60 * 1000; // 10 minutes, matching the EventSub window

// How long an instance with no browser source for the channel waits before trying to
// claim. Every instance receives every message from the chat proxy, so without this
// the winner is a coin toss and only 1-in-N messages would take the local path.
// Giving the instance that can actually play the audio a head start makes it win.
const YT_CLAIM_HANDICAP_MS = 300;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * True if this instance holds a browser source for the channel, or for any channel
 * participating in the shared-chat session.
 */
function servesLocally(channelName, sharedSessionInfo) {
    if (hasActiveClients(channelName)) return true;
    const shared = sharedSessionInfo?.channels;
    return Array.isArray(shared) && shared.some(ch => hasActiveClients(ch));
}

/**
 * Route a TTS event to the queue, locally when possible and via Pub/Sub otherwise.
 *
 * The local path needs no deduplication. Every caller sits downstream of a claim that
 * has already admitted this message exactly once across instances — shouldProcessEvent
 * in eventsub.js for Twitch, dispatchYouTubeTtsEvent below for YouTube — so the
 * Firestore claim guarding the Pub/Sub path would be re-deduplicating an event that
 * cannot arrive twice. Anything routed here without such an upstream claim would be
 * enqueued once per instance.
 *
 * @param {string} channelName
 * @param {object} eventData - { text, user, userId, type, messageId }
 * @param {object|null} [sharedSessionInfo]
 */
export async function dispatchTtsEvent(channelName, eventData, sharedSessionInfo = null) {
    if (servesLocally(channelName, sharedSessionInfo)) {
        logger.debug(
            { channel: channelName, user: eventData?.user, messageId: eventData?.messageId || 'N/A' },
            'Serving TTS event locally, bypassing Pub/Sub'
        );
        markTiming('route', 'local');
        await ttsQueue.enqueue(channelName, eventData, sharedSessionInfo);
        return;
    }

    await publishTtsEvent(channelName, eventData, sharedSessionInfo);
}

/**
 * Route a YouTube chat event, claiming it first so it is spoken exactly once.
 *
 * YouTube needs its own claim because the chat proxy broadcasts each message to every
 * subscribed client (internal/hub/hub.go, Hub.Broadcast), so all instances see it —
 * unlike a Twitch webhook, which arrives at one instance and is claimed there. The
 * proxy's normalised message carries YouTube's own `id`, which is stable across
 * instances and is what makes it usable as a claim key.
 *
 * Claiming here rather than after the Pub/Sub hop is what lets YouTube use the local
 * path at all. The handicap then decides *which* instance wins: the one holding the
 * browser source goes first, so the winner is usually the instance that can play the
 * audio without a round trip. When it is not, this degrades to publishing, exactly as
 * before.
 *
 * @param {string} channelId - Twitch channel ID the YouTube chat is bound to.
 * @param {object} eventData - { text, user, userId, type, messageId, platform }
 * @returns {Promise<boolean>} false if another instance had already claimed it.
 */
export async function dispatchYouTubeTtsEvent(channelId, eventData) {
    if (!channelId) return false;

    const messageId = eventData?.messageId;
    // Without YouTube's id there is no stable key, so fall back to the content the way
    // the Pub/Sub claim does. Publishing unclaimed instead would have every instance
    // publish its own copy of the same message, since the proxy broadcasts to all of
    // them — the downstream claim would still collapse it to one spoken clip, but only
    // after N trips through Pub/Sub.
    const claimKey = messageId
        ? `${channelId}|${messageId}`
        : `${channelId}|${crypto.createHash('sha256')
            .update(`${(eventData?.user || '').toLowerCase()}|${(eventData?.text || '').trim()}`)
            .digest('hex')}`;

    if (!messageId) {
        logger.warn({ channelId }, 'YouTube event has no message id; claiming on its content instead');
    }

    const servesHere = hasActiveClients(channelId);
    if (!servesHere) await sleep(YT_CLAIM_HANDICAP_MS);

    if (!db) db = new Firestore();
    const now = Date.now();
    const docRef = db.collection(YT_CLAIM_COLLECTION).doc(claimKey);

    const claimed = await claimOnce(docRef, {
        channel: channelId,
        messageId: messageId || null,
        instance: INSTANCE_ID,
        createdAtMs: now,
        expireAt: Timestamp.fromMillis(now + YT_CLAIM_TTL_MS),
    }, now, { channel: channelId, messageId: messageId || 'N/A', platform: 'youtube' });

    if (!claimed) return false;
    markTiming('claimedMs');

    // Re-check rather than reusing servesHere: a browser source may have connected
    // during the handicap wait, and enqueueing locally is still the cheaper route.
    await dispatchTtsEvent(channelId, eventData, null);
    return true;
}
