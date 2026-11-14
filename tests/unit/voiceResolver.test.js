// tests/unit/voiceResolver.test.js
// A stored voice ID becomes the Gemini voice to synthesise with, and the language hint
// that the voice brings. The MiniMax map is a mocked file here: the mock overrides the
// real minimax-to-gemini-voices.json, so these tests do not depend on the reviewed mapping.

import { jest } from '@jest/globals';
import { fileURLToPath } from 'url';

const LEGACY_MAP_PATH = fileURLToPath(new URL('../../src/components/tts/minimax-to-gemini-voices.json', import.meta.url));

const LEGACY_MAP = {
    Friendly_Person: { voice: 'kore' },
    Wise_Woman: { voice: 'aoede', style: 'calm and measured, like an older woman' },
    'English_Grumpy Man': { voice: 'charon', style: 'grumpy' },
    Broken_Row: { voice: 'not-a-gemini-voice', style: 'lost' },
    // A MiniMax ID that is also a Gemini ID: the catalog wins.
    Puck: { voice: 'kore', style: 'never used', languageCode: 'fr-FR' },
    // Rows in the shape of the real file, for the language hint.
    Cantonese_Host: { voice: 'kore', languageCode: 'yue-HK', style: '', needsStyleRender: false, confidence: 'high', alternates: [], reason: 'test' },
    English_Butler: { voice: 'kore', languageCode: 'en-GB', style: 'like a butler' },
    German_Narrator: { voice: 'de-de-advisor-1', languageCode: 'de-DE', style: '' },
    Austrian_Narrator: { voice: 'de-de-advisor-1', languageCode: 'de-AT', style: '' },
    English_On_German_Voice: { voice: 'de-de-advisor-1', languageCode: 'en-US', style: '' },
    Thai_On_English_Voice: { voice: 'en-us-advisor-1', languageCode: 'th-TH', style: '' },
};

