// tests/unit/firestoreClaim.test.js
// The dedup claim helpers had no coverage before the switch from runTransaction to
// create(). These pin the semantics that switch depends on.

// The real Timestamp, not a mock: isClaimExpired branches on `instanceof Timestamp`,
// so a stand-in would make the test agree with itself rather than with Firestore.
import { Timestamp } from '@google-cloud/firestore';

const { ALREADY_EXISTS, isClaimExpired } = await import('../../src/lib/firestoreClaim.js');

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
});
