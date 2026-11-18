// tests/unit/spotlightLog.test.js
// The pick log the dashboard reads: ttsSpotlightLog/<broadcasterId>.picks, newest
// last, at most 30 entries, each { user, userId, text, reason, at, platform }.
// A failed write logs a warning and never rejects.

import { jest } from '@jest/globals';

describe('spotlightLog.recordPick', () => {
    let recordPick;
    let logger;
    let stored;
    let failNext;
    let docIds;

    beforeEach(async () => {
        jest.resetModules();
        stored = new Map();
        failNext = false;
        docIds = [];
        logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

        class FakeFirestore {
            collection(name) {
                return {
                    doc: (id) => { docIds.push(`${name}/${id}`); return { id }; },
                };
            }
            async runTransaction(fn) {
                if (failNext) { failNext = false; throw new Error('unavailable'); }
                return fn({
                    get: async (ref) => ({ exists: stored.has(ref.id), data: () => stored.get(ref.id) }),
                    set: (ref, value) => { stored.set(ref.id, { ...stored.get(ref.id), ...value }); },
                });
            }
        }
        jest.unstable_mockModule('@google-cloud/firestore', () => ({
            Firestore: FakeFirestore,
            FieldValue: { serverTimestamp: () => 'SERVER_TS' },
        }));
        jest.unstable_mockModule('../../src/lib/logger.js', () => ({ default: logger }));
        ({ recordPick } = await import('../../src/lib/spotlight/spotlightLog.js'));
    });

    it('appends an entry in the dashboard shape', async () => {
        await recordPick('100', { user: 'Viewer', userId: 42, text: 'hello', reason: 'funny', at: 1700000000000, platform: 'twitch' });
        expect(docIds).toEqual(['ttsSpotlightLog/100']);
        expect(stored.get('100')).toEqual({
            picks: [{ user: 'Viewer', userId: '42', text: 'hello', reason: 'funny', at: 1700000000000, platform: 'twitch' }],
            updatedAt: 'SERVER_TS',
        });
    });

    it('keeps the newest 30, newest last, with writes in call order', async () => {
        const writes = [];
        for (let i = 1; i <= 35; i++) writes.push(recordPick('100', { user: `u${i}`, text: `t${i}`, reason: '', at: i, platform: 'twitch' }));
        await Promise.all(writes);
        const picks = stored.get('100').picks;
        expect(picks).toHaveLength(30);
        expect(picks[0].text).toBe('t6');
        expect(picks.at(-1).text).toBe('t35');
    });

    it('cuts the text at 500 characters and normalizes the optional fields', async () => {
        await recordPick('100', { user: 'yt', text: 'x'.repeat(600), reason: undefined, platform: 'youtube' });
        const [entry] = stored.get('100').picks;
        expect(entry.text).toHaveLength(500);
        expect(entry.userId).toBeNull();
        expect(entry.reason).toBe('');
        expect(entry.platform).toBe('youtube');
        expect(Number.isFinite(entry.at)).toBe(true);
    });

    it('logs a failed write at warn and resolves', async () => {
        failNext = true;
        await expect(recordPick('100', { user: 'a', text: 'b', reason: 'c', at: 1, platform: 'twitch' })).resolves.toBeUndefined();
        expect(logger.warn).toHaveBeenCalledTimes(1);
        // The chain keeps working after a failure.
        await recordPick('100', { user: 'a', text: 'next', reason: 'c', at: 2, platform: 'twitch' });
        expect(stored.get('100').picks.map(p => p.text)).toEqual(['next']);
    });
});
