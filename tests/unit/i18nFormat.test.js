// tests/unit/i18nFormat.test.js
// The ICU subset is what makes the catalogs correct in languages the original
// English ternaries could not express, so plural-category coverage is the point
// of most of these cases rather than an edge case around it.

import { formatMessage, compile } from '../../src/i18n/format.js';

describe('argument substitution', () => {
    test('substitutes named arguments', () => {
        expect(formatMessage('{user} just followed!', { user: 'Bob' })).toBe('Bob just followed!');
    });

    test('a missing argument renders as empty rather than "undefined"', () => {
        // The tier fragment is legitimately absent on most events; printing
        // "undefined" into an announcement would be spoken aloud.
        expect(formatMessage('{user} subscribed{tier}!', { user: 'Bob' })).toBe('Bob subscribed!');
    });

    test('an interpolated value is never re-parsed as a pattern', () => {
        // Reward titles and usernames are attacker-influenced free text.
        expect(formatMessage('{user} redeemed {reward}', {
            user: 'Bob',
            reward: '{count, plural, other {pwned}}',
        })).toBe('Bob redeemed {count, plural, other {pwned}}');
    });
});

describe('plural categories', () => {
    const subs = '{count, plural, one {# sub} few {# subx} many {# subz} other {# subs}}';

    test('English uses one/other', () => {
        expect(formatMessage(subs, { count: 1 }, 'en')).toBe('1 sub');
        expect(formatMessage(subs, { count: 2 }, 'en')).toBe('2 subs');
    });

    test.each([
        ['ru', 1, '1 sub'], ['ru', 2, '2 subx'], ['ru', 5, '5 subz'],
        ['pl', 1, '1 sub'], ['pl', 2, '2 subx'], ['pl', 5, '5 subz'],
        ['cs', 1, '1 sub'], ['cs', 2, '2 subx'], ['cs', 5, '5 subs'],
        // Croatian has one/few/other and no `many`, so 5 lands on other. A
        // `many` branch written for it would be unreachable; the catalog
        // validator rejects that rather than letting it rot.
        ['hr', 1, '1 sub'], ['hr', 2, '2 subx'], ['hr', 5, '5 subs'],
    ])('%s selects a category English cannot express (%i)', (locale, count, expected) => {
        expect(formatMessage(subs, { count }, locale)).toBe(expected);
    });

    test('Arabic resolves all six categories distinctly', () => {
        const p = '{n, plural, zero {Z} one {O} two {T} few {F} many {M} other {X}}';
        const seen = [0, 1, 2, 3, 11, 100].map(n => formatMessage(p, { n }, 'ar'));
        expect(seen).toEqual(['Z', 'O', 'T', 'F', 'M', 'X']);
    });

    test.each(['ja', 'zh', 'ko', 'th', 'vi'])('%s has a single category, so other carries everything', (locale) => {
        expect(formatMessage(subs, { count: 1 }, locale)).toBe('1 subs');
        expect(formatMessage(subs, { count: 9 }, locale)).toBe('9 subs');
    });

    test('an exact =N branch wins over its category', () => {
        const p = '{n, plural, =0 {nobody} one {# person} other {# people}}';
        expect(formatMessage(p, { n: 0 }, 'en')).toBe('nobody');
        expect(formatMessage(p, { n: 1 }, 'en')).toBe('1 person');
    });

    test('a category absent from the pattern falls back to other', () => {
        expect(formatMessage('{n, plural, one {# sub} other {# subs}}', { n: 5 }, 'ru')).toBe('5 subs');
    });

    test('a non-numeric count is treated as zero rather than throwing', () => {
        expect(formatMessage('{n, plural, other {# bits}}', { n: undefined }, 'en')).toBe('0 bits');
    });
});

describe('select', () => {
    const said = '{g, select, he {He said} she {She said} other {They said}}';

    test('picks the named branch', () => {
        expect(formatMessage(said, { g: 'she' })).toBe('She said');
    });

    test('an unknown or missing key falls through to other', () => {
        expect(formatMessage(said, { g: 'xe' })).toBe('They said');
        expect(formatMessage(said, {})).toBe('They said');
    });

    test('a select nested in a plural keeps the enclosing #', () => {
        const p = '{n, plural, other {# {g, select, other {gifts}}}}';
        expect(formatMessage(p, { n: 3, g: 'x' }, 'en')).toBe('3 gifts');
    });
});

describe('number formatting', () => {
    test('# and numeric arguments use the locale separator', () => {
        expect(formatMessage('{n, plural, other {# bits}}', { n: 12345 }, 'en')).toBe('12,345 bits');
        expect(formatMessage('{n, plural, other {# bits}}', { n: 12345 }, 'de')).toBe('12.345 bits');
    });

    test('a string argument is not coerced through the number formatter', () => {
        // Super Chat amounts arrive pre-formatted with their own currency symbol.
        expect(formatMessage('for {amount}', { amount: '$5.00' })).toBe('for $5.00');
    });

    test('offset subtracts before both selection and #', () => {
        const p = '{n, plural, offset:1 one {# other person} other {# other people}}';
        expect(formatMessage(p, { n: 2 }, 'en')).toBe('1 other person');
        expect(formatMessage(p, { n: 4 }, 'en')).toBe('3 other people');
    });
});

describe('malformed patterns are rejected at compile time', () => {
    test.each([
        ['unbalanced brace', '{user just followed'],
        ['plural with no other branch', '{n, plural, one {#}}'],
        ['select with no other branch', '{g, select, he {x}}'],
        ['unsupported argument type', '{d, date, short}'],
        ['branch with no body', '{n, plural, one other {x}}'],
        ['empty argument', 'hello {}'],
    ])('%s', (_label, pattern) => {
        expect(() => compile(pattern)).toThrow();
    });
});
