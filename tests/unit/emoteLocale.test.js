// tests/unit/emoteLocale.test.js
// Emote descriptions are generated per language and cached per language. The
// cache key is the risky part: three of these functions back a moderator-curated
// store, so a curated English description must not surface on a Spanish channel.

import { jest } from '@jest/globals';

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../../src/lib/logger.js', () => ({ default: mockLogger }));

const docs = new Map();
const makeDoc = (id) => ({
    get: async () => ({ exists: docs.has(id), data: () => docs.get(id), id }),
    set: async (data) => { docs.set(id, { ...(docs.get(id) || {}), ...data }); },
    delete: async () => { docs.delete(id); },
});
const mockDb = {
    collection: () => ({
        doc: (id) => makeDoc(id),
        where: (field, _op, value) => ({
            get: async () => ({
                forEach: (fn) => {
                    for (const [id, data] of docs) {
                        if (data[field] === value) fn({ id, data: () => data });
                    }
                },
            }),
        }),
    }),
};
jest.unstable_mockModule('@google-cloud/firestore', () => ({
    Firestore: Object.assign(jest.fn(() => mockDb), { FieldValue: { serverTimestamp: () => 'ts' } }),
}));

// Captures what actually reaches Gemini, so the language instruction is asserted
// rather than assumed.
const generateContent = jest.fn();
jest.unstable_mockModule('@google/genai', () => ({
    GoogleGenAI: jest.fn(() => ({ models: { generateContent } })),
}));
jest.unstable_mockModule('sharp', () => ({ default: jest.fn() }));
jest.unstable_mockModule('../../src/lib/emotes/emoteImageFetcher.js', () => ({
    fetchEmoteImage: jest.fn().mockResolvedValue({ mimeType: 'image/png', data: Buffer.from('png') }),
    fetchAnimatedEmoteFrames: jest.fn().mockResolvedValue(null),
    getEmoteImageUrl: jest.fn(),
    getAnimatedEmoteUrl: jest.fn(),
}));
jest.unstable_mockModule('../../src/config/index.js', () => ({
    default: { emote: { geminiModel: 'test-model', cdnUrl: 'https://x', maxGifFrames: 3, timeoutMs: 8000, animatedTimeoutMs: 12000 } },
}));

const cache = await import('../../src/lib/emotes/emoteCache.js');
const describer = await import('../../src/lib/emotes/emoteDescriberApi.js');

beforeEach(() => {
    docs.clear();
    cache._descriptionCache.clear();
    jest.clearAllMocks();
    cache.initEmoteDescriptionStore();
});

describe('cache keys separate languages', () => {
    test('a description stored for one language is not served to another', async () => {
        await cache.setEmoteDescription('e1', 'Kappa', 'laughing face', null, 'en');
        await cache.setEmoteDescription('e1', 'Kappa', 'cara riendo', null, 'es');

        await expect(cache.getCachedDescription('e1', 'en')).resolves.toBe('laughing face');
        await expect(cache.getCachedDescription('e1', 'es')).resolves.toBe('cara riendo');
    });

    test('a language with nothing stored misses rather than borrowing English', async () => {
        await cache.setEmoteDescription('e1', 'Kappa', 'laughing face', null, 'en');
        await expect(cache.getCachedDescription('e1', 'ja')).resolves.toBeNull();
    });

    test('English keeps the bare emote id as its document, so nothing needs backfilling', async () => {
        // Every document written before descriptions were localized is keyed on
        // the emote id alone. Treating that as English makes them correct rather
        // than stale, and an English channel keeps its whole warm cache.
        docs.set('legacy1', { description: 'from before localization', emoteName: 'LUL' });
        await expect(cache.getCachedDescription('legacy1', 'en')).resolves.toBe('from before localization');
        await expect(cache.getCachedDescription('legacy1', 'de')).resolves.toBeNull();
    });

    test('the AI cache write is also per language', async () => {
        cache.cacheDescription('e2', 'dancing cat', 'catJAM', null, 'de');
        await expect(cache.getCachedDescription('e2', 'de')).resolves.toBe('dancing cat');
        await expect(cache.getCachedDescription('e2', 'en')).resolves.toBeNull();
    });

    test('invalidating one language leaves the others alone', async () => {
        await cache.setEmoteDescription('e3', 'Kappa', 'english', null, 'en');
        await cache.setEmoteDescription('e3', 'Kappa', 'spanish', null, 'es');

        await cache.invalidateEmoteDescription('e3', 'es');
        await expect(cache.getCachedDescription('e3', 'es')).resolves.toBeNull();
        await expect(cache.getCachedDescription('e3', 'en')).resolves.toBe('english');
    });
});

