// tests/unit/profanityLists.test.js
// profanityLists.json is hand-authored across 40 languages, so these checks are
// what keep it honest. Most of them guard against a defect that would be
// invisible in review but harmful at runtime.

import { readFileSync } from 'fs';
import { applyRewrites } from '../../src/lib/textRewrite/replaceEngine.js';
import {
    getProfanityRules,
    getProfanityListInfo,
    getSupportedLanguages,
} from '../../src/lib/profanity/index.js';

const ttsConfig = JSON.parse(readFileSync('src/components/tts/tts-config.json', 'utf8'));
const lists = JSON.parse(readFileSync('src/lib/profanity/profanityLists.json', 'utf8'));

const languages = Object.keys(lists).filter(k => !k.startsWith('_'));
const VALID_CONFIDENCE = ['high', 'medium', 'low'];

describe('profanityLists.json', () => {
    test('every language boost except auto has a list', () => {
        const expected = ttsConfig.VALID_LANGUAGE_BOOSTS.filter(l => l !== 'auto');
        const missing = expected.filter(l => !lists[l]);
        expect(missing).toEqual([]);
    });

    test('no list exists for a language that is not a valid boost', () => {
        const valid = new Set(ttsConfig.VALID_LANGUAGE_BOOSTS);
        expect(languages.filter(l => !valid.has(l))).toEqual([]);
    });

    describe.each(languages)('%s', (language) => {
        const list = lists[language];
        const entries = list.entries;

        test('declares a confidence level', () => {
            expect(VALID_CONFIDENCE).toContain(list.confidence);
        });

        test('has at least one entry', () => {
            expect(entries.length).toBeGreaterThan(0);
        });

        test('every term and replacement is a non-empty string', () => {
            // An empty replacement can reduce a message to "", and every caller
            // drops empty text instead of speaking it. A filter that silently
            // disappears messages is worse than no filter.
            for (const e of entries) {
                expect(typeof e.term).toBe('string');
                expect(e.term.trim()).not.toBe('');
                expect(typeof e.replacement).toBe('string');
                expect(e.replacement.trim()).not.toBe('');
            }
        });

        test('terms are lowercase', () => {
            const wrong = entries.filter(e => e.term !== e.term.toLowerCase());
            expect(wrong.map(e => e.term)).toEqual([]);
        });

        test('terms are unique', () => {
            const seen = new Set();
            const dupes = [];
            for (const e of entries) {
                if (seen.has(e.term)) dupes.push(e.term);
                seen.add(e.term);
            }
            expect(dupes).toEqual([]);
        });

        test('no term is its own replacement', () => {
            const same = entries.filter(e => e.term === e.replacement.toLowerCase());
            expect(same.map(e => e.term)).toEqual([]);
        });

        test('no replacement is itself a filtered term', () => {
            // Single-pass replacement means such an entry would leave profanity
            // in the output rather than cascading into a second substitution.
            const terms = new Set(entries.map(e => e.term));
            const leaks = entries.filter(e => terms.has(e.replacement.toLowerCase()));
            expect(leaks.map(e => `${e.term} -> ${e.replacement}`)).toEqual([]);
        });

        test('no control characters', () => {
            // These come back from the TTS API as error 1042, which the retry
            // loop converts into a Wavespeed fallback on every message.
            // eslint-disable-next-line no-control-regex
            const bad = /[\u0000-\u001F\u007F-\u009F]/;
            const hits = entries.filter(e => bad.test(e.term) || bad.test(e.replacement));
            expect(hits).toEqual([]);
        });

        test('compiles to a usable rule set', () => {
            const rules = getProfanityRules(language);
            expect(rules).not.toBeNull();
            expect(rules.size).toBe(entries.length);
        });

        test('each term is actually replaced', () => {
            const rules = getProfanityRules(language);
            for (const e of entries) {
                const out = applyRewrites(e.term, rules);
                expect(out).toBe(e.replacement);
            }
        });
    });
});

describe('getProfanityRules', () => {
    test('auto falls back to English', () => {
        expect(getProfanityRules('auto')).toBe(getProfanityRules('English'));
    });

    test('the dashboard spellings of auto also fall back to English', () => {
        expect(getProfanityRules('Automatic')).toBe(getProfanityRules('English'));
        expect(getProfanityRules('None')).toBe(getProfanityRules('English'));
    });

    test('an unknown language yields no rules rather than throwing', () => {
        expect(getProfanityRules('Klingon')).toBeNull();
    });

    test('filters English profanity', () => {
        expect(applyRewrites('what the fuck', getProfanityRules('English')))
            .toBe('what the freak');
    });

    test('leaves clean text alone', () => {
        expect(applyRewrites('good game everyone', getProfanityRules('English')))
            .toBe('good game everyone');
    });

    test('does not fire inside a longer word', () => {
        // "damn" must not match inside "damnation".
        expect(applyRewrites('damnation', getProfanityRules('English'))).toBe('damnation');
    });

    test('unions two languages when a viewer diverges from the channel', () => {
        const both = getProfanityRules(['English', 'Spanish']);
        expect(applyRewrites('fuck and mierda', both)).toBe('freak and miércoles');
    });

    test('deduplicates and order does not matter', () => {
        expect(getProfanityRules(['English', 'Spanish']))
            .toBe(getProfanityRules(['Spanish', 'English', 'Spanish']));
    });

    test('a single language and a one-element array agree', () => {
        expect(getProfanityRules('English')).toBe(getProfanityRules(['English']));
    });

    test('an unknown language alongside a known one keeps the known one', () => {
        const rules = getProfanityRules(['Klingon', 'English']);
        expect(applyRewrites('fuck', rules)).toBe('freak');
    });
});

describe('getProfanityListInfo', () => {
    test('reports coverage for a real language', () => {
        const info = getProfanityListInfo('Spanish');
        expect(info.language).toBe('Spanish');
        expect(info.entries).toBeGreaterThan(0);
        expect(VALID_CONFIDENCE).toContain(info.confidence);
    });

    test('flags that auto is being served the English list', () => {
        const info = getProfanityListInfo('auto');
        expect(info.language).toBe('English');
        expect(info.isFallback).toBe(true);
    });

    test('does not flag English itself as a fallback', () => {
        expect(getProfanityListInfo('English').isFallback).toBe(false);
    });
});

describe('getSupportedLanguages', () => {
    test('excludes the readme key', () => {
        expect(getSupportedLanguages().some(l => l.startsWith('_'))).toBe(false);
    });
});
