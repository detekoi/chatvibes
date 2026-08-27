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
            expect(applyRewrites('brb food', builtIns())).toBe('be right back food');
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

        it('ignores a forged mask sentinel in the message', () => {
            // A chatter sending the Private Use Area sentinels verbatim could
            // otherwise get the restore pass to splice a copy of a real URL in
            // wherever they placed the forgery.
            const forged = 'check example.com and \uE0000\uE001 here lfg';
            const out = applyRewrites(forged, rules());
            expect(out).toBe('check example.com and 0 here lets fucking go');
            // Exactly one occurrence of the URL, and no sentinels survive.
            expect(out.match(/example\.com/g)).toHaveLength(1);
            expect(out).not.toMatch(/[\uE000\uE001]/);
        });

        it('strips sentinels even when there is no URL to restore', () => {
            // They would otherwise be forwarded to the TTS API as-is.
            expect(applyRewrites('plain \uE0000\uE001 text lfg', rules()))
                .toBe('plain 0 text lets fucking go');
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

        it('returns a map with no prototype to collide with', () => {
            // "constructor" is a legal match key. On a normal object it would
            // resolve through Object.prototype, so a bare lookup or `in` check
            // would treat it as present when it is not.
            const map = buildEffectiveMap({});
            expect(Object.getPrototypeOf(map)).toBeNull();
            expect(map.constructor).toBeUndefined();
            expect('constructor' in map).toBe(false);
        });

        it('stores "constructor" as an ordinary entry', () => {
            const map = buildEffectiveMap({ constructor: 'con struct or' });
            expect(map.constructor).toBe('con struct or');
            expect(applyRewrites('constructor', compileRules(map))).toBe('con struct or');
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

        it('does not thrash when channels interleave', () => {
            // The bot serves many channels at once and their messages arrive
            // interleaved. A single-slot cache would be invalidated on every
            // switch and recompile the whole dictionary each time.
            const a = { pronunciations: { acat: 'alpha cat' } };
            const b = { pronunciations: { bcat: 'beta cat' } };

            const a1 = getPronunciationRules(a);
            const b1 = getPronunciationRules(b);
            const a2 = getPronunciationRules(a);
            const b2 = getPronunciationRules(b);

            expect(a2).toBe(a1);
            expect(b2).toBe(b1);
            expect(a1).not.toBe(b1);
        });

        it('shares one rule set across channels with no overrides', () => {
            // Distinct config objects, but identical effective dictionaries.
            const first = getPronunciationRules({ pronunciations: {} });
            const second = getPronunciationRules({ pronunciations: {} });
            const third = getPronunciationRules({});
            expect(second).toBe(first);
            expect(third).toBe(first);
        });

        it('keeps channels isolated from each other', () => {
            const a = getPronunciationRules({ pronunciations: { acat: 'alpha cat' } });
            const b = getPronunciationRules({ pronunciations: { bcat: 'beta cat' } });

            expect(applyRewrites('acat bcat', a)).toBe('alpha cat bcat');
            expect(applyRewrites('acat bcat', b)).toBe('acat beta cat');
        });
    });
});

describe('script changes as word boundaries', () => {
    // Japanese, Chinese and Thai are written without spaces, so a Latin term
    // sitting against them has a letter on either side. The naive
    // (?<![\p{L}\p{N}_]) anchor therefore treated it as word-internal and never
    // fired — which is how those languages actually write it, so a term scoped
    // to Japanese would have looked effective while doing nothing.
    const rules = compileRules({ kwsk: '詳しく', ns: 'ナイスショット', gg: 'good game' });

    test.each([
        ['それkwskで', 'それ詳しくで', 'Kana on both sides'],
        ['これはnsです', 'これはナイスショットです', 'Kana on both sides'],
        ['kwsk お願い', '詳しく お願い', 'space before, Kana after'],
        ['ns！', 'ナイスショット！', 'punctuation after'],
        ['配信gg', '配信good game', 'Kanji before'],
    ])('%s -> %s (%s)', (input, expected) => {
        expect(applyRewrites(input, rules)).toBe(expected);
    });

    test.each([
        ['xkwsk', 'Latin letter before'],
        ['kwskx', 'Latin letter after'],
        ['ID:ns123', 'digit after'],
        ['1ns', 'digit before'],
    ])('%s is still left alone (%s)', (input) => {
        expect(applyRewrites(input, rules)).toBe(input);
    });

    test('English behaviour is unchanged by the relaxation', () => {
        const en = compileRules({ fr: 'for real', lol: 'el oh el' });
        expect(applyRewrites('fr real', en)).toBe('for real real');
        expect(applyRewrites('frfr', en)).toBe('frfr');
        expect(applyRewrites('before', en)).toBe('before');
        expect(applyRewrites('lollipop', en)).toBe('lollipop');
    });

    test('a digit-bearing term now matches against CJK, which cuts both ways', () => {
        // The upside: "おつo7です" is expanded. The cost: a term made only of
        // digits would fire inside a number written next to Kanji, which is why
        // 888 (proposed as applause) is left out of the dictionary — see
        // docs/pronunciation-language-proposals.md.
        const digits = compileRules({ o7: 'salute', 888: 'applause' });
        expect(applyRewrites('おつo7です', digits)).toBe('おつsaluteです');
        expect(applyRewrites('価格は888円', digits)).toBe('価格はapplause円');
    });
});

describe('URLs are never rewritten', () => {
    // This path had no coverage at all, which is how the corruption below
    // survived: rules ran over a sentinel-encoded index that lived in band with
    // the text being matched.
    const rules = compileRules({ fr: 'for real', gg: 'good game' });

    test('a dictionary key inside a URL is left alone', () => {
        const text = 'see https://example.com/fr/gg-page for details';
        expect(applyRewrites(text, rules)).toBe(text);
    });

    test('text around a URL is still rewritten', () => {
        expect(applyRewrites('gg see https://example.com fr', rules))
            .toBe('good game see https://example.com for real');
    });

    test('multiple URLs all survive', () => {
        const text = 'https://a.example.com and https://b.example.com';
        expect(applyRewrites(text, rules)).toBe(text);
    });

    test('a digit rule does not destroy URLs', () => {
        // The original bug. A match key may begin with \p{N}, so
        // "!tts pronounce 1 = one" is a supported thing for a moderator to do.
        // The URL placeholder was an index between two non-word sentinels, so a
        // digit rule rewrote the index inside the placeholder, the restore pass
        // stopped recognising it, and both URLs vanished — leaving private-use
        // characters in the text sent to the synthesiser.
        const digits = compileRules({ 1: 'one', 0: 'zero' });
        const text = 'check https://example.com/page1 and https://google.com';
        const out = applyRewrites(text, digits);
        expect(out).toBe(text);
        expect(out).not.toMatch(/[\uE000-\uF8FF]/);
    });

    test('digits outside a URL are still rewritten', () => {
        const digits = compileRules({ 1: 'one' });
        expect(applyRewrites('take 1 https://example.com/1', digits))
            .toBe('take one https://example.com/1');
    });

    test('private use characters in the message are dropped', () => {
        expect(applyRewrites('hi \uE000\uE001 there', rules)).toBe('hi  there');
    });

    test('a term adjacent to a URL still matches, as the mask boundary allowed', () => {
        expect(applyRewrites('https://example.com gg', rules))
            .toBe('https://example.com good game');
    });
});