describe('voiceResolver', () => {
    let resolver;
    let mockConfig;
    let mockLogger;

    /** Load the module with this legacy map, or with the file missing when it is null. */
    async function load(legacyMap = LEGACY_MAP) {
        jest.resetModules();
        mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
        jest.unstable_mockModule('../../src/lib/logger.js', () => ({ default: mockLogger }));
        jest.unstable_mockModule('../../src/config/index.js', () => ({ default: mockConfig }));
        // voiceResolver reads the map with require(), so it is mocked in the CommonJS registry.
        jest.doMock(LEGACY_MAP_PATH, () => {
            if (legacyMap === null) throw Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' });
            return legacyMap;
        }, { virtual: true });
        resolver = await import('../../src/components/tts/voiceResolver.js');
    }

    beforeEach(async () => {
        mockConfig = { tts: { defaultVoiceId: 'puck' } };
        await load();
    });

    afterEach(() => {
        jest.dontMock(LEGACY_MAP_PATH);
    });

    describe('the catalog', () => {
        test('holds voices with unique lower-case IDs', () => {
            const ids = resolver.getVoiceCatalog().map(voice => voice.id);

            expect(ids.length).toBeGreaterThan(0);
            expect(new Set(ids).size).toBe(ids.length);
            expect(ids.every(id => id === id.toLowerCase())).toBe(true);
            expect(ids).toEqual(expect.arrayContaining(['puck', 'kore', 'en-us-storyteller-11']));
        });

        test('getGeminiVoice finds an entry whatever the letter case or outer spaces', () => {
            expect(resolver.getGeminiVoice('kore')).toMatchObject({ id: 'kore', name: 'Kore' });
            expect(resolver.getGeminiVoice(' KORE ')).toBe(resolver.getGeminiVoice('kore'));
            expect(resolver.getGeminiVoice('EN-US-Storyteller-11').id).toBe('en-us-storyteller-11');
        });

        test.each(['Friendly_Person', 'nope', '', null, undefined, 42])('getGeminiVoice returns null for %p', voiceId => {
            expect(resolver.getGeminiVoice(voiceId)).toBeNull();
        });
    });

    describe('resolveVoice', () => {
        test('a Gemini ID resolves to itself with no added manner', () => {
            expect(resolver.resolveVoice('kore')).toEqual({ voice: 'kore', voiceStyle: '', language: null, legacy: false, fallback: false });
            expect(resolver.resolveVoice('en-us-storyteller-11')).toEqual({
                voice: 'en-us-storyteller-11', voiceStyle: '', language: null, legacy: false, fallback: false,
            });
        });

        test('a Gemini ID in another letter case resolves to the catalog spelling', () => {
            expect(resolver.resolveVoice('Kore').voice).toBe('kore');
            expect(resolver.resolveVoice('  ZEPHYR ').voice).toBe('zephyr');
        });

        test('a MiniMax ID resolves through the map, with the manner the map adds', () => {
            expect(resolver.resolveVoice('Wise_Woman')).toEqual({
                voice: 'aoede', voiceStyle: 'calm and measured, like an older woman', language: null, legacy: true, fallback: false,
            });
        });

        test('a mapped voice with no manner has an empty voiceStyle', () => {
            expect(resolver.resolveVoice('Friendly_Person')).toEqual({ voice: 'kore', voiceStyle: '', language: null, legacy: true, fallback: false });
        });

        test('a MiniMax ID is matched without case, and may hold a space', () => {
            expect(resolver.resolveVoice('wise_woman').voice).toBe('aoede');
            expect(resolver.resolveVoice('ENGLISH_GRUMPY MAN')).toMatchObject({ voice: 'charon', voiceStyle: 'grumpy', legacy: true });
        });

        test('the catalog wins over the map for an ID that is in both', () => {
            expect(resolver.resolveVoice('Puck')).toEqual({ voice: 'puck', voiceStyle: '', language: null, legacy: false, fallback: false });
        });

        test('a map row that points at an unknown voice falls back to the default', () => {
            expect(resolver.resolveVoice('Broken_Row')).toEqual({ voice: 'puck', voiceStyle: '', language: null, legacy: false, fallback: true });
        });

        test.each(['No_Such_Voice', '', null, undefined, 42, {}])('%p falls back to the default voice', storedId => {
            expect(resolver.resolveVoice(storedId)).toEqual({ voice: 'puck', voiceStyle: '', language: null, legacy: false, fallback: true });
        });
    });

    // The BCP-47 hint that a voice brings, or null. English is never a hint.
    describe('language', () => {
        test('the fixtures are what these tests take them for', () => {
            expect(resolver.getGeminiVoice('kore')).toMatchObject({ studio: true });
            expect(resolver.getGeminiVoice('en-us-advisor-1')).toMatchObject({ studio: false, language: 'en-US' });
            expect(resolver.getGeminiVoice('en-gb-advisor-1')).toMatchObject({ studio: false, language: 'en-GB' });
            expect(resolver.getGeminiVoice('de-de-advisor-1')).toMatchObject({ studio: false, language: 'de-DE' });
        });

        test('a studio voice speaks every language and brings none', () => {
            expect(resolver.resolveVoice('kore').language).toBeNull();
            expect(resolver.resolveVoice('puck').language).toBeNull();
        });

        test('an English library voice brings none', () => {
            expect(resolver.resolveVoice('en-us-advisor-1').language).toBeNull();
            expect(resolver.resolveVoice('en-gb-advisor-1').language).toBeNull();
        });

        test('a library voice of another language brings its own', () => {
            expect(resolver.resolveVoice('de-de-advisor-1')).toEqual({
                voice: 'de-de-advisor-1', voiceStyle: '', language: 'de-DE', legacy: false, fallback: false,
            });
            expect(resolver.resolveVoice('DE-DE-Advisor-1').language).toBe('de-DE');
        });

        test('no studio voice and no English voice of the catalog brings a language', () => {
            for (const voice of resolver.getVoiceCatalog()) {
                const { language } = resolver.resolveVoice(voice.id);
                if (voice.studio || voice.language.toLowerCase().startsWith('en')) expect(language).toBeNull();
                else expect(language).toBe(voice.language);
            }
        });

        test('a MiniMax voice of another language keeps it when it maps to a studio voice', () => {
            expect(resolver.resolveVoice('Cantonese_Host')).toEqual({
                voice: 'kore', voiceStyle: '', language: 'yue-HK', legacy: true, fallback: false,
            });
        });

        test('an English MiniMax voice mapped to a studio voice brings none', () => {
            expect(resolver.resolveVoice('English_Butler')).toMatchObject({ voice: 'kore', voiceStyle: 'like a butler', language: null });
            expect(resolver.resolveVoice('Wise_Woman').language).toBeNull(); // a row with no languageCode
        });

        test('the language of the map row wins over the one of the target voice', () => {
            expect(resolver.resolveVoice('German_Narrator').language).toBe('de-DE');
            expect(resolver.resolveVoice('Austrian_Narrator').language).toBe('de-AT');
            expect(resolver.resolveVoice('Thai_On_English_Voice')).toMatchObject({ voice: 'en-us-advisor-1', language: 'th-TH' });
        });

        test('an English map row falls back to the language of the target voice', () => {
            expect(resolver.resolveVoice('English_On_German_Voice')).toMatchObject({ voice: 'de-de-advisor-1', language: 'de-DE' });
        });

        test('the catalog wins over the map for the language too', () => {
            expect(resolver.resolveVoice('Puck').language).toBeNull();
        });

        test('an unknown ID brings none, whatever the default voice is', async () => {
            mockConfig.tts.defaultVoiceId = 'de-de-advisor-1';
            await load();

            expect(resolver.resolveVoice('No_Such_Voice')).toEqual({
                voice: 'de-de-advisor-1', voiceStyle: '', language: null, legacy: false, fallback: true,
            });
        });
    });

    describe('isLegacyVoiceId', () => {
        test('is true only for a MiniMax ID the map knows', () => {
            expect(resolver.isLegacyVoiceId('Wise_Woman')).toBe(true);
            expect(resolver.isLegacyVoiceId('wise_woman')).toBe(true);
            expect(resolver.isLegacyVoiceId('kore')).toBe(false);
            expect(resolver.isLegacyVoiceId('Puck')).toBe(false);
            expect(resolver.isLegacyVoiceId('No_Such_Voice')).toBe(false);
            expect(resolver.isLegacyVoiceId(undefined)).toBe(false);
        });
    });

    describe('the default voice', () => {
        test('is the configured Gemini voice', async () => {
            mockConfig.tts.defaultVoiceId = 'Zephyr';
            await load();

            expect(resolver.getDefaultVoiceId()).toBe('zephyr');
            expect(resolver.resolveVoice('No_Such_Voice').voice).toBe('zephyr');
        });

        test('may be configured as a MiniMax ID', async () => {
            mockConfig.tts.defaultVoiceId = 'Wise_Woman';
            await load();

            expect(resolver.getDefaultVoiceId()).toBe('aoede');
            // The fallback takes the voice only, not the manner of the mapped default.
            expect(resolver.resolveVoice('No_Such_Voice')).toEqual({ voice: 'aoede', voiceStyle: '', language: null, legacy: false, fallback: true });
        });

        test.each(['Not_A_Voice', '', undefined])('is puck when the configured default is %p', async defaultVoiceId => {
            mockConfig.tts.defaultVoiceId = defaultVoiceId;
            await load();

            expect(resolver.getDefaultVoiceId()).toBe('puck');
        });

        test('is puck when there is no tts config at all', async () => {
            mockConfig = {};
            await load();

            expect(resolver.getDefaultVoiceId()).toBe('puck');
        });
    });

    describe('without the map file', () => {
        beforeEach(async () => {
            await load(null);
        });

        test('loads, and says so once', () => {
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn.mock.calls[0][0]).toMatch(/minimax-to-gemini-voices\.json is missing/);
        });

        test('Gemini IDs still resolve', () => {
            expect(resolver.resolveVoice('kore')).toEqual({ voice: 'kore', voiceStyle: '', language: null, legacy: false, fallback: false });
        });

        test('the mock stands in for the real file: none of its rows is read', () => {
            // Friendly_Person is a row of the real map.
            expect(resolver.isLegacyVoiceId('Friendly_Person')).toBe(false);
            expect(resolver.resolveVoice('Friendly_Person').fallback).toBe(true);
        });

        test('a MiniMax ID uses the default voice', () => {
            expect(resolver.resolveVoice('Wise_Woman')).toEqual({ voice: 'puck', voiceStyle: '', language: null, legacy: false, fallback: true });
            expect(resolver.isLegacyVoiceId('Wise_Woman')).toBe(false);
        });
    });
});
