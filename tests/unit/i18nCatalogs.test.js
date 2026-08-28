// tests/unit/i18nCatalogs.test.js
// The catalogs are machine-translated and committed, so these checks are what
// stand between a bad model response and a channel hearing it out loud.

import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { validateCatalog } from '../../src/i18n/validate.js';
import { supportedLocales, DEFAULT_LOCALE } from '../../src/i18n/index.js';

const MESSAGES_DIR = 'src/i18n/messages';
const MAX_CHAT_LENGTH = 500; // mirrors MAX_MESSAGE_LENGTH in src/lib/chatSender.js

const read = (f) => JSON.parse(readFileSync(path.join(MESSAGES_DIR, f), 'utf8'));
const source = read(`${DEFAULT_LOCALE}.json`);
const present = readdirSync(MESSAGES_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('.'))
    .map(f => f.replace(/\.json$/, ''));
const translated = present.filter(l => l !== DEFAULT_LOCALE);

describe('locales.json', () => {
    const ttsConfig = JSON.parse(readFileSync('src/components/tts/tts-config.json', 'utf8'));
    const locales = JSON.parse(readFileSync('src/i18n/locales.json', 'utf8'));

    test('every languageBoost except auto maps to a locale', () => {
        const expected = ttsConfig.VALID_LANGUAGE_BOOSTS.filter(l => l !== 'auto');
        expect(expected.filter(l => !locales.LANGUAGE_BOOSTS[l])).toEqual([]);
    });

    test('no mapping exists for a languageBoost the TTS provider does not accept', () => {
        const valid = new Set(ttsConfig.VALID_LANGUAGE_BOOSTS);
        expect(Object.keys(locales.LANGUAGE_BOOSTS).filter(l => !valid.has(l))).toEqual([]);
    });

    test('BCP-47 codes are unique and well-formed', () => {
        const codes = Object.values(locales.LANGUAGE_BOOSTS).map(v => v.bcp47);
        expect(codes.filter((c, i) => codes.indexOf(c) !== i)).toEqual([]);
        // Intl throws on a malformed tag, which is the check that matters:
        // a bad tag would silently disable plural selection for that language.
        for (const c of codes) expect(() => new Intl.PluralRules(c)).not.toThrow();
    });

    test('every Twitch broadcaster_language points at a real languageBoost', () => {
        const valid = new Set(Object.keys(locales.LANGUAGE_BOOSTS));
        const bad = Object.entries(locales.TWITCH_BROADCASTER_LANGUAGE).filter(([, lb]) => !valid.has(lb));
        expect(bad).toEqual([]);
    });

    test('Twitch codes with no synthesis target are absent rather than guessed', () => {
        // "other" and "asl" must leave a channel on auto; mapping them to a
        // wrong language changes what the bot says with no way to notice.
        expect(locales.TWITCH_BROADCASTER_LANGUAGE.other).toBeUndefined();
        expect(locales.TWITCH_BROADCASTER_LANGUAGE.asl).toBeUndefined();
    });
});

describe('the English source catalog', () => {
    test('validates against itself', () => {
        expect(validateCatalog(DEFAULT_LOCALE, source, source, { maxChatLength: MAX_CHAT_LENGTH })).toEqual([]);
    });

    test('has no empty messages', () => {
        expect(Object.entries(source).filter(([, v]) => !String(v).trim()).map(([k]) => k)).toEqual([]);
    });
});