describe('the moderator-curated store', () => {
    test('a name search returns only the requested language', async () => {
        await cache.setEmoteDescription('e4', 'Kappa', 'laughing face', null, 'en');
        await cache.setEmoteDescription('e4', 'Kappa', 'cara riendo', null, 'es');

        const en = await cache.findEmoteDescriptionsByName('Kappa', 'en');
        const es = await cache.findEmoteDescriptionsByName('Kappa', 'es');
        expect(en.map(r => r.description)).toEqual(['laughing face']);
        expect(es.map(r => r.description)).toEqual(['cara riendo']);
    });

    test('a name search returns the base emote id, not the document id', async () => {
        // The Spanish document is keyed "e5:es". Handing that back would make the
        // next setEmoteDescription suffix it a second time, to "e5:es:es".
        await cache.setEmoteDescription('e5', 'Kappa', 'cara riendo', null, 'es');
        const [row] = await cache.findEmoteDescriptionsByName('Kappa', 'es');
        expect(row.emoteId).toBe('e5');
        expect(row.locale).toBe('es');

        await cache.setEmoteDescription(row.emoteId, 'Kappa', 'otra cara', null, row.locale);
        expect([...docs.keys()]).toEqual(['e5:es']);
    });

    test('a legacy document with no locale field is found as English', async () => {
        docs.set('e6', { description: 'old one', emoteName: 'LUL' });
        const en = await cache.findEmoteDescriptionsByName('LUL', 'en');
        expect(en.map(r => r.emoteId)).toEqual(['e6']);
        await expect(cache.findEmoteDescriptionsByName('LUL', 'fr')).resolves.toEqual([]);
    });

    test('a curated description still blocks the AI from overwriting it', async () => {
        await cache.setEmoteDescription('e7', 'Kappa', 'curated', null, 'es');
        cache.cacheDescription('e7', 'ai guess', 'Kappa', null, 'es');
        await expect(cache.getCachedDescription('e7', 'es')).resolves.toBe('curated');
    });
});

describe('the description is generated in the target language', () => {
    // Not translated afterwards: these are two to six words with no surrounding
    // context, which is far too little for a translation pass to work from.
    beforeEach(() => {
        describer.initGeminiClient('test-key');
        generateContent.mockResolvedValue({ text: JSON.stringify({ description: 'gato bailando' }) });
    });

    const promptText = () => generateContent.mock.calls[0][0].contents.find(p => p.text).text;

    test.each([
        ['es', 'Spanish (Español)'],
        ['de', 'German (Deutsch)'],
        ['ja', 'Japanese (日本語)'],
        // The provider's enum value for Cantonese is "Chinese,Yue", which reads
        // as a malformed list on its own; the endonym is what makes it clear.
        ['yue', 'Chinese,Yue (粵語)'],
    ])('%s asks the model to reply in %s', async (locale, languageName) => {
        await describer.describeSingleEmote('x1', 'catJAM', null, false, null, 'twitch', locale);
        expect(promptText()).toContain(`Reply in ${languageName}, not English.`);
    });

    test('English adds no language instruction, leaving the prompt as it was', async () => {
        await describer.describeSingleEmote('x2', 'catJAM', null, false, null, 'twitch', 'en');
        expect(promptText()).not.toContain('Reply in');
    });

    test('an unrecognised locale adds nothing rather than inventing a language name', async () => {
        await describer.describeSingleEmote('x3', 'catJAM', null, false, null, 'twitch', 'zz');
        expect(promptText()).not.toContain('Reply in');
    });

    test('the result is cached under the language it was generated in', async () => {
        await describer.describeSingleEmote('x4', 'catJAM', null, false, null, 'twitch', 'es');
        await expect(cache.getCachedDescription('x4', 'es')).resolves.toBe('gato bailando');
        await expect(cache.getCachedDescription('x4', 'en')).resolves.toBeNull();
    });

    test('a second call in the same language hits the cache instead of Gemini', async () => {
        await describer.describeSingleEmote('x5', 'catJAM', null, false, null, 'twitch', 'es');
        await describer.describeSingleEmote('x5', 'catJAM', null, false, null, 'twitch', 'es');
        expect(generateContent).toHaveBeenCalledTimes(1);
    });

    test('a different language misses and calls Gemini again', async () => {
        await describer.describeSingleEmote('x6', 'catJAM', null, false, null, 'twitch', 'es');
        await describer.describeSingleEmote('x6', 'catJAM', null, false, null, 'twitch', 'de');
        expect(generateContent).toHaveBeenCalledTimes(2);
    });
});