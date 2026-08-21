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
    normalizeIgnoreEntry,
    getIgnoreEntry,
    canSelfUnignore,
    buildIgnoreEntry,
    IGNORE_SOURCE_SELF,
    IGNORE_SOURCE_MODERATOR,
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
            {
                key: 'youtube:UCX6OQ3DkcsbYNE6H8uQQuVA', platform: 'youtube', accountId: 'UCX6OQ3DkcsbYNE6H8uQQuVA',
                label: 'A YouTube Viewer', source: IGNORE_SOURCE_MODERATOR, by: null, at: null,
            },
            {
                key: 'twitch:52343457', platform: 'twitch', accountId: '52343457',
                label: 'SpamBot', source: IGNORE_SOURCE_MODERATOR, by: null, at: null,
            },
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

// --- Provenance -------------------------------------------------------------
//
// `source` is what separates a viewer's own opt-out from a moderator's mute.
// Getting the default wrong in the permissive direction would hand an abuser the
// ability to lift the mute aimed at them, so every ambiguous shape is pinned here.

describe('normalizeIgnoreEntry', () => {
    test('reads a bare string as a moderator-imposed entry', () => {
        // The shape the map held before provenance existed. Nothing records who
        // added these, and guessing "self" would unlock every historical mute.
        expect(normalizeIgnoreEntry('SpamBot', 'twitch:1')).toEqual({
            label: 'SpamBot', source: IGNORE_SOURCE_MODERATOR, by: null, at: null,
        });
    });

    test('reads a full record back unchanged', () => {
        expect(normalizeIgnoreEntry(
            { label: 'Viewer', source: 'self', by: 'twitch:7', at: '2026-08-20T00:00:00.000Z' }, 'twitch:7',
        )).toEqual({ label: 'Viewer', source: IGNORE_SOURCE_SELF, by: 'twitch:7', at: '2026-08-20T00:00:00.000Z' });
    });

    test('an unrecognized or missing source falls back to moderator', () => {
        expect(normalizeIgnoreEntry({ label: 'X' }, 'twitch:1').source).toBe(IGNORE_SOURCE_MODERATOR);
        expect(normalizeIgnoreEntry({ label: 'X', source: 'nonsense' }, 'twitch:1').source).toBe(IGNORE_SOURCE_MODERATOR);
        expect(normalizeIgnoreEntry({ label: 'X', source: 'SELF' }, 'twitch:1').source).toBe(IGNORE_SOURCE_MODERATOR);
    });

    test('survives shapes only a hand-edited document would produce', () => {
        for (const value of [null, undefined, [], 42, true]) {
            const entry = normalizeIgnoreEntry(value, 'twitch:1');
            expect(entry.source).toBe(IGNORE_SOURCE_MODERATOR);
            expect(entry.label).toBe('twitch:1');
        }
    });

    test('falls back to the key when a record carries no label', () => {
        expect(normalizeIgnoreEntry({ source: 'self' }, 'twitch:1').label).toBe('twitch:1');
    });
});

describe('getIgnoreEntry', () => {
    const mixed = {
        ignoredUserIds: {
            'twitch:1': 'Legacy',
            'twitch:2': { label: 'Opted Out', source: 'self', by: 'twitch:2', at: 'then' },
            'twitch:3': { label: 'Muted', source: 'moderator', by: 'twitch:99', at: 'then' },
        },
    };

    test('returns the normalized entry with its key and platform', () => {
        expect(getIgnoreEntry(mixed, PLATFORM_TWITCH, '2')).toEqual({
            key: 'twitch:2', platform: 'twitch', accountId: '2',
            label: 'Opted Out', source: IGNORE_SOURCE_SELF, by: 'twitch:2', at: 'then',
        });
    });

    test('returns null for an account that is not listed', () => {
        expect(getIgnoreEntry(mixed, PLATFORM_TWITCH, '404')).toBeNull();
        expect(getIgnoreEntry(mixed, PLATFORM_YOUTUBE, '2')).toBeNull();
    });

    test('returns null rather than an inherited Object property', () => {
        expect(getIgnoreEntry({ ignoredUserIds: {} }, PLATFORM_TWITCH, 'constructor')).toBeNull();
        expect(getIgnoreEntry({ ignoredUserIds: {} }, PLATFORM_TWITCH, 'toString')).toBeNull();
    });

    test('returns null for a missing ID, matching isIgnored', () => {
        expect(getIgnoreEntry(mixed, PLATFORM_TWITCH, undefined)).toBeNull();
    });

    test('tolerates a config with no ignore list at all', () => {
        expect(getIgnoreEntry({}, PLATFORM_TWITCH, '1')).toBeNull();
        expect(getIgnoreEntry(undefined, PLATFORM_TWITCH, '1')).toBeNull();
    });

    describe('canSelfUnignore', () => {
        test('only a self-sourced entry may be lifted by its subject', () => {
            expect(canSelfUnignore(getIgnoreEntry(mixed, PLATFORM_TWITCH, '2'))).toBe(true);
            expect(canSelfUnignore(getIgnoreEntry(mixed, PLATFORM_TWITCH, '3'))).toBe(false);
        });

        test('a legacy string entry is not self-clearable', () => {
            // The regression this whole field exists to prevent.
            expect(canSelfUnignore(getIgnoreEntry(mixed, PLATFORM_TWITCH, '1'))).toBe(false);
        });

        test('an absent entry is not self-clearable', () => {
            expect(canSelfUnignore(null)).toBe(false);
            expect(canSelfUnignore(undefined)).toBe(false);
        });
    });
});

describe('buildIgnoreEntry', () => {
    test('writes every field, so a merge cannot inherit a stale source', () => {
        // merge:true deep-merges into the entry object too. A partial write would
        // leave a moderator's mute still marked self, and still self-clearable.
        const entry = buildIgnoreEntry({ label: 'Viewer', source: IGNORE_SOURCE_SELF, by: 'twitch:7' });
        expect(Object.keys(entry).sort()).toEqual(['at', 'by', 'label', 'source']);
        expect(entry).toMatchObject({ label: 'Viewer', source: IGNORE_SOURCE_SELF, by: 'twitch:7' });
        expect(Date.parse(entry.at)).not.toBeNaN();
    });

    test('defaults to moderator when the source is absent or unrecognized', () => {
        expect(buildIgnoreEntry({ label: 'X' }).source).toBe(IGNORE_SOURCE_MODERATOR);
        expect(buildIgnoreEntry({ label: 'X', source: 'nonsense' }).source).toBe(IGNORE_SOURCE_MODERATOR);
        expect(buildIgnoreEntry().source).toBe(IGNORE_SOURCE_MODERATOR);
    });

    test('never writes undefined, which Firestore rejects', () => {
        expect(buildIgnoreEntry()).toMatchObject({ label: '', by: null });
    });

    test('round-trips through normalizeIgnoreEntry', () => {
        const built = buildIgnoreEntry({ label: 'Viewer', source: IGNORE_SOURCE_SELF, by: 'twitch:7' });
        expect(normalizeIgnoreEntry(built, 'twitch:7')).toEqual(built);
    });
});
