// tests/unit/rewardResolver.test.js
// A typed title becomes one reward: exact, then unique partial, then the model
// — which may only narrow, never invent.

import { jest } from '@jest/globals';
import { matchRewardsDeterministically, resolveReward, normalizeTitle } from '../../src/lib/rewardResolver.js';

const rewards = [
    { id: 'r1', title: 'Air Horn', prompt: 'Plays a loud air horn' },
    { id: 'r2', title: 'Fog Horn', prompt: 'A ship horn' },
    { id: 'r3', title: 'Hydrate!', prompt: 'Drink water' },
    { id: 'r4', title: '📣 SHOUTOUT 📣', prompt: '' },
];

describe('normalizeTitle', () => {
    it('lowercases, trims, strips quotes and collapses whitespace', () => {
        expect(normalizeTitle('  "Air   Horn" ')).toBe('air horn');
        expect(normalizeTitle('“Fog Horn”')).toBe('fog horn');
        expect(normalizeTitle(undefined)).toBe('');
    });
});

describe('matchRewardsDeterministically', () => {
    it('matches the exact title, case-insensitively', () => {
        expect(matchRewardsDeterministically('air horn', rewards)).toEqual({ status: 'match', reward: rewards[0], via: 'exact' });
    });

    it('matches a unique partial title, in any word order', () => {
        expect(matchRewardsDeterministically('hydrate', rewards)).toMatchObject({ status: 'match', reward: rewards[2], via: 'partial' });
        expect(matchRewardsDeterministically('horn air', rewards)).toMatchObject({ status: 'match', reward: rewards[0], via: 'partial' });
        expect(matchRewardsDeterministically('shoutout', rewards)).toMatchObject({ status: 'match', reward: rewards[3], via: 'partial' });
    });

    it('reports every candidate when the partial match is not unique', () => {
        const r = matchRewardsDeterministically('horn', rewards);
        expect(r.status).toBe('ambiguous');
        expect(r.candidates.map(c => c.id)).toEqual(['r1', 'r2']);
    });

    it('reports none for an empty query, an empty list, or no match', () => {
        expect(matchRewardsDeterministically('', rewards)).toEqual({ status: 'none', candidates: [] });
        expect(matchRewardsDeterministically('air horn', [])).toEqual({ status: 'none', candidates: [] });
        expect(matchRewardsDeterministically('lurk', rewards)).toEqual({ status: 'none', candidates: [] });
    });
});

describe('resolveReward', () => {
    it('does not consult the model when the words already settle it', async () => {
        const llmPick = jest.fn();
        await expect(resolveReward('Air Horn', rewards, { llmPick })).resolves.toMatchObject({ via: 'exact' });
        expect(llmPick).not.toHaveBeenCalled();
    });

    it('lets a confident model answer resolve a typo', async () => {
        const llmPick = jest.fn().mockResolvedValue({ rewardId: 'r1', confident: true });
        const r = await resolveReward('airhron', rewards, { llmPick });
        expect(r).toMatchObject({ status: 'match', reward: rewards[0], via: 'llm' });
        expect(llmPick).toHaveBeenCalledWith('airhron', rewards);
    });

    it('restricts the model to the ambiguous candidates and keeps the ambiguity when it abstains', async () => {
        const llmPick = jest.fn().mockResolvedValue({ rewardId: null, confident: false });
        const r = await resolveReward('horn', rewards, { llmPick });
        expect(r.status).toBe('ambiguous');
        expect(llmPick).toHaveBeenCalledWith('horn', [rewards[0], rewards[1]]);
    });

    it('discards a pick that is outside the pool, or not confident, or an error', async () => {
        await expect(resolveReward('lurk', rewards, { llmPick: async () => ({ rewardId: 'r-made-up', confident: true }) }))
            .resolves.toEqual({ status: 'none', candidates: [] });
        await expect(resolveReward('lurk', rewards, { llmPick: async () => ({ rewardId: 'r1', confident: false }) }))
            .resolves.toEqual({ status: 'none', candidates: [] });
        await expect(resolveReward('lurk', rewards, { llmPick: async () => { throw new Error('boom'); } }))
            .resolves.toEqual({ status: 'none', candidates: [] });
        // A pick from outside the ambiguous pool cannot override it either.
        await expect(resolveReward('horn', rewards, { llmPick: async () => ({ rewardId: 'r3', confident: true }) }))
            .resolves.toMatchObject({ status: 'ambiguous' });
    });

    it('works with no model at all', async () => {
        await expect(resolveReward('lurk', rewards)).resolves.toEqual({ status: 'none', candidates: [] });
    });
});
