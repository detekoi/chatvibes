// src/lib/firestoreClaim.js
// Shared helpers for the "claim this ID exactly once, across instances" pattern used
// by the EventSub webhook dedup, the Pub/Sub TTS dedup, and the YouTube chat dedup.

import { Timestamp } from '@google-cloud/firestore';
import logger from './logger.js';

// gRPC status code returned by Firestore's create() when the document is already
// there. https://grpc.github.io/grpc/core/md_doc_statuscodes.html
export const ALREADY_EXISTS = 6;

/**
 * Whether an existing claim document has lapsed and may be re-claimed.
 *
 * Firestore TTL policies delete on a best-effort basis within 24 hours, so a
 * document routinely outlives its own expireAt. Treating "document present" as
 * "still claimed" would therefore block a key long after its dedup window closed.
 *
 * Reads both the current `expireAt` Timestamp and the legacy `expireAtMs` number.
 * A document carrying neither is treated as expired: it predates both formats, so
 * there is no window left to honour.
 *
 * @param {object} data - The claim document's data.
 * @param {number} now - Current time in epoch milliseconds.
 * @returns {boolean}
 */
export function isClaimExpired(data, now) {
    if (data?.expireAt instanceof Timestamp) {
        return data.expireAt.toMillis() <= now;
    }
    if (typeof data?.expireAtMs === 'number') {
        return data.expireAtMs <= now;
    }
    return true;
}

/**
 * Claim a key exactly once across instances, within a TTL window.
 *
 * create() is one round trip and fails atomically when the key is taken, so only a
 * genuine duplicate pays the follow-up read. That read is not optional: Firestore TTL
 * deletion is best-effort within 24 hours, so a lapsed claim document routinely
 * outlives its own expireAt and would otherwise block its key indefinitely.
 *
 * Fails open on any transport error — losing a message is worse than speaking it twice.
 *
 * @param {FirebaseFirestore.DocumentReference} docRef
 * @param {object} payload - Written on a successful claim; must include expireAt.
 * @param {number} now - Current time in epoch milliseconds.
 * @param {object} [logContext] - Merged into the log line when a duplicate is refused.
 * @returns {Promise<boolean>} true if this caller may proceed.
 */
export async function claimOnce(docRef, payload, now, logContext = {}) {
    try {
        await docRef.create(payload);
        return true;
    } catch (err) {
        if (err.code !== ALREADY_EXISTS) {
            logger.warn({ err, ...logContext }, 'Claim failed; proceeding without dedupe');
            return true;
        }
    }

    // The key is taken. Re-claiming a lapsed document has to be atomic: a plain
    // read-then-write would let two instances both observe the same expired claim and
    // both proceed, which is the one thing this function exists to prevent. That is
    // why the whole operation used to be a transaction. Only this branch needs to
    // be — it runs solely for duplicates, so the common path keeps its single
    // round trip while the guarantee is unchanged.
    try {
        return await docRef.firestore.runTransaction(async (tx) => {
            const snap = await tx.get(docRef);
            const data = snap.exists ? (snap.data() || {}) : {};
            if (snap.exists && !isClaimExpired(data, now)) {
                logger.info({ ...logContext, ageMs: now - (data.createdAtMs || 0), claimedBy: data.instance || 'unknown' },
                    'Duplicate blocked by existing claim');
                return false;
            }
            tx.set(docRef, payload, { merge: true });
            return true;
        });
    } catch (err) {
        logger.warn({ err, ...logContext }, 'Claim failed; proceeding without dedupe');
        return true;
    }
}
