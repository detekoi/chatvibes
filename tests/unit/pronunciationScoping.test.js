// tests/unit/pronunciationScoping.test.js
// The built-in dictionary is English acronyms applied to every channel, and a
// few of them are ordinary words elsewhere. These tests pin the scoping that
// stops those firing, and the cache key that makes the scoping actually reach
// the right channel.

import { readFileSync } from 'fs';
import {
    buildEffectiveMap,
    getPronunciationRules,
    _resetPronunciationMemo,
    PRONUNCIATION_DEFAULTS,
} from '../../src/lib/textRewrite/pronunciation.js';
import { applyRewrites } from '../../src/lib/textRewrite/replaceEngine.js';

const speak = (config, text) => applyRewrites(text, getPronunciationRules(config));
const channel = (languageBoost, pronunciations) => ({ languageBoost, pronunciations });

beforeEach(() => _resetPronunciationMemo());

describe('collisions with real words in other languages', () => {
    test.each([
        ['Polish', 'ty jesteś super', 'ty'],
        ['Czech', 'ty vole', 'ty'],
        ['Slovak', 'ty si dobry', 'ty'],
        ['Afrikaans', 'sit dit af', 'af'],
        ['Dutch', 'zet het af', 'af'],
        ['Polish', 'np taki tekst', 'np'],
        ['Czech', 'nvm co to je', 'nvm'],
    ])('%s leaves "%s" alone', (languageBoost, text) => {
        expect(speak(channel(languageBoost), text)).toBe(text);
    });

    test.each([
        ['English', 'ty for the raid', 'thank you for the raid'],
        ['German', 'ty and af', 'thank you and as fuck'],
        ['Spanish', 'np at all', 'no problem at all'],
    ])('%s still expands, because Twitch acronyms travel across languages', (languageBoost, text, expected) => {
        expect(speak(channel(languageBoost), text)).toBe(expected);
    });

    test('the profanity-injecting collision is the sharp one', () => {
        // "af" fires on an ordinary Afrikaans word AND expands to profanity, so
        // before scoping an Afrikaans channel with filtering on got a bleep out
        // of normal speech.
        expect(speak(channel('Afrikaans'), 'skakel dit af')).toBe('skakel dit af');
        expect(speak(channel('English'), 'tired af')).toContain('as fuck');
    });
});

describe('the memo must not leak one language\'s rules into another', () => {
    test('two channels with no overrides get their own scoping', () => {
        // Both take the shared no-override path, so a cache keyed only on the
        // pronunciations object would serve whichever compiled first.
        expect(speak(channel('Polish'), 'ty tam')).toBe('ty tam');
        expect(speak(channel('English'), 'ty')).toBe('thank you');
        expect(speak(channel('Polish'), 'ty tam')).toBe('ty tam');
    });

    test('order does not change the outcome', () => {
        _resetPronunciationMemo();
        expect(speak(channel('English'), 'ty')).toBe('thank you');
        expect(speak(channel('Polish'), 'ty')).toBe('ty');
    });

    test('one shared overrides object used by two languages stays separate', () => {
        // The WeakMap is keyed on this object's identity; the locale has to be
        // part of the key too or the second channel inherits the first's rules.
        const shared = { hello: 'greetings' };
        expect(speak(channel('English', shared), 'hello ty')).toBe('greetings thank you');
        expect(speak(channel('Polish', shared), 'hello ty')).toBe('greetings ty');
    });

    test('a channel that changes language recompiles', () => {
        const overrides = { zzz: 'sleepy' };
        expect(speak(channel('English', overrides), 'ty zzz')).toBe('thank you sleepy');
        expect(speak(channel('Polish', overrides), 'ty zzz')).toBe('ty sleepy');
    });
});

describe('locale resolution', () => {
    test('auto behaves as English, which is the pre-scoping behaviour', () => {
        expect(speak(channel('auto'), 'ty')).toBe('thank you');
        expect(speak({}, 'ty')).toBe('thank you');
    });

    test('announcementLocale overrides the synthesis language', () => {
        expect(speak({ languageBoost: 'English', announcementLocale: 'pl' }, 'ty')).toBe('ty');
    });

    test('pronunciationEnabled: false still disables everything', () => {
        expect(getPronunciationRules({ languageBoost: 'English', pronunciationEnabled: false })).toBeNull();
    });
});

