// tests/unit/lib/textRewrite.test.js
// The rewrite engine is a pure function, so no mocking is needed.

const {
    compileRules,
    compileMerged,
    applyRewrites,
    escapeLiteral,
} = await import('../../../src/lib/textRewrite/replaceEngine.js');

const {
    normalizeMatchKey,
    validateSay,
    buildEffectiveMap,
    getPronunciationRules,
    _resetPronunciationMemo,
    PRONUNCIATION_LIMITS,
} = await import('../../../src/lib/textRewrite/pronunciation.js');

/** The rule set most tests run against. */
const rules = () => compileRules({
    lfg: 'lets fucking go',
    ngl: 'not gonna lie',
    fr: 'for real',
    frfr: 'for real for real',
    iykyk: 'if you know you know',
});

describe('replaceEngine', () => {
    describe('word boundaries', () => {
        // The whole feature is not worth shipping if it breaks these.
        it('leaves "lol" alone when it is not a rule', () => {
            expect(applyRewrites('lol that is funny', rules())).toBe('lol that is funny');
        });

        it('does not match inside a longer word', () => {
            expect(applyRewrites('i love lollipop', rules())).toBe('i love lollipop');
            expect(applyRewrites('NGL angle ANGLE mingle', rules()))
                .toBe('not gonna lie angle ANGLE mingle');
        });

        it('does not match a key with a trailing letter', () => {
            expect(applyRewrites('ngly frs', rules())).toBe('ngly frs');
        });

        it('matches regardless of case', () => {
            expect(applyRewrites('LFG', rules())).toBe('lets fucking go');
            expect(applyRewrites('Lfg', rules())).toBe('lets fucking go');
            expect(applyRewrites('lFg', rules())).toBe('lets fucking go');
        });

        it('matches next to punctuation', () => {
            expect(applyRewrites('LFG! (LFG) LFG. LFG, LFG?', rules()))
                .toBe('lets fucking go! (lets fucking go) lets fucking go. lets fucking go, lets fucking go?');
        });

        it('honours non-ASCII boundaries, which \\b would not', () => {
            const es = compileRules({ mierda: 'miercoles' });
            expect(applyRewrites('que mierda y mierdas', es)).toBe('que miercoles y mierdas');
        });
    });

    describe('built-in dictionary false positives', () => {
        // Several built-ins are only two characters (fr, rn, mb, ty, np, jk,
        // af, wp, wb, gn, gm, yw). Word boundaries are the only thing keeping
        // them from firing inside ordinary words, so pin that down.
        const builtIns = () => getPronunciationRules({ pronunciations: {} });

        it.each([
            'lol that was funny',
            'i love lollipop',
            'lolz',
            'from friday to friend',
            'running to the barn',
            'maybe my brother',
            'web browser',
            'gnome gmail',
            'typing tyler',
            'npm install',
            'jkl keys',
            'after affects',
            'wpm typing test',
        ])('leaves %j untouched', (text) => {
            expect(applyRewrites(text, builtIns())).toBe(text);
        });

        it('still expands genuine chat usage', () => {
            expect(applyRewrites('ty for the sub', builtIns())).toBe('thank you for the sub');
            expect(applyRewrites('fr that was insane', builtIns())).toBe('for real that was insane');
        });

        it('does not expand "til", which usually means "until" in chat', () => {
            // The model already reads it as "till", which is right for that
            // sense, and "wait til tomorrow" -> "wait today i learned tomorrow"
            // is a much worse error than leaving it alone.
            expect(applyRewrites('wait til tomorrow', builtIns())).toBe('wait til tomorrow');
        });
    });

    describe('precedence and passes', () => {
        it('prefers the longest matching key', () => {
            expect(applyRewrites('frfr', rules())).toBe('for real for real');
            expect(applyRewrites('fr', rules())).toBe('for real');
        });

        it('never re-scans replacement text', () => {
            // If the pass cascaded, "a" would become "c c" instead of "b b".
            const cascade = compileRules({ a: 'b b', b: 'c' });
            expect(applyRewrites('a', cascade)).toBe('b b');
        });
    });

    describe('URL handling', () => {
        it('does not expand a key inside a URL', () => {
            expect(applyRewrites('check https://lfg.example.com/ngl now', rules()))
                .toBe('check https://lfg.example.com/ngl now');
        });

        it('restores the right URL when the message also contains digits', () => {
            // A bare-digit placeholder would splice the URL over the "3" here.
            expect(applyRewrites('I have 3 cats https://x.com and lfg', rules()))
                .toBe('I have 3 cats https://x.com and lets fucking go');
        });

        it('restores several URLs in order', () => {
            expect(applyRewrites('a.com then b.org lfg', rules()))
                .toBe('a.com then b.org lets fucking go');
        });
    });

    describe('compileRules', () => {
        it('returns null when there is nothing to match', () => {
            expect(compileRules({})).toBeNull();
            expect(compileRules(null)).toBeNull();
        });

        it('drops entries with an empty replacement', () => {
            // An empty replacement can filter a message down to "", and every
            // caller drops empty text rather than speaking it.
            expect(compileRules({ x: '', y: 'z' }).size).toBe(1);
            expect(compileRules({ x: '' })).toBeNull();
        });

        it('escapes regex metacharacters in keys', () => {
            const meta = compileRules({ 'c++': 'see plus plus' });
            expect(applyRewrites('i like c++ a lot', meta)).toBe('i like see plus plus a lot');
        });

        it('supports case-sensitive rule sets', () => {
            const cs = compileRules({ IT: 'eye tee' }, { caseSensitive: true });
            expect(applyRewrites('IT', cs)).toBe('eye tee');
            expect(applyRewrites('it', cs)).toBe('it');
        });
    });

    describe('applyRewrites edge cases', () => {
        it('passes text through untouched when there are no rules', () => {
            expect(applyRewrites('anything', null)).toBe('anything');
        });

        it('handles empty and non-string input', () => {
            expect(applyRewrites('', rules())).toBe('');
            expect(applyRewrites(null, rules())).toBeNull();
        });

        it('does not alter text that matches nothing', () => {
            expect(applyRewrites('no matches at all here', rules())).toBe('no matches at all here');
        });

        it('is not affected by a reused rule set', () => {
            // A shared regex carries lastIndex between calls when it has /g.
            const r = rules();
            expect(applyRewrites('lfg', r)).toBe('lets fucking go');
            expect(applyRewrites('lfg', r)).toBe('lets fucking go');
            expect(applyRewrites('lfg', r)).toBe('lets fucking go');
        });
    });

    describe('compileMerged', () => {
        it('lets later sources win', () => {
            const merged = compileMerged({ lfg: 'a' }, { lfg: 'b' });
            expect(applyRewrites('lfg', merged)).toBe('b');
        });

        it('ignores null sources', () => {
            const merged = compileMerged(null, { lfg: 'a' }, undefined);
            expect(applyRewrites('lfg', merged)).toBe('a');
        });
    });

    it('escapeLiteral escapes every regex metacharacter', () => {
        expect(escapeLiteral('a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o'))
            .toBe('a\\.b\\*c\\+d\\?e\\^f\\$g\\{h\\}i\\(j\\)k\\|l\\[m\\]n\\\\o');
    });
});