// A speech synthesiser reads an abbreviation as its letters, so "мес." is heard
// as "эм е эс" rather than "месяцев". Translation models reach for abbreviations
// constantly when a string is short, and it is invisible in review unless you
// speak the language, so it is asserted rather than eyeballed.
//
// Scoped to the namespaces that are actually SPOKEN. The cmd.* messages are chat
// replies read with the eyes, where an abbreviation is ordinary writing —
// Catalan "p. ex." and Russian "см." are both correct there, and flagging them
// would push translators into stilted prose for no gain.
describe('no spoken catalog abbreviates a word', () => {
    const SPOKEN = /^(announce|emoji|emote)\./;
    // A short token, a period, then a space and a LOWERCASE letter — a period
    // that does not end a sentence. That mid-sentence position is what separates
    // an abbreviation from an ordinary short word: "мес. подряд" is "месяцев"
    // truncated, while "bits. Use" is just a sentence ending in a short word.
    //
    // Requiring the lowercase continuation is what makes this usable. Matching
    // any short-token period flagged 42 English keys — every sentence ending in
    // "TTS.", "time." or "bits." — which is no signal at all.
    //
    // The cost is that an abbreviation at the very end of a string is missed.
    // Trailing ones are rarer, and a check nobody can trust because it cries
    // wolf on the source language is worth less than a narrower one that holds.
    const ABBREVIATION = /(?:^|[\s(])\p{L}{1,4}\.\s+\p{Ll}/u;
    const all = [...present];

    test.each(all)('%s', (locale) => {
        const catalog = read(`${locale}.json`);
        const hits = Object.entries(catalog)
            .filter(([k, v]) => SPOKEN.test(k) && typeof v === 'string' && ABBREVIATION.test(v))
            .map(([k, v]) => `${k}: ${v}`);
        expect(hits).toEqual([]);
    });
});

describe('translated catalogs', () => {
    test('every catalog file is a locale the bot supports', () => {
        const supported = new Set([...supportedLocales(), DEFAULT_LOCALE]);
        expect(present.filter(l => !supported.has(l))).toEqual([]);
    });

    // Runs over whatever has been generated so far, so the suite tightens as
    // locales land instead of blocking on all 40 arriving at once.
    if (translated.length) {
        test.each(translated)('%s is complete, well-formed and plural-correct', (locale) => {
            expect(validateCatalog(locale, read(`${locale}.json`), source, { maxChatLength: MAX_CHAT_LENGTH })).toEqual([]);
        });
    } else {
        test.todo('no translated catalogs generated yet');
    }
});

describe('plural branches must not differ in shape', () => {
    // A plural message can vary the WORDING between categories; it cannot vary
    // the STRUCTURE. A language whose only category is `other` uses that one
    // branch for every number including one, so if the singular omits the count
    // and the plural includes it, that language has to pick — Chinese rendered a
    // single emote as "(1 个X表情)" where English says "(X emote)", and the emote
    // fallback came out as "(1Kappa)" where English says bare "Kappa".
    //
    // Where the shapes genuinely differ, use two keys and let the caller choose.
    const shape = (branch) => [branch.includes('#'), /^\s*\(/.test(branch)].join();

    test.each(Object.entries(source).filter(([k, v]) => !k.startsWith('_') && typeof v === 'string' && v.includes('plural')))(
        '%s keeps one and other structurally identical',
        (_key, pattern) => {
            const one = pattern.match(/\bone \{((?:[^{}]|\{[^{}]*\})*)\}/)?.[1];
            const other = pattern.match(/\bother \{((?:[^{}]|\{[^{}]*\})*)\}/)?.[1];
            if (one === undefined || other === undefined) return;
            expect(shape(one)).toBe(shape(other));
        },
    );
});

describe('the code and the catalog agree on which keys exist', () => {
    // A key the code calls but the catalog lacks renders as the key name itself,
    // spoken aloud; a key the catalog has but nothing calls is dead weight that
    // every locale keeps paying to translate. Neither shows up in a normal test
    // run, because both only surface on the specific message that uses them.
    const walk = (dir, out = []) => {
        for (const entry of readdirSync(dir)) {
            const full = path.join(dir, entry);
            if (statSync(full).isDirectory()) walk(full, out);
            else if (full.endsWith('.js')) out.push(full);
        }
        return out;
    };

    // Any quoted string equal to a key counts as a reference, not only a direct
    // t('...') call: keys also travel as options (propertyKey, hintKey), inside
    // ternaries, and through lookup tables. Matching only the call form reported
    // a third of the catalog as dead.
    const declared = new Set(Object.keys(source).filter(k => !k.startsWith('_')));

    // Matched on the namespaces keys actually use, NOT filtered against the
    // catalog. Collecting only strings already known to be declared made the
    // "key exists" assertion below tautological — it could never find a missing
    // one, which is the half of this pair that catches a typo.
    const KEY_SHAPED = /'((?:announce|cmd|emoji|emote|player)\.[a-zA-Z0-9._]+)'/g;
    const referenced = new Map();
    for (const file of walk('src')) {
        for (const match of readFileSync(file, 'utf8').matchAll(KEY_SHAPED)) {
            if (!referenced.has(match[1])) referenced.set(match[1], file);
        }
    }

    test('every key the code calls exists in the catalog', () => {
        const missing = [...referenced].filter(([key]) => !declared.has(key)).map(([key, file]) => `${key} (${file})`);
        expect(missing).toEqual([]);
    });

    test('every key in the catalog is called somewhere', () => {
        expect([...declared].filter(key => !referenced.has(key))).toEqual([]);
    });
});
