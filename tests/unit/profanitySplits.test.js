// tests/unit/profanitySplits.test.js
// profanitySplits.json is generated from the English list with a dictionary
// that CI does not have. These checks need only the two JSON files: every split
// of every eligible term must be in the file, as matched or dropped, so a term
// added without running the script again fails here.

import { readFileSync } from 'fs';
import { applyRewrites } from '../../src/lib/textRewrite/replaceEngine.js';
import { getProfanityRules } from '../../src/lib/profanity/index.js';

const lists = JSON.parse(readFileSync('src/lib/profanity/profanityLists.json', 'utf8'));
const generated = JSON.parse(readFileSync('src/lib/profanity/profanitySplits.json', 'utf8'));
const english = generated.English;
const terms = new Set(lists.English.entries.map(e => e.term));

/** Every split the script considers, as the script computes it. */
function expectedSplits() {
    const out = {};
    for (const term of terms) {
        if (!/^[a-z]+$/.test(term) || term.length < 4) continue;
        for (let i = 1; i < term.length; i++) {
            const left = term.slice(0, i);
            const right = term.slice(i);
            const split = `${left} ${right}`;
            if (terms.has(split) || terms.has(left) || terms.has(right)) continue;
            out[split] = term;
        }
    }
    return out;
}

describe('profanitySplits.json', () => {
    test('is up to date with the English list', () => {
        const recorded = { ...english.splits, ...english.dropped };
        expect(recorded).toEqual(expectedSplits());
    });

    test('no split is both matched and dropped', () => {
        const both = Object.keys(english.splits).filter(s => s in english.dropped);
        expect(both).toEqual([]);
    });

    test('no split equals a term or the replacement of a term', () => {
        // A split that equals a replacement would filter the output of another rule.
        const replacements = new Set(lists.English.entries.map(e => e.replacement.toLowerCase()));
        const clashes = Object.keys(english.splits).filter(s => terms.has(s) || replacements.has(s));
        expect(clashes).toEqual([]);
    });
});

describe('split terms in the filter', () => {
    const rules = getProfanityRules(['English']);
    const filter = text => applyRewrites(text, rules);

    test.each([
        ['Son of a bi tch', 'Son of a biscuit'],
        ['fu ck this', 'freak this'],
        ['what the f uck', 'what the freak'],
    ])('replaces %j', (input, output) => {
        expect(filter(input)).toBe(output);
    });

    test('a split takes the replacement of its term', () => {
        const bitch = lists.English.entries.find(e => e.term === 'bitch').replacement;
        expect(filter('bi tch')).toBe(bitch);
    });

    test.each([
        "Let's hit it",
        "it's hitting hard",
        'who re-entered the game',
        'a bit chunky',
        'push it',
    ])('leaves %j unchanged', (input) => {
        expect(filter(input)).toBe(input);
    });

    test('the word count in status is the hand-authored list only', () => {
        // getProfanityListInfo reports list.entries.length. The splits are forms
        // of those entries, not more words.
        expect(rules.size).toBe(terms.size + Object.keys(english.splits).length);
    });
});
