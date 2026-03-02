// tests/unit/lib/allowList.test.js
import { jest } from '@jest/globals';

// Import directly — no mocking needed since the module is now a pure in-memory cache
const {
    isChannelAllowed,
    updateAllowedChannels,
    addAllowedChannel,
    removeAllowedChannel,
} = await import('../../../src/lib/allowList.js');

describe('allowList (Firestore-backed cache)', () => {
    beforeEach(() => {
        // Reset to empty state
        updateAllowedChannels([]);
    });

    describe('isChannelAllowed', () => {
        it('returns true when no channels loaded (startup grace period)', () => {
            expect(isChannelAllowed('anything')).toBe(true);
        });

        it('returns false for null/undefined/empty identifier', () => {
            expect(isChannelAllowed(null)).toBe(false);
            expect(isChannelAllowed(undefined)).toBe(false);
            expect(isChannelAllowed('')).toBe(false);
        });

        it('returns true when a broadcaster ID is in the allowed set', () => {
            updateAllowedChannels([
                { name: 'alice', twitchUserId: '12345' },
                { name: 'bob', twitchUserId: '67890' },
            ]);
            expect(isChannelAllowed('12345')).toBe(true);
            expect(isChannelAllowed('67890')).toBe(true);
        });

        it('returns false when a broadcaster ID is NOT in the allowed set', () => {
            updateAllowedChannels([
                { name: 'alice', twitchUserId: '12345' },
            ]);
            expect(isChannelAllowed('99999')).toBe(false);
        });

        it('resolves a channel login name to broadcaster ID via mapping', () => {
            updateAllowedChannels([
                { name: 'somechannel', twitchUserId: '12345' },
            ]);
            expect(isChannelAllowed('somechannel')).toBe(true);
        });

        it('is case-insensitive for channel login name lookups', () => {
            updateAllowedChannels([
                { name: 'somechannel', twitchUserId: '12345' },
            ]);
            expect(isChannelAllowed('SomeChannel')).toBe(true);
        });

        it('returns false for an unmapped channel name', () => {
            updateAllowedChannels([
                { name: 'alice', twitchUserId: '12345' },
            ]);
            expect(isChannelAllowed('unknownchannel')).toBe(false);
        });
    });

    describe('updateAllowedChannels', () => {
        it('replaces the entire allowed set', () => {
            updateAllowedChannels([
                { name: 'alice', twitchUserId: '111' },
            ]);
            expect(isChannelAllowed('111')).toBe(true);

            updateAllowedChannels([
                { name: 'bob', twitchUserId: '222' },
            ]);
            expect(isChannelAllowed('111')).toBe(false);
            expect(isChannelAllowed('222')).toBe(true);
        });

        it('skips channels without twitchUserId', () => {
            updateAllowedChannels([
                { name: 'noId', twitchUserId: null },
                { name: 'hasId', twitchUserId: '42' },
            ]);
            expect(isChannelAllowed('noId')).toBe(false);
            expect(isChannelAllowed('42')).toBe(true);
        });
    });

    describe('addAllowedChannel', () => {
        it('adds a channel to the allowed set', () => {
            updateAllowedChannels([
                { name: 'existing', twitchUserId: '111' },
            ]);
            addAllowedChannel('newchannel', '222');
            expect(isChannelAllowed('222')).toBe(true);
            expect(isChannelAllowed('newchannel')).toBe(true);
        });

        it('handles null inputs gracefully', () => {
            addAllowedChannel(null, '42');
            addAllowedChannel('test', null);
            // Should not throw
        });
    });

    describe('removeAllowedChannel', () => {
        it('removes a channel from the allowed set', () => {
            updateAllowedChannels([
                { name: 'alice', twitchUserId: '111' },
                { name: 'bob', twitchUserId: '222' },
            ]);
            removeAllowedChannel('alice', '111');
            expect(isChannelAllowed('111')).toBe(false);
            expect(isChannelAllowed('alice')).toBe(false);
            expect(isChannelAllowed('222')).toBe(true);
        });
    });
});