describe('pronunciation', () => {
    beforeEach(() => _resetPronunciationMemo());

    describe('normalizeMatchKey', () => {
        it('lowercases and collapses whitespace', () => {
            expect(normalizeMatchKey('  LFG  ')).toBe('lfg');
            expect(normalizeMatchKey('i  know   that')).toBe('i know that');
        });

        it('rejects keys containing a dot', () => {
            // Firestore splits field paths on ".", so such a key would write
            // to the wrong nesting.
            expect(normalizeMatchKey('a.b')).toBeNull();
        });

        it('rejects the Firestore reserved prefix', () => {
            expect(normalizeMatchKey('__proto')).toBeNull();
        });

        it('rejects empty and over-length keys', () => {
            expect(normalizeMatchKey('')).toBeNull();
            expect(normalizeMatchKey('   ')).toBeNull();
            expect(normalizeMatchKey('x'.repeat(PRONUNCIATION_LIMITS.MAX_MATCH_LENGTH + 1))).toBeNull();
        });

        it('rejects non-strings', () => {
            expect(normalizeMatchKey(null)).toBeNull();
            expect(normalizeMatchKey(42)).toBeNull();
        });

        it('accepts letters, digits, apostrophes and hyphens', () => {
            expect(normalizeMatchKey("that's")).toBe("that's");
            expect(normalizeMatchKey('1v1')).toBe('1v1');
            expect(normalizeMatchKey('e-girl')).toBe('e-girl');
        });

        it('strips control characters', () => {
            expect(normalizeMatchKey('lf g')).toBe('lfg');
        });
    });

    describe('validateSay', () => {
        it('accepts a normal phrase', () => {
            expect(validateSay('  lets   go ')).toEqual({ ok: true, value: 'lets go' });
        });

        it('rejects empty, which would silently drop the message', () => {
            expect(validateSay('').ok).toBe(false);
            expect(validateSay('   ').ok).toBe(false);
        });

        it('rejects over-length values', () => {
            expect(validateSay('x'.repeat(PRONUNCIATION_LIMITS.MAX_SAY_LENGTH + 1)).ok).toBe(false);
        });

        it('rejects links', () => {
            expect(validateSay('go to example.com').ok).toBe(false);
            expect(validateSay('https://x.com').ok).toBe(false);
        });
    });

    describe('buildEffectiveMap', () => {
        it('adds a channel entry', () => {
            expect(buildEffectiveMap({ wcat: 'wildcat' }).wcat).toBe('wildcat');
        });

        it('lets a channel entry override a built-in of the same name', () => {
            const withDefault = buildEffectiveMap({});
            const key = Object.keys(withDefault)[0];
            if (!key) return; // no built-ins configured yet
            expect(buildEffectiveMap({ [key]: 'custom' })[key]).toBe('custom');
        });

        it('treats an empty value as "disable this built-in"', () => {
            const withDefault = buildEffectiveMap({});
            const key = Object.keys(withDefault)[0];
            if (!key) return;
            expect(buildEffectiveMap({ [key]: '' })[key]).toBeUndefined();
        });

        it('tolerates null', () => {
            expect(() => buildEffectiveMap(null)).not.toThrow();
        });
    });

    describe('getPronunciationRules', () => {
        it('returns null when the feature is switched off', () => {
            expect(getPronunciationRules({ pronunciationEnabled: false, pronunciations: { a: 'b' } }))
                .toBeNull();
        });

        it('compiles a channel dictionary', () => {
            const r = getPronunciationRules({ pronunciations: { wcat: 'wildcat' } });
            expect(applyRewrites('hey wcat', r)).toBe('hey wildcat');
        });

        it('reuses the compiled set for the same object', () => {
            const cfg = { pronunciations: { wcat: 'wildcat' } };
            expect(getPronunciationRules(cfg)).toBe(getPronunciationRules(cfg));
        });

        it('recompiles when the snapshot listener swaps in a new object', () => {
            const first = getPronunciationRules({ pronunciations: { wcat: 'wildcat' } });
            const second = getPronunciationRules({ pronunciations: { wcat: 'wild cat' } });
            expect(first).not.toBe(second);
            expect(applyRewrites('wcat', second)).toBe('wild cat');
        });
    });
});
