// tests/unit/i18nCatalogs.test.js
// The catalogs are machine-translated and committed, so these checks are what
// stand between a bad model response and a channel hearing it out loud.

import { readFileSync, readdirSync } from 'fs';
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

// Every catalog string is fed to a speech synthesiser, which reads an
// abbreviation as its letters. Translation models reach for them constantly
// when a string is short, and it is invisible in review unless you speak the
// language, so it is asserted rather than eyeballed.
describe('no catalog abbreviates a word', () => {
    // One to four letters followed by a period, where the period ends the token
    // rather than the sentence. Anchored on a letter so the legitimate "{subtext}. "
    // sentence ending does not match.
    const ABBREVIATION = /(?:^|[\s(])(\p{L}{1,4})\.(?=\s|$)/u;
    const all = [...present];

    test.each(all)('%s', (locale) => {
        const catalog = read(`${locale}.json`);
        const hits = Object.entries(catalog)
            .filter(([k, v]) => !k.startsWith('_') && typeof v === 'string' && ABBREVIATION.test(v))
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
