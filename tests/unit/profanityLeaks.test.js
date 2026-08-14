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

describe('non-English channels', () => {
    // The acronym dictionary is English-only and runs for every channel, so a
    // Spanish channel still gets "let's fucking go" out of "lfg". Loading only
    // the Spanish profanity list would send that through untouched, which is
    // how ttsQueue ends up asking for English on top of the channel language.
    it.each([
        ['lfg', "let's freaking go"],
        ['wtf', 'what the freak'],
        ['stfu', 'shut the freak up'],
        ['lmfao', 'laughing my freaking butt off'],
        ['omfg', 'oh my freaking god'],
    ])('cleans the English expansion of %s on a Spanish channel', (token, expected) => {
        const expanded = applyRewrites(token, pron());
        const rules = getProfanityRules(['Spanish', 'Spanish', 'English']);
        expect(applyRewrites(expanded, rules)).toBe(expected);
    });

    it('still cleans the channel language too', () => {
        const rules = getProfanityRules(['Spanish', 'Spanish', 'English']);
        expect(applyRewrites('que mierda', rules)).toBe('que miércoles');
    });
});

describe('scripts written without spaces between words', () => {
    // \p{L} lookarounds are the wrong boundary test here: every neighbouring
    // character is a letter, even at a genuine word edge. Matching is validated
    // against Intl word segmentation instead.
    it.each([
        ['Chinese', '你在操什么', '你在哎呀什么'],
        ['Chinese', '他妈的太难了', '真是的太难了'],
        ['Japanese', 'あいつ死ねよ', 'あいつやめてよ'],
        ['Japanese', 'くそゲーム', 'しまったゲーム'],
        ['Thai', 'มันเหี้ยมาก', 'มันแย่จังมาก'],
    ])('%s filters mid-sentence: %s', (lang, input, expected) => {
        expect(applyRewrites(input, getProfanityRules(lang))).toBe(expected);
    });

    it.each([
        ['Chinese', '操作系统'],   // "operating system", not 操 on its own
        ['Chinese', '体操比赛'],   // "gymnastics competition"
        ['Chinese', '操场很大'],   // "the playground is big"
        ['Chinese', '操心'],       // "to worry"
        ['Japanese', 'ばかり食べる'], // "ばかり" (only), not "ばか" (idiot)
        ['Japanese', '馬車に乗る'],   // "horse carriage"
        ['Thai', 'กูเกิลค้นหา'],     // "Google search"
    ])('%s leaves the innocent compound %s alone', (lang, input) => {
        expect(applyRewrites(input, getProfanityRules(lang))).toBe(input);
    });

    it('does not change how Latin-script text is matched', () => {
        // A rule set spanning both kinds of script must not loosen the English
        // side: those terms keep their own lookarounds in the pattern.
        const mixed = getProfanityRules(['Chinese', 'English']);
        expect(applyRewrites('lollipop assassin a class act', mixed))
            .toBe('lollipop assassin a class act');
        expect(applyRewrites('what the fuck', mixed)).toBe('what the freak');
        expect(applyRewrites('操作系统', mixed)).toBe('操作系统');
        expect(applyRewrites('你在操什么', mixed)).toBe('你在哎呀什么');
    });
});

describe('list hygiene', () => {
    it('has no term mixing Latin with Cyrillic or Greek characters', () => {
        // A homoglyph typo compiles fine and simply never matches: the Japanese
        // "aho" entry began with a Cyrillic "а" and was dead on arrival.
        const lists = JSON.parse(
            readFileSync('src/lib/profanity/profanityLists.json', 'utf8')
        );
        const mixed = [];
        for (const [lang, data] of Object.entries(lists)) {
            if (lang.startsWith('_')) continue;
            for (const { term } of data.entries) {
                const latin = /[a-z]/i.test(term);
                const cyrillic = /[Ѐ-ӿ]/.test(term);
                const greek = /[Ͱ-Ͽ]/.test(term);
                if (latin && (cyrillic || greek)) mixed.push(`${lang}: ${term}`);
            }
        }
        expect(mixed).toEqual([]);
    });

    it('filters romaji "aho" in Japanese', () => {
        expect(applyRewrites('aho', getProfanityRules('Japanese'))).not.toBe('aho');
    });
});
