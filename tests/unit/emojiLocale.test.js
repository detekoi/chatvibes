// tests/unit/emojiLocale.test.js
// Emoji are described aloud, so an English label on a Spanish channel is heard,
// not just seen. These cover the locale plumbing and the skin-tone reordering
// bug that was invisible in English.

import { readFileSync } from 'fs';
import { replaceEmojisWithText, _internals } from '../../src/lib/emojiUtils.js';

describe('localized labels', () => {
    test.each([
        ['es', '🔥', 'fuego'],
        ['de', '🔥', 'Feuer'],
        ['ja', '🔥', '火'],
        ['ru', '🔥', 'огонь'],
    ])('%s describes %s using its own label', (locale, emoji, expected) => {
        expect(replaceEmojisWithText(`hey ${emoji}`, locale)).toContain(expected);
    });

    test('English is unchanged, and is the default when no locale is given', () => {
        expect(replaceEmojisWithText('hey 🔥', 'en')).toBe('hey (fire emoji)');
        expect(replaceEmojisWithText('hey 🔥')).toBe('hey (fire emoji)');
    });

    test.each(['ar', 'tr'])('%s keeps its own wrapper and falls back only on the label', (locale) => {
        // The wrapper and the label come from different places: the wrapper is
        // our catalog (all 40 locales), the label is emojibase (26 locales, of
        // which 22 overlap). These two have a wrapper but no labels, so they
        // degrade partially rather than all the way to English.
        const out = replaceEmojisWithText('hey 🔥', locale);
        expect(out).toContain('fire');            // label fell back
        expect(out).not.toBe('hey (fire emoji)'); // wrapper did not
    });

    test('a wrapper that legitimately matches English is not a fallback', () => {
        // Afrikaans borrows "emoji" and shares the word order, so its catalog
        // entry is identical to the English one. The output therefore looks like
        // a total fallback while being a correct translation — which is why the
        // case above names locales whose wrapper actually differs rather than
        // asserting "not English" across the board.
        const af = JSON.parse(readFileSync('src/i18n/messages/af.json', 'utf8'));
        expect(af['emoji.wrap']).toBe('({description} emoji)');
        expect(replaceEmojisWithText('hey 🔥', 'af')).toBe('hey (fire emoji)');
    });

    test('an unknown locale falls back on both, rather than loading nothing', () => {
        expect(replaceEmojisWithText('hey 🔥', 'zz-XX')).toBe('hey (fire emoji)');
    });

    test('the plural wrapper comes from the catalog, so word order is the translator\'s', () => {
        expect(replaceEmojisWithText('🔥🔥🔥', 'en')).toBe('(3 fire emojis)');
        // Russian has four plural categories; 3 is "few", which English cannot express.
        expect(replaceEmojisWithText('🔥🔥🔥', 'ru')).toMatch(/3/);
    });
});

describe('skin tone reordering', () => {
    const { formatLabel } = _internals;

    test('reorders an English tone label into spoken form', () => {
        expect(formatLabel('waving hand: medium skin tone', '👋🏽', 'en'))
            .toBe('medium skin tone waving hand');
    });

    test.each([
        ['es', 'mano saludando: tono de piel claro', '👋🏻'],
        ['ja', '手を振る: 薄い肌色', '👋🏻'],
        ['ru', 'машет рукой: очень светлый тон кожи', '👋🏻'],
        ['pl', 'machająca dłoń: karnacja jasna', '👋🏻'],
    ])('%s reorders too — the old check tested for the English words "skin tone"', (locale, label, emoji) => {
        const out = formatLabel(label, emoji, locale);
        expect(out).not.toContain(': ');
        expect(out.endsWith(label.split(': ')[0])).toBe(true);
    });

    test('a colon label that is NOT a skin tone is left alone', () => {
        // The reason the fix tests the emoji's codepoints rather than just the
        // presence of a colon: reordering this would mangle it.
        const label = 'family: man, woman, boy';
        expect(formatLabel(label, '👨‍👩‍👦', 'en')).toBe(label);
    });

    test('multiple tones are joined with the locale conjunction', () => {
        expect(formatLabel('women holding hands: light skin tone, dark skin tone', '👩🏻‍🤝‍👩🏿', 'en'))
            .toBe('light skin tone and dark skin tone women holding hands');
        expect(formatLabel('women holding hands: light skin tone, dark skin tone', '👩🏻‍🤝‍👩🏿', 'es'))
            .toContain(' y ');
    });
});

describe('lazy loading', () => {
    test('only the locales actually used are loaded', () => {
        // Each locale's dataset is ~760 KB; eager-loading the 22 available would
        // cost ~16 MB for languages an instance may never serve.
        _internals.labelMaps.clear();
        expect(_internals.labelMaps.size).toBe(0);
        replaceEmojisWithText('🔥', 'de');
        expect([..._internals.labelMaps.keys()]).toEqual(['de']);
        replaceEmojisWithText('🔥', 'de');
        expect(_internals.labelMaps.size).toBe(1);
    });

    test('unsupported locales share the English dataset rather than each loading one', () => {
        _internals.labelMaps.clear();
        replaceEmojisWithText('🔥', 'ar');
        replaceEmojisWithText('🔥', 'tr');
        expect([..._internals.labelMaps.keys()]).toEqual(['en']);
    });
});
