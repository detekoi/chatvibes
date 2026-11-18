// src/lib/spotlight/spotlightLog.js
// The pick log the dashboard shows: the last picks of the spotlight router.
//
// One document per channel, ttsSpotlightLog/<broadcasterId>, with a `picks` array,
// newest last, at most MAX_PICKS long. Each entry is
//   { user, userId: string|null, text, reason, at: epoch ms, platform: 'twitch'|'youtube' }
// The dashboard reads this shape (chatvibes-web-ui), so change both together.
//
// Only the channel's owner writes it (the buffer runs only there), and the writes of
// one channel run one after another, so the transaction does not contend. A failed
// write logs a warning and never holds back speech.

import { Firestore, FieldValue } from '@google-cloud/firestore';
import logger from '../logger.js';

const COLLECTION = 'ttsSpotlightLog';
const MAX_PICKS = 30;
const MAX_TEXT_LENGTH = 500;

let db;
const chains = new Map();

async function write(broadcasterId, entry) {
    if (!db) db = new Firestore();
    const ref = db.collection(COLLECTION).doc(String(broadcasterId));
    await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const previous = snap.exists && Array.isArray(snap.data()?.picks) ? snap.data().picks : [];
        const picks = [...previous, entry].slice(-MAX_PICKS);
        tx.set(ref, { picks, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    });
}

/**
 * Append one pick to the channel's log. Fire-and-forget: the promise always resolves.
 * @param {string} broadcasterId
 * @param {{user: string, userId?: string|null, text: string, reason?: string, at?: number, platform?: string}} pick
 * @returns {Promise<void>}
 */
export function recordPick(broadcasterId, { user, userId, text, reason, at, platform }) {
    if (!broadcasterId) return Promise.resolve();
    const entry = {
        user: String(user || ''),
        userId: userId ? String(userId) : null,
        text: String(text || '').slice(0, MAX_TEXT_LENGTH),
        reason: String(reason || ''),
        at: Number.isFinite(at) ? at : Date.now(),
        platform: platform === 'youtube' ? 'youtube' : 'twitch',
    };
    const key = String(broadcasterId);
    const next = (chains.get(key) || Promise.resolve())
        .then(() => write(key, entry))
        .catch(err => logger.warn({ err, broadcasterId: key }, 'Could not write the spotlight pick log'));
    chains.set(key, next);
    // Forget the chain once it is idle, so the map does not grow with every channel.
    next.then(() => { if (chains.get(key) === next) chains.delete(key); });
    return next;
}