describe('entry shapes', () => {
    test('a bare string entry is the legacy shape and applies everywhere', () => {
        const map = buildEffectiveMap({ brb: 'back soon' }, 'pl');
        expect(map.brb).toBe('back soon');
    });

    test('a scoped channel entry only fires in its languages', () => {
        const entries = { hola: { say: 'hello there', only: ['es'] } };
        expect(buildEffectiveMap(entries, 'es').hola).toBe('hello there');
        expect(buildEffectiveMap(entries, 'en').hola).toBeUndefined();
    });

    test('except excludes exactly the listed languages', () => {
        const entries = { foo: { say: 'bar', except: ['de'] } };
        expect(buildEffectiveMap(entries, 'de').foo).toBeUndefined();
        expect(buildEffectiveMap(entries, 'fr').foo).toBe('bar');
    });

    test('only wins over except when a channel sets both', () => {
        const entries = { foo: { say: 'bar', only: ['fr'], except: ['fr'] } };
        expect(buildEffectiveMap(entries, 'fr').foo).toBe('bar');
    });

    test('an empty say still disables the built-in of the same name', () => {
        expect(buildEffectiveMap({ brb: '' }, 'en').brb).toBeUndefined();
        expect(buildEffectiveMap({}, 'en').brb).toBe('be right back');
    });

    test('a malformed entry disables the built-in rather than silently keeping it', () => {
        // The channel meant to change this key. Falling back to the default
        // would look like the write was ignored.
        expect(buildEffectiveMap({ brb: { nope: 1 } }, 'en').brb).toBeUndefined();
    });
});

describe('a channel override must not silently unscope a built-in', () => {
    // The motivating bug: `!tts pronounce af = as heck` writes a bare string,
    // which used to replace the built-in wholesale and take `except: [af, nl]`
    // with it — reintroducing the profanity injection into ordinary Afrikaans
    // that the scoping was added to stop.
    it('keeps the built-in scope when the override does not mention one', () => {
        expect(buildEffectiveMap({ af: 'as heck' }, 'en').af).toBe('as heck');
        expect(buildEffectiveMap({ af: 'as heck' }, 'af').af).toBeUndefined();
        expect(buildEffectiveMap({ af: 'as heck' }, 'nl').af).toBeUndefined();
    });

    it('keeps it for the object form too, not just the bare string', () => {
        expect(buildEffectiveMap({ af: { say: 'as heck' } }, 'af').af).toBeUndefined();
    });

    it('lets a channel opt back in by saying so explicitly', () => {
        expect(buildEffectiveMap({ af: { say: 'as heck', except: [] } }, 'af').af).toBe('as heck');
        expect(buildEffectiveMap({ af: { say: 'as heck', only: ['af'] } }, 'af').af).toBe('as heck');
    });

    it('narrows rather than inherits when the channel gives its own scope', () => {
        const entry = { say: 'as heck', except: ['nl'] };
        expect(buildEffectiveMap({ af: entry }, 'af').af).toBe('as heck');
        expect(buildEffectiveMap({ af: entry }, 'nl').af).toBeUndefined();
    });

    it('does not invent a scope for a key with no built-in', () => {
        expect(buildEffectiveMap({ zzz: 'zed zed zed' }, 'af').zzz).toBe('zed zed zed');
    });
});

describe('the defaults data itself', () => {
    const config = JSON.parse(readFileSync('src/components/tts/tts-config.json', 'utf8'));

    test('every scoped entry names locales the bot actually supports', () => {
        const locales = JSON.parse(readFileSync('src/i18n/locales.json', 'utf8'));
        const known = new Set(Object.values(locales.LANGUAGE_BOOSTS).map(v => v.bcp47));
        const bad = [];
        for (const e of config.PRONUNCIATION_DEFAULTS) {
            for (const tag of [...(e.only || []), ...(e.except || [])]) {
                if (!known.has(tag)) bad.push(`${e.match}: ${tag}`);
            }
        }
        expect(bad).toEqual([]);
    });

    test('the scoped entries are the ones the audit confirmed', () => {
        const scoped = Object.fromEntries(
            config.PRONUNCIATION_DEFAULTS.filter(e => e.only || e.except).map(e => [e.match, e.except || e.only])
        );
        expect(scoped).toEqual({
            ty: ['pl', 'cs', 'sk'],
            af: ['af', 'nl'],
            np: ['pl'],
            nvm: ['cs'],
        });
    });

    test('the vast majority stay global, because Twitch acronyms cross languages', () => {
        const scoped = PRONUNCIATION_DEFAULTS.filter(e => e.only || e.except).length;
        expect(scoped).toBeLessThan(PRONUNCIATION_DEFAULTS.length * 0.1);
    });
});
