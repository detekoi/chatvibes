// src/lib/channelInbox.js
// Hands work to the instance that owns a channel (channelOwnership.js).
//
// Two kinds of event travel through it:
//   'notification'  an EventSub webhook that Twitch delivered to an instance
//                   other than the owner, forwarded after its dedup claim
//   'queueHandoff'  the pending clips of an instance that just lost the channel
//
// Layout: channelInbox/{broadcasterId}/inboxEvents/{messageId}
//   { kind, payload, isChat, timing, targetOwner, fromInstance, enqueuedAt, expiresAt }
//
// Keying a notification by its EventSub message ID makes a retried delivery
// overwrite rather than duplicate. The owner claims each document by deleting it
// in a transaction before acting, so an event is processed at most once even
// while ownership is changing hands. Events that arrive while the channel has no
// owner wait for the next one and are picked up in its listener's first
// snapshot, unless they are too old by then. `expiresAt` wants a Firestore TTL
// policy to reap events whose channel never got an owner.

import { Firestore } from '@google-cloud/firestore';
import logger from './logger.js';
import { INSTANCE_ID } from './instanceId.js';
import { ownsBroadcaster } from './channelOwnership.js';

const INBOX_COLLECTION = 'channelInbox';
const EVENTS_SUBCOLLECTION = 'inboxEvents';

// A chat message read out this late is a non sequitur; other events (subs,
// raids, a handed-over queue) still matter a while longer.
export const MAX_CHAT_AGE_MS = 2 * 60 * 1000;
export const MAX_EVENT_AGE_MS = 10 * 60 * 1000;
const DOC_TTL_MS = 60 * 60 * 1000;

function toMillis(value) {
    if (!value) return 0;
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (value instanceof Date) return value.getTime();
    return Number(value) || 0;
}

/**
 * @param {object} opts
 * @param {() => FirebaseFirestore.Firestore} opts.getDb
 * @param {string} opts.instanceId
 * @param {(broadcasterId: string) => boolean} opts.ownsBroadcaster
 * @param {() => number} [opts.now]
 */
export function createChannelInbox({ getDb, instanceId, ownsBroadcaster: owns, now = Date.now }) {
    // broadcasterId -> { unsubscribe, chain }
    const inboxes = new Map();

    const eventsCollection = broadcasterId =>
        getDb().collection(INBOX_COLLECTION).doc(String(broadcasterId)).collection(EVENTS_SUBCOLLECTION);

    /**
     * Queues an event for the channel's owner.
     * @param {string} broadcasterId
     * @param {object} event
     * @param {string} event.messageId - Document ID; the EventSub message ID for a notification.
     * @param {'notification'|'queueHandoff'} [event.kind]
     * @param {string} event.payload - JSON text.
     * @param {boolean} [event.isChat]
     * @param {object|null} [event.timing] - TTS_TIMING record to resume on the owner.
     * @param {string|null} [event.targetOwner] - Instance that held the lease when forwarded.
     */
    async function forwardToInbox(broadcasterId, { messageId, kind = 'notification', payload, isChat = false, timing = null, targetOwner = null }) {
        const t = now();
        const docId = String(messageId).replace(/\//g, '_');
        await eventsCollection(broadcasterId).doc(docId).set({
            kind,
            payload,
            isChat: !!isChat,
            timing: timing ? { ...timing, forwardedMs: t } : null,
            targetOwner,
            fromInstance: instanceId,
            enqueuedAt: new Date(t),
            expiresAt: new Date(t + DOC_TTL_MS),
        });
    }

    async function consume(broadcasterId, ref, handler) {
        // The listener is torn down when ownership goes, but a snapshot can land in
        // between. Leave the event for whoever owns the channel now.
        if (!owns(broadcasterId)) return;

        const data = await getDb().runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            if (!snap.exists) return null;
            tx.delete(ref);
            return snap.data();
        });
        if (!data) return;

        const ageMs = now() - toMillis(data.enqueuedAt);
        if (ageMs > (data.isChat ? MAX_CHAT_AGE_MS : MAX_EVENT_AGE_MS)) {
            logger.warn({ broadcasterId, messageId: ref.id, kind: data.kind, ageMs }, '[ChannelInbox] Dropping stale forwarded event');
            return;
        }

        let payload;
        try {
            payload = JSON.parse(data.payload);
        } catch (err) {
            logger.error({ err, broadcasterId, messageId: ref.id }, '[ChannelInbox] Forwarded event is not valid JSON');
            return;
        }

        logger.debug({ broadcasterId, messageId: ref.id, kind: data.kind, fromInstance: data.fromInstance, ageMs },
            '[ChannelInbox] Processing forwarded event');

        // Claimed in arrival order, but handled concurrently the way direct
        // webhooks are: a slow emote description must not hold up the next message.
        Promise.resolve()
            .then(() => handler({
                kind: data.kind || 'notification',
                messageId: ref.id,
                payload,
                timing: data.timing || null,
                fromInstance: data.fromInstance,
            }))
            .catch(err => logger.error({ err, broadcasterId, messageId: ref.id }, '[ChannelInbox] Handler failed'));
    }

    /**
     * Starts processing a channel's inbox. Events already waiting arrive in the
     * listener's first snapshot.
     * @param {string} broadcasterId
     * @param {(event: {kind: string, messageId: string, payload: object, timing: object|null, fromInstance: string}) => Promise<void>} handler
     */
    function startInbox(broadcasterId, handler) {
        const id = String(broadcasterId);
        if (inboxes.has(id)) return;

        const entry = { chain: Promise.resolve(), unsubscribe: null };
        inboxes.set(id, entry);
        entry.unsubscribe = eventsCollection(id)
            .orderBy('enqueuedAt')
            .onSnapshot(snapshot => {
                for (const change of snapshot.docChanges()) {
                    if (change.type !== 'added') continue;
                    const ref = change.doc.ref;
                    entry.chain = entry.chain
                        .then(() => consume(id, ref, handler))
                        .catch(err => logger.error({ err, broadcasterId: id, messageId: ref.id }, '[ChannelInbox] Failed to claim event'));
                }
            }, err => {
                logger.error({ err, broadcasterId: id }, '[ChannelInbox] Inbox listener error');
                // A failed listener is dead. Forget it, so the next acquire of
                // this channel starts a fresh one instead of finding it "running".
                if (inboxes.get(id) === entry) inboxes.delete(id);
            });
        logger.debug({ broadcasterId: id }, '[ChannelInbox] Listening');
    }

    /** @param {string} broadcasterId */
    function stopInbox(broadcasterId) {
        const id = String(broadcasterId);
        const entry = inboxes.get(id);
        if (!entry) return;
        inboxes.delete(id);
        try {
            entry.unsubscribe?.();
        } catch (err) {
            logger.warn({ err, broadcasterId: id }, '[ChannelInbox] Error stopping listener');
        }
    }

    function stopAllInboxes() {
        for (const id of [...inboxes.keys()]) stopInbox(id);
    }

    return { forwardToInbox, startInbox, stopInbox, stopAllInboxes, _inboxes: inboxes };
}

let db;
const defaultInbox = createChannelInbox({
    getDb: () => {
        if (!db) db = new Firestore();
        return db;
    },
    instanceId: INSTANCE_ID,
    ownsBroadcaster,
});

export const { forwardToInbox, startInbox, stopInbox, stopAllInboxes } = defaultInbox;
