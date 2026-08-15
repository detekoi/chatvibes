// tests/unit/firestoreClaim.test.js
// The dedup claim helpers had no coverage before the switch from runTransaction to
// create(). These pin the semantics that switch depends on.

// The real Timestamp, not a mock: isClaimExpired branches on `instanceof Timestamp`,
// so a stand-in would make the test agree with itself rather than with Firestore.
import { Timestamp } from '@google-cloud/firestore';

const { ALREADY_EXISTS, isClaimExpired, claimOnce } = await import('../../src/lib/firestoreClaim.js');

/**
 * A doc ref standing in for Firestore's, with just enough behaviour to exercise the
 * claim protocol: create() rejects with ALREADY_EXISTS when occupied, and
 * runTransaction serialises, so a test can assert the expired-reclaim path is atomic
 * rather than a read followed by a write.
 */
function makeDocRef({ existing = null, createError = null } = {}) {
    let doc = existing;

    const ref = {
        calls: { create: 0, get: 0, set: 0, transaction: 0 },
        get data() { return doc; },
        async create(payload) {
            ref.calls.create++;
            if (createError) throw createError;
            if (doc !== null) {
                const err = new Error('already exists');
                err.code = ALREADY_EXISTS;
                throw err;
            }
            doc = { ...payload };
        },
        async get() {
            ref.calls.get++;
            return { exists: doc !== null, data: () => doc };
        },
        async set(payload) {
            ref.calls.set++;
            doc = { ...doc, ...payload };
        },
        firestore: {
            async runTransaction(fn) {
                ref.calls.transaction++;
                return fn({
                    get: async () => { ref.calls.get++; return { exists: doc !== null, data: () => doc }; },
                    set: (_r, payload) => { ref.calls.set++; doc = { ...doc, ...payload }; }
                });
            }
        }
    };
    return ref;
}

const NOW = 1_700_000_000_000;
const payloadFor = expiresAtMs => ({
    createdAtMs: NOW,
    instance: 'test',
    expireAt: Timestamp.fromMillis(expiresAtMs)
});

describe('firestoreClaim', () => {
    describe('ALREADY_EXISTS', () => {
        test('is the gRPC code Firestore create() rejects with', () => {
            // Hard-coded rather than imported from the SDK, so pin it: mistaking this
            // for another code turns the fail-open catch into swallow-everything.
            expect(ALREADY_EXISTS).toBe(6);
        });
    });

    describe('isClaimExpired', () => {
        const now = 1_700_000_000_000;

        test('treats a future expireAt Timestamp as still claimed', () => {
            expect(isClaimExpired({ expireAt: Timestamp.fromMillis(now + 60_000) }, now)).toBe(false);
        });

        test('treats a past expireAt Timestamp as expired', () => {
            expect(isClaimExpired({ expireAt: Timestamp.fromMillis(now - 1) }, now)).toBe(true);
        });

        test('treats expireAt exactly at now as expired', () => {
            expect(isClaimExpired({ expireAt: Timestamp.fromMillis(now) }, now)).toBe(true);
        });

        test('reads the legacy expireAtMs number', () => {
            expect(isClaimExpired({ expireAtMs: now + 60_000 }, now)).toBe(false);
            expect(isClaimExpired({ expireAtMs: now - 1 }, now)).toBe(true);
        });

        test('prefers expireAt when a document carries both', () => {
            expect(isClaimExpired(
                { expireAt: Timestamp.fromMillis(now + 60_000), expireAtMs: now - 1 },
                now
            )).toBe(false);
        });

        test('treats a document with neither field as expired', () => {
            // Predates both formats, so there is no dedup window left to honour.
            // Returning false here would block the key until someone deleted it by hand.
            expect(isClaimExpired({}, now)).toBe(true);
            expect(isClaimExpired(undefined, now)).toBe(true);
        });
    });

    describe('claimOnce', () => {
        test('claims a free key in a single round trip', async () => {
            const ref = makeDocRef();

            await expect(claimOnce(ref, payloadFor(NOW + 60_000), NOW)).resolves.toBe(true);

            // The whole point of create() over a transaction: one call on the hot path.
            expect(ref.calls.create).toBe(1);
            expect(ref.calls.get).toBe(0);
            expect(ref.calls.transaction).toBe(0);
        });

        test('refuses a duplicate while the existing claim is live', async () => {
            const ref = makeDocRef({ existing: payloadFor(NOW + 60_000) });

            await expect(claimOnce(ref, payloadFor(NOW + 60_000), NOW)).resolves.toBe(false);
        });

        test('re-claims a lapsed document', async () => {
            // Firestore TTL deletion is best-effort within 24h, so a claim routinely
            // outlives its expireAt. Refusing here would block the key indefinitely.
            const ref = makeDocRef({ existing: payloadFor(NOW - 1) });

            await expect(claimOnce(ref, payloadFor(NOW + 60_000), NOW)).resolves.toBe(true);
            expect(ref.data.expireAt.toMillis()).toBe(NOW + 60_000);
        });

        test('re-claims a lapsed document atomically', async () => {
            // Regression guard. An earlier version replaced the transaction with a bare
            // get() then set(), which let two instances both observe the same expired
            // claim and both proceed — duplicate audio for the viewer.
            const ref = makeDocRef({ existing: payloadFor(NOW - 1) });

            await claimOnce(ref, payloadFor(NOW + 60_000), NOW);

            expect(ref.calls.transaction).toBe(1);
            expect(ref.calls.set).toBe(1);
        });

        test('lets exactly one of two concurrent callers re-claim a lapsed document', async () => {
            // The stub does not reproduce Firestore's optimistic-concurrency retry, so
            // this documents the contract rather than proving the backend honours it.
            // The atomicity guarantee itself rests on the transaction, asserted above.
            const ref = makeDocRef({ existing: payloadFor(NOW - 1) });

            const results = await Promise.all([
                claimOnce(ref, payloadFor(NOW + 60_000), NOW),
                claimOnce(ref, payloadFor(NOW + 60_000), NOW)
            ]);

            expect(results.filter(Boolean)).toHaveLength(1);
        });

        test('fails open when create() errors for any other reason', async () => {
            // Losing a message is worse than speaking one twice, so a transport
            // failure must not be mistaken for "someone else has this".
            const err = new Error('deadline exceeded');
            err.code = 4;
            const ref = makeDocRef({ createError: err });

            await expect(claimOnce(ref, payloadFor(NOW + 60_000), NOW)).resolves.toBe(true);
        });

        test('fails open when the expired-reclaim transaction errors', async () => {
            const ref = makeDocRef({ existing: payloadFor(NOW - 1) });
            ref.firestore.runTransaction = async () => { throw new Error('unavailable'); };

            await expect(claimOnce(ref, payloadFor(NOW + 60_000), NOW)).resolves.toBe(true);
        });
    });
});
