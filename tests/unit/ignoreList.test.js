// tests/unit/ignoreList.test.js
// The ignore list is keyed by immutable platform account IDs. These tests pin the
// behaviour that motivated the change: a rename must not shed an entry, and a
// recycled login must not inherit one.

import {
    ignoreKey,
    isIgnored,
    isTwitchUserIgnored,
    isYouTubeUserIgnored,
    parseIgnoreKey,
    listIgnoredAccounts,
    PLATFORM_TWITCH,
    PLATFORM_YOUTUBE,
} from '../../src/lib/ignoreList.js';

const config = {
    ignoredUserIds: {
        'twitch:52343457': 'SpamBot',
        'youtube:UCX6OQ3DkcsbYNE6H8uQQuVA': 'A YouTube Viewer',
    },
};

describe('ignoreKey', () => {
    test('joins platform and account ID', () => {
        expect(ignoreKey(PLATFORM_TWITCH, '123')).toBe('twitch:123');
        expect(ignoreKey(PLATFORM_YOUTUBE, 'UCabc')).toBe('youtube:UCabc');
    });

    test('accepts a numeric ID, since Twitch IDs arrive as both', () => {
        expect(ignoreKey(PLATFORM_TWITCH, 123)).toBe('twitch:123');
    });

    test('returns null rather than a key naming "undefined"', () => {
        // A key built from a missing ID would be a real map key that a second
        // caller with a different missing ID would collide with.
        expect(ignoreKey(PLATFORM_TWITCH, undefined)).toBeNull();
        expect(ignoreKey(PLATFORM_TWITCH, null)).toBeNull();
        expect(ignoreKey(PLATFORM_TWITCH, '')).toBeNull();
        expect(ignoreKey(PLATFORM_TWITCH, '   ')).toBeNull();
        expect(ignoreKey(undefined, '123')).toBeNull();
    });
});

describe('isIgnored', () => {
    test('matches on account ID', () => {
        expect(isTwitchUserIgnored(config, '52343457')).toBe(true);
        expect(isYouTubeUserIgnored(config, 'UCX6OQ3DkcsbYNE6H8uQQuVA')).toBe(true);
    });

    test('a numeric Twitch ID matches the string it was stored as', () => {
        expect(isTwitchUserIgnored(config, 52343457)).toBe(true);
    });

    test('an account not on the list is not ignored', () => {
        expect(isTwitchUserIgnored(config, '999')).toBe(false);
    });

    test('an ID is never matched against the other platform', () => {
        expect(isYouTubeUserIgnored(config, '52343457')).toBe(false);
        expect(isTwitchUserIgnored(config, 'UCX6OQ3DkcsbYNE6H8uQQuVA')).toBe(false);
    });

    test('the display label is not a match target', () => {
        // This is the recycled-login case: whoever holds the name "SpamBot" now
        // is a different account and must not inherit the entry.
        expect(isTwitchUserIgnored(config, 'SpamBot')).toBe(false);
        expect(isTwitchUserIgnored(config, 'spambot')).toBe(false);
    });

    test('a renamed account stays ignored, because only the label changes', () => {
        const renamed = { ignoredUserIds: { 'twitch:52343457': 'CompletelyNewName' } };
        expect(isTwitchUserIgnored(renamed, '52343457')).toBe(true);
    });

    test('a missing ID means not ignored, which is how anonymous events pass', () => {
        expect(isTwitchUserIgnored(config, undefined)).toBe(false);
        expect(isTwitchUserIgnored(config, null)).toBe(false);
        expect(isTwitchUserIgnored(config, '')).toBe(false);
    });

    test('tolerates a config with no ignore list at all', () => {
        expect(isTwitchUserIgnored({}, '123')).toBe(false);
        expect(isTwitchUserIgnored(undefined, '123')).toBe(false);
        expect(isTwitchUserIgnored({ ignoredUserIds: {} }, '123')).toBe(false);
    });

    test('inherited Object properties are not treated as entries', () => {
        // A plain `key in map` test would report every viewer as ignored the
        // moment their ID happened to be "constructor" or "toString".
        expect(isIgnored({ ignoredUserIds: {} }, PLATFORM_TWITCH, 'constructor')).toBe(false);
        expect(isIgnored({ ignoredUserIds: {} }, PLATFORM_TWITCH, 'toString')).toBe(false);
        expect(isIgnored({ ignoredUserIds: {} }, 'constructor', '123')).toBe(false);
    });
});

describe('parseIgnoreKey', () => {
    test('splits a key into platform and account ID', () => {
        expect(parseIgnoreKey('twitch:123')).toEqual({ platform: 'twitch', accountId: '123' });
        expect(parseIgnoreKey('youtube:UCabc')).toEqual({ platform: 'youtube', accountId: 'UCabc' });
    });

    test('treats a key with no separator as Twitch', () => {
        expect(parseIgnoreKey('123')).toEqual({ platform: PLATFORM_TWITCH, accountId: '123' });
    });
});

describe('listIgnoredAccounts', () => {
    test('returns each entry with its platform, ID and label, sorted by label', () => {
        expect(listIgnoredAccounts(config)).toEqual([
            { key: 'youtube:UCX6OQ3DkcsbYNE6H8uQQuVA', platform: 'youtube', accountId: 'UCX6OQ3DkcsbYNE6H8uQQuVA', label: 'A YouTube Viewer' },
            { key: 'twitch:52343457', platform: 'twitch', accountId: '52343457', label: 'SpamBot' },
        ]);
    });

    test('falls back to the key when an entry has no label', () => {
        const noLabel = { ignoredUserIds: { 'twitch:123': '' } };
        expect(listIgnoredAccounts(noLabel)[0].label).toBe('twitch:123');
    });

    test('an empty or absent list yields an empty array', () => {
        expect(listIgnoredAccounts({ ignoredUserIds: {} })).toEqual([]);
        expect(listIgnoredAccounts({})).toEqual([]);
        expect(listIgnoredAccounts(undefined)).toEqual([]);
    });
});
