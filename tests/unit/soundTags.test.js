// tests/unit/soundTags.test.js
// Sound tags (<laugh>, (sighs)) that a channel turned off are removed from the text
// before synthesis. The tag list is SOUND_TAGS in tts-config.json.

import { readFileSync } from 'fs';
import { SOUND_TAG_NAMES, canonicalSoundTag, stripDisabledSoundTags } from '../../src/lib/textRewrite/soundTags.js';

const { SOUND_TAGS } = JSON.parse(readFileSync('src/components/tts/tts-config.json', 'utf8'));

describe('SOUND_TAG_NAMES', () => {
    test('lists the canonical names in the order of tts-config.json', () => {
        expect(SOUND_TAG_NAMES).toEqual(SOUND_TAGS.map(entry => entry.tag));
        expect(SOUND_TAG_NAMES).toEqual(expect.arrayContaining(['laugh', 'scream', 'moan', 'short pause']));
    });

    test('has no spelling that points at two tags', () => {
        const spellings = SOUND_TAGS.flatMap(entry => [entry.tag, ...entry.variants]);

        expect(new Set(spellings).size).toBe(spellings.length);
    });
});

describe('canonicalSoundTag', () => {
    test.each([
        ['laugh', 'laugh'],
        ['laughs', 'laugh'],
        ['laughter', 'laugh'],
        ['<Laughs>', 'laugh'],
        ['(sighs)', 'sigh'],
        ['  SCREAMING  ', 'scream'],
        ['heavy breathing', 'heavy breath'],
        ['short_pause', 'short pause'],
        ['throat clearing', 'throat-clearing'],
        ['throat_clearing', 'throat-clearing'],
        ['throat-clearing', 'throat-clearing'],
        ['short-pause', 'short pause'],
        ['short pause', 'short pause'],
        ['Long-Pause', 'long pause'],
        ['long_pause', 'long pause'],
        ['heavy-breath', 'heavy breath'],
        ['<heavy-breathing>', 'heavy breath'],
        ['clears-throat', 'throat-clearing'],
        ['clears_throat', 'throat-clearing'],
    ])('%p is %p', (typed, tag) => {
        expect(canonicalSoundTag(typed)).toBe(tag);
    });

    test('every spelling in the config resolves to its tag', () => {
        for (const { tag, variants } of SOUND_TAGS) {
            for (const word of [tag, ...variants]) expect(canonicalSoundTag(word)).toBe(tag);
        }
    });

    test.each(['', 'nope', 'laughs loudly', null, undefined, 42])('%p is not a tag', typed => {
        expect(canonicalSoundTag(typed)).toBeNull();
    });

    test('a space, a hyphen and an underscore are the same inside every spelling', () => {
        for (const { tag, variants } of SOUND_TAGS) {
            for (const word of [tag, ...variants]) {
                for (const joiner of [' ', '-', '_']) {
                    expect(canonicalSoundTag(word.replace(/[\s_-]+/g, joiner))).toBe(tag);
                }
            }
        }
    });

    test('recognises every spelling that stripDisabledSoundTags removes', () => {
        // What a moderator copies out of a chat message must be a name the command takes.
        for (const typed of ['<short-pause>', '(short  pause)', '<throat clearing>', '(clears-throat)']) {
            const tag = canonicalSoundTag(typed);

            expect(tag).not.toBeNull();
            expect(stripDisabledSoundTags(`a ${typed} b`, [tag])).toBe('a b');
        }
    });
});

