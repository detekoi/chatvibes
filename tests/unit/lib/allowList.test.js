// tests/unit/lib/allowList.test.js

// Import directly — no mocking needed since the module is now a pure in-memory cache
const {
    isChannelAllowed,
    isChannelActive,
    updateAllowedChannels,
    addAllowedChannel,
    setChannelActive,
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

    describe('approved vs active', () => {
        it('keeps an inactive channel on the allow-list', () => {
            updateAllowedChannels([
                { name: 'alice', twitchUserId: '12345', isActive: false },
            ]);
            expect(isChannelAllowed('12345')).toBe(true);
            expect(isChannelAllowed('alice')).toBe(true);
            expect(isChannelActive('12345')).toBe(false);
            expect(isChannelActive('alice')).toBe(false);
        });

        it('reports an active channel as both allowed and active', () => {
            updateAllowedChannels([
                { name: 'alice', twitchUserId: '12345', isActive: true },
            ]);
            expect(isChannelAllowed('12345')).toBe(true);
            expect(isChannelActive('12345')).toBe(true);
        });

        it('treats an omitted isActive as active (pre-split callers)', () => {
            updateAllowedChannels([
                { name: 'alice', twitchUserId: '12345' },
            ]);
            expect(isChannelActive('12345')).toBe(true);
        });

        it('reports a channel outside the allow-list as inactive', () => {
            updateAllowedChannels([
                { name: 'alice', twitchUserId: '12345', isActive: true },
            ]);
            expect(isChannelActive('99999')).toBe(false);
        });

        it('allows all during the startup grace period', () => {
            expect(isChannelActive('anything')).toBe(true);
        });

        it('does not treat an all-inactive set as unloaded', () => {
            updateAllowedChannels([
                { name: 'alice', twitchUserId: '12345', isActive: false },
            ]);
            expect(isChannelActive('99999')).toBe(false);
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
            expect(isChannelAllowed('alice')).toBe(false);
            expect(isChannelAllowed('222')).toBe(true);
        });

        it('indexes channels without a twitchUserId by login name', () => {
            updateAllowedChannels([
                { name: 'noId', twitchUserId: null, isActive: true },
                { name: 'hasId', twitchUserId: '42' },
            ]);
            expect(isChannelAllowed('noid')).toBe(true);
            expect(isChannelActive('noId')).toBe(true);
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

        it('does not switch the bot on by itself', () => {
            updateAllowedChannels([
                { name: 'existing', twitchUserId: '111' },
            ]);
            addAllowedChannel('newchannel', '222');
            expect(isChannelActive('222')).toBe(false);
        });

        it('handles null inputs gracefully', () => {
            addAllowedChannel(null, '42');
            addAllowedChannel('test', null);
            // Should not throw
        });
    });

    describe('setChannelActive', () => {
        it('switches a channel on and off without revoking approval', () => {
            updateAllowedChannels([
                { name: 'alice', twitchUserId: '111', isActive: true },
            ]);

            setChannelActive('alice', '111', false);
            expect(isChannelActive('111')).toBe(false);
            expect(isChannelActive('alice')).toBe(false);
            expect(isChannelAllowed('111')).toBe(true);
            expect(isChannelAllowed('alice')).toBe(true);

            setChannelActive('alice', '111', true);
            expect(isChannelActive('111')).toBe(true);
        });

        it('approves an unknown channel it is asked to activate', () => {
            updateAllowedChannels([
                { name: 'alice', twitchUserId: '111' },
            ]);
            setChannelActive('bob', '222', true);
            expect(isChannelAllowed('222')).toBe(true);
            expect(isChannelActive('bob')).toBe(true);
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
            expect(isChannelActive('111')).toBe(false);
            expect(isChannelAllowed('222')).toBe(true);
        });

        it('removes the mapped login name when given only an ID', () => {
            updateAllowedChannels([
                { name: 'alice', twitchUserId: '111' },
                { name: 'bob', twitchUserId: '222' },
            ]);
            removeAllowedChannel(null, '111');
            expect(isChannelAllowed('alice')).toBe(false);
            expect(isChannelAllowed('111')).toBe(false);
        });
    });
});
