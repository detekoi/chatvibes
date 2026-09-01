// tests/unit/rewardMuteList.test.js
// The muted-rewards map: presence test, tolerant reads, full-record writes.

import { isRewardMuted, normalizeMutedRewardEntry, buildMutedRewardEntry, listMutedRewards } from '../../src/lib/rewardMuteList.js';

describe('rewardMuteList', () => {
    const config = {
        mutedRewardIds: {
            'r-horn': { title: 'Air Horn', by: 'twitch:1', at: '2026-09-01T00:00:00.000Z' },
            'r-bare': 'Bare Title',
        },
    };

    it('tests only for the key', () => {
        expect(isRewardMuted(config, 'r-horn')).toBe(true);
        expect(isRewardMuted(config, 'r-bare')).toBe(true);
        expect(isRewardMuted(config, 'r-other')).toBe(false);
        expect(isRewardMuted(config, undefined)).toBe(false);
        expect(isRewardMuted({}, 'r-horn')).toBe(false);
        expect(isRewardMuted({ mutedRewardIds: null }, 'r-horn')).toBe(false);
    });

    it('does not treat inherited properties as entries', () => {
        expect(isRewardMuted({ mutedRewardIds: {} }, 'constructor')).toBe(false);
    });

    it('reads a bare string as a title and fills in the rest', () => {
        expect(normalizeMutedRewardEntry('Bare Title', 'r-bare')).toEqual({ title: 'Bare Title', by: null, at: null });
        expect(normalizeMutedRewardEntry({ title: '  ' }, 'r-x')).toEqual({ title: 'r-x', by: null, at: null });
        expect(normalizeMutedRewardEntry(null, 'r-x')).toEqual({ title: 'r-x', by: null, at: null });
    });

    it('writes every field so a merge cannot inherit a stale one', () => {
        const entry = buildMutedRewardEntry({ title: ' Air Horn ', by: 'twitch:1' });
        expect(Object.keys(entry).sort()).toEqual(['at', 'by', 'title']);
        expect(entry.title).toBe('Air Horn');
        expect(entry.by).toBe('twitch:1');
        expect(() => new Date(entry.at).toISOString()).not.toThrow();
        expect(buildMutedRewardEntry({ title: 'x' }).by).toBeNull();
    });

    it('lists entries sorted by title', () => {
        expect(listMutedRewards(config).map(e => e.title)).toEqual(['Air Horn', 'Bare Title']);
        expect(listMutedRewards(config)[0].rewardId).toBe('r-horn');
        expect(listMutedRewards({})).toEqual([]);
    });
});
