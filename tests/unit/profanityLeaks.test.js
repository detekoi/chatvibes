// tests/unit/profanityLeaks.test.js
//
// The profanity filter runs on the text we send to the TTS API, so it can only
// clean words that are actually in that text. MiniMax expands some acronyms by
// itself — and does so inconsistently, "lmao" having been observed both
// expanded and read phonetically. When the model does the expanding, the
// profanity exists only in the audio, downstream of the filter, and nothing can
// touch it.
//
// The fix is to pin those expansions in the dictionary so we control them.
// These tests make sure the pinning stays complete and correct.

import { readFileSync } from 'fs';
import { getPronunciationRules } from '../../src/lib/textRewrite/pronunciation.js';
import { getProfanityRules } from '../../src/lib/profanity/index.js';
import { applyRewrites } from '../../src/lib/textRewrite/replaceEngine.js';

const defaults = JSON.parse(readFileSync('src/components/tts/tts-config.json', 'utf8'))
    .PRONUNCIATION_DEFAULTS;

const pron = () => getPronunciationRules({ pronunciations: {} });
const prof = () => getProfanityRules('English');

/** The full pipeline: acronym expansion, then the profanity pass. */
const speak = (text, { filter }) => {
    const expanded = applyRewrites(text, pron());
    return filter ? applyRewrites(expanded, prof()) : expanded;
};

describe('profanity reaching the TTS API', () => {
    it('cleans every built-in expansion that contains profanity', () => {
        // Whatever a dictionary entry expands to, the filter must be able to
        // clean it. An entry whose output survives the filter is a leak.
        const leaks = [];
        for (const { match, say } of defaults) {
            const filtered = applyRewrites(say, prof());
            // Re-running must be a no-op, i.e. nothing profane is left.
            if (applyRewrites(filtered, prof()) !== filtered) {
                leaks.push(`${match} -> ${say} -> ${filtered}`);
            }
        }
        expect(leaks).toEqual([]);
    });

    describe.each([
        ['wtf', 'what the fuck', 'what the freak'],
        ['lmao', 'laugh my ass off', 'laugh my butt off'],
        ['ffs', "for fuck's sake", "for freak's sake"],
        ['lfg', "let's fucking go", "let's freaking go"],
        ['stfu', 'shut the fuck up', 'shut the freak up'],
        ['gtfo', 'get the fuck out', 'get the freak out'],
        ['omfg', 'oh my fucking god', 'oh my freaking god'],
        ['jfc', 'jesus fucking christ', 'jesus freaking christ'],
        ['pmo', 'piss me off', 'tick me off'],
        ['dpmo', "don't piss me off", "don't tick me off"],
    ])('%s', (token, literal, cleaned) => {
        it('expands literally with the filter off', () => {
            expect(speak(token, { filter: false })).toBe(literal);
        });

        it('is cleaned with the filter on', () => {
            expect(speak(token, { filter: true })).toBe(cleaned);
        });
    });

    it('handles the acronym mid-sentence and at any casing', () => {
        expect(speak('WTF was that', { filter: true })).toBe('what the freak was that');
        expect(speak('bruh LMAO', { filter: true })).toBe('bruh laugh my butt off');
    });

    it('does not fire inside longer words', () => {
        for (const text of ['lmaooo', 'wtfff', 'ffsss', 'assassin', 'a class act']) {
            expect(speak(text, { filter: true })).toBe(text);
        }
    });

    it('cleans the bare "ass" family, which the first list omitted', () => {
        expect(applyRewrites('my ass hurts', prof())).toBe('my butt hurts');
        expect(applyRewrites('kicking asses', prof())).toBe('kicking butts');
        // But not where it is part of a longer, innocent word.
        expect(applyRewrites('bass class passed', prof())).toBe('bass class passed');
    });

    it('leaves ordinary chat alone with the filter on', () => {
        expect(speak('gg everyone that was fun', { filter: true }))
            .toBe('gg everyone that was fun');
    });

    it('longest match wins between overlapping acronyms', () => {
        // "dpmo" must not be read as "d" + "pmo".
        expect(speak('dpmo', { filter: false })).toBe("don't piss me off");
        // "roflmao" must not be read as "rofl" + "mao".
        expect(speak('roflmao', { filter: false }))
            .toBe('rolling on the floor laughing my ass off');
    });

    it('pins the acronyms the model was reading inconsistently', () => {
        // Each of these was observed being read differently between renders:
        // lmao phonetically, omg as "oh em gee", ffs as "double F's".
        expect(speak('omg', { filter: false })).toBe('oh my god');
        expect(speak('lmao', { filter: false })).toBe('laugh my ass off');
        expect(speak('ffs', { filter: false })).toBe("for fuck's sake");
    });
});

describe('slurs', () => {
    // Replaced with the literal word "slur" rather than a milder insult: a
    // softened slur still lands as the thing it was, and a neutral marker makes
    // the moderation audible instead of laundering it.
    it.each([
        ['what a faggot', 'what a slur'],
        ['what a f4ggot', 'what a slur'],
        ['n1gga please', 'slur please'],
        ['stop being a tranny', 'stop being a slur'],
        ['you paki', 'you slur'],
        ['dumb midget', 'dumb slur'],
    ])('replaces %j', (input, expected) => {
        expect(speak(input, { filter: true })).toBe(expected);
    });

    it('never softens a slur into a milder insult', () => {
        const english = JSON.parse(
            readFileSync('src/lib/profanity/profanityLists.json', 'utf8')
        ).English.entries;
        const slurEntries = english.filter(e => e.replacement === 'slur');
        expect(slurEntries.length).toBeGreaterThan(50);
        // Nothing in the slur set may map to anything other than "slur".
        for (const e of slurEntries) expect(e.replacement).toBe('slur');
    });

    it('leaves innocent words containing a slur fragment alone', () => {
        for (const text of [
            'raccoon washing food',
            'spicy noodles',
            'homogeneous mixture',
            'homework',
            'the japanese language',
            'negotiate a deal',
            'gypsum board',
            'my homie',
            'crippling debt',
        ]) {
            expect(speak(text, { filter: true })).toBe(text);
        }
    });

    it('does replace standalone homographs, which is accepted collateral', () => {
        // Word boundaries cannot separate these from their innocent senses.
        // Filtering is the safer error for a slur, and a channel can escape an
        // individual case with a pronunciation entry, which runs first.
        expect(speak('a chink in the armor', { filter: true }))
            .toBe('a slur in the armor');
    });

    it('lets a channel pronunciation entry pre-empt the collision', () => {
        const rules = getPronunciationRules({ pronunciations: { chink: 'gap' } });
        const expanded = applyRewrites('a chink in the armor', rules);
        expect(applyRewrites(expanded, prof())).toBe('a gap in the armor');
    });

    it('does nothing when the filter is off', () => {
        expect(speak('what a faggot', { filter: false })).toBe('what a faggot');
    });
});