describe('stripDisabledSoundTags', () => {
    test('removes a disabled tag in angle brackets or in parentheses', () => {
        expect(stripDisabledSoundTags('hello <laugh> world', ['laugh'])).toBe('hello world');
        expect(stripDisabledSoundTags('hello (laugh) world', ['laugh'])).toBe('hello world');
    });

    test('keeps the outer spaces with trim off, and still collapses the inner ones', () => {
        expect(stripDisabledSoundTags('<moan> nice play ', ['moan'], { trim: false })).toBe(' nice play ');
        expect(stripDisabledSoundTags(' <moan> ', ['moan'], { trim: false })).toBe(' ');
        expect(stripDisabledSoundTags('<moan> nice play ', ['moan'])).toBe('nice play');
    });

    test('removes every spelling of the tag, in any letter case', () => {
        expect(stripDisabledSoundTags('a <LAUGHING> b (Laughs) c <laughter> d', ['laugh'])).toBe('a b c d');
    });

    test('leaves the tags that are still on', () => {
        expect(stripDisabledSoundTags('a <laugh> b <scream> c', ['laugh'])).toBe('a b <scream> c');
        expect(stripDisabledSoundTags('<heavy breathing> <breath>', ['breath'])).toBe('<heavy breathing>');
    });

    test('removes several disabled tags in one pass', () => {
        expect(stripDisabledSoundTags('<moan> hi (screams) there <sigh>', ['moan', 'scream'])).toBe('hi there <sigh>');
    });

    test('allows spaces inside the brackets', () => {
        expect(stripDisabledSoundTags('hi < laugh > there ( laughs ) now', ['laugh'])).toBe('hi there now');
    });

    test('matches a space or a hyphen inside a two-word tag', () => {
        expect(stripDisabledSoundTags('<short-pause> a <short  pause> b <long pause>', ['short pause'])).toBe('a b <long pause>');
        expect(stripDisabledSoundTags('<throat clearing> ok (clears-throat)', ['throat-clearing'])).toBe('ok');
    });

    test('leaves the bare word and longer bracketed text alone', () => {
        const text = 'I laugh (laughs loudly) <laughs a lot> at <laughx>';

        expect(stripDisabledSoundTags(text, ['laugh'])).toBe(text);
    });

    test('leaves the text of a URL alone', () => {
        expect(stripDisabledSoundTags('see https://example.com/a_(laugh)_b <laugh>', ['laugh']))
            .toBe('see https://example.com/a_(laugh)_b');
    });

    test('returns an empty string for a message that was only a disabled tag', () => {
        expect(stripDisabledSoundTags('<laugh>', ['laugh'])).toBe('');
    });

    test('returns the text unchanged, spacing included, when nothing was removed', () => {
        const text = 'a  b   <scream>';

        expect(stripDisabledSoundTags(text, ['laugh'])).toBe(text);
    });

    test('ignores names that are not canonical tags', () => {
        // The stored list holds canonical names. A variant or an unknown word matches nothing.
        expect(stripDisabledSoundTags('a <laughs> b', ['laughs', 'nope'])).toBe('a <laughs> b');
        expect(stripDisabledSoundTags('a <laughs> b', ['nope', 'laugh'])).toBe('a b');
    });

    test.each([undefined, null, [], 'laugh', { laugh: true }])('removes nothing for a disabled list of %p', disabled => {
        expect(stripDisabledSoundTags('a <laugh> b', disabled)).toBe('a <laugh> b');
    });

    test('passes a non-string through', () => {
        expect(stripDisabledSoundTags(undefined, ['laugh'])).toBeUndefined();
        expect(stripDisabledSoundTags(null, ['laugh'])).toBeNull();
    });

    test('gives the same result whatever the order of the disabled list', () => {
        const text = '<laugh> a <scream> b <moan>';

        expect(stripDisabledSoundTags(text, ['scream', 'laugh'])).toBe(stripDisabledSoundTags(text, ['laugh', 'scream']));
        expect(stripDisabledSoundTags(text, ['scream', 'laugh'])).toBe('a b <moan>');
    });

    test('with every tag off, no known tag is left', () => {
        const text = SOUND_TAGS.flatMap(({ tag, variants }) => [tag, ...variants].map(word => `<${word}> (${word})`)).join(' x ');

        const out = stripDisabledSoundTags(text, SOUND_TAG_NAMES);

        expect(out).not.toMatch(/[<>()]/);
    });
});
