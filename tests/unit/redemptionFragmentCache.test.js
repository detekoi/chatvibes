// tests/unit/redemptionFragmentCache.test.js

import { jest } from '@jest/globals';

const mockLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
};

jest.unstable_mockModule('../../src/lib/logger.js', () => ({
    default: mockLogger
}));

let cache;

beforeAll(async () => {
    cache = await import('../../src/components/twitch/redemptionFragmentCache.js');
});

beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    if (cache) cache.clearCache();
});

afterEach(() => {
    jest.useRealTimers();
});

describe('redemptionFragmentCache', () => {
    it('should store and consume fragments', () => {
        const rewardId = 'reward-1';
        const userId = 'user-1';
        const channelLogin = 'channel-1';
        const fragments = [{ type: 'text', text: 'hello' }];
        const text = 'hello';

        cache.storeFragments(rewardId, userId, channelLogin, fragments, text);
        
        expect(cache.getCacheSize()).toBe(1);

        const consumed = cache.consumeFragments(rewardId, userId, channelLogin);
        expect(consumed).toEqual(fragments);
        
        // Cache should be empty after consumption
        expect(cache.getCacheSize()).toBe(0);
        
        // Consuming again should return null
        const consumedAgain = cache.consumeFragments(rewardId, userId, channelLogin);
        expect(consumedAgain).toBeNull();
    });

    it('should normalize channelLogin to lowercase', () => {
        const rewardId = 'reward-1';
        const userId = 'user-1';
        const channelLogin = 'Channel-1'; // Mixed case
        const fragments = [{ type: 'text', text: 'hello' }];
        const text = 'hello';

        cache.storeFragments(rewardId, userId, channelLogin, fragments, text);
        
        // Retrieve with lowercase
        const consumed = cache.consumeFragments(rewardId, userId, 'channel-1');
        expect(consumed).toEqual(fragments);
    });

    it('should handle missing parameters gracefully', () => {
        cache.storeFragments(null, 'user', 'channel', [], '');
        expect(cache.getCacheSize()).toBe(0);
        
        const consumed = cache.consumeFragments(null, 'user', 'channel');
        expect(consumed).toBeNull();
    });

    it('should expire entries after TTL', () => {
        const rewardId = 'reward-1';
        const userId = 'user-1';
        const channelLogin = 'channel-1';
        const fragments = [];

        cache.storeFragments(rewardId, userId, channelLogin, fragments, '');
        
        expect(cache.getCacheSize()).toBe(1);

        // Advance time by 11 seconds (TTL is 10s)
        jest.advanceTimersByTime(11000);

        const consumed = cache.consumeFragments(rewardId, userId, channelLogin);
        
        // Should return null because it's expired
        expect(consumed).toBeNull();
        expect(cache.getCacheSize()).toBe(0);
    });

    it('should prune old entries', () => {
        const rewardId = 'reward-1';
        const userId = 'user-1';
        const channelLogin = 'channel-1';
        const fragments = [];

        cache.storeFragments(rewardId, userId, channelLogin, fragments, '');
        expect(cache.getCacheSize()).toBe(1);

        // Advance time by 11 seconds
        jest.advanceTimersByTime(11000);
        
        // Trigger manual prune
        cache.pruneOldEntries();

        expect(cache.getCacheSize()).toBe(0);
    });
});
