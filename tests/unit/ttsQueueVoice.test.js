// tests/unit/ttsQueueVoice.test.js
// What enqueue puts in an item's voiceConfig for the Gemini provider: the resolved
// voice, the manner and the language of a mapped MiniMax voice, the custom style, and
// the volume.
// voiceResolver is mocked so the MiniMax map is a small table owned by this file.

import { jest } from '@jest/globals';
import { createMockFirestore, FieldValue } from '../helpers/mockFirestore.js';
import { TEST_CHANNEL, TEST_USER, TEST_USER_ID } from '../helpers/testData.js';

// Gemini voices and the language each brings (null for a studio or an English voice).
const GEMINI_VOICES = { puck: null, kore: null, aoede: null, zephyr: null, 'de-de-advisor-1': 'de-DE' };
const LEGACY_VOICES = {
    Wise_Woman: { voice: 'aoede', style: 'like an older woman', language: null },
    Calm_Man: { voice: 'kore', style: '', language: null },
    Cantonese_Host: { voice: 'kore', style: '', language: 'yue-HK' },
};

function resolveVoice(storedId) {
    if (Object.hasOwn(GEMINI_VOICES, storedId)) {
        return { voice: storedId, voiceStyle: '', language: GEMINI_VOICES[storedId], legacy: false, fallback: false };
    }
    const row = LEGACY_VOICES[storedId];
    if (row) return { voice: row.voice, voiceStyle: row.style, language: row.language, legacy: true, fallback: false };
    return { voice: 'puck', voiceStyle: '', language: null, legacy: false, fallback: true };
}

describe('ttsQueue voice, style and volume', () => {
    let mockTtsService;
    let mockTtsState;
    let ttsQueue;
    let channelConfig;

    const viewer = { text: 'hello', user: TEST_USER, userId: TEST_USER_ID, type: 'chat' };
    const anonymous = { text: 'hello', user: 'event_tts', type: 'event' };

    /** Enqueue on a paused queue and return the voiceConfig of the item. */
    async function voiceConfigFor(eventData = viewer) {
        await ttsQueue.enqueue(TEST_CHANNEL, eventData);
        return ttsQueue.getOrCreateChannelQueue(TEST_CHANNEL).queue.at(-1).voiceConfig;
    }

    const globalPrefs = prefs => mockTtsState.getGlobalUserPreferences.mockResolvedValue(prefs);
    const channelUserPrefs = prefs => mockTtsState.getChannelUserPreferences.mockResolvedValue(prefs);

    beforeEach(async () => {
        jest.resetModules();
        jest.clearAllMocks();

        channelConfig = { voiceId: 'kore', speed: 1, pitch: 0, emotion: 'neutral', languageBoost: 'auto', volume: 1, voiceVolumes: {} };
        mockTtsService = { generateSpeech: jest.fn().mockResolvedValue({ kind: 'buffer', data: Buffer.from([1, 2]), mime: 'audio/wav' }) };
        mockTtsState = {
            getTtsState: jest.fn().mockResolvedValue({ engineEnabled: true, allowViewerPreferences: true }),
            getChannelTtsConfig: jest.fn(async () => channelConfig),
            getGlobalUserPreferences: jest.fn().mockResolvedValue({}),
            getChannelUserPreferences: jest.fn().mockResolvedValue({}),
        };

        jest.unstable_mockModule('@google-cloud/firestore', () => ({ Firestore: jest.fn(() => createMockFirestore()), FieldValue }));
        jest.unstable_mockModule('../../src/lib/logger.js', () => ({
            default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        }));
        jest.unstable_mockModule('../../src/components/tts/ttsService.js', () => mockTtsService);
        jest.unstable_mockModule('../../src/components/tts/ttsState.js', () => mockTtsState);
        jest.unstable_mockModule('../../src/components/tts/voiceResolver.js', () => ({ resolveVoice: jest.fn(resolveVoice) }));
        jest.unstable_mockModule('../../src/components/web/server.js', () => ({
            sendAudioToChannel: jest.fn(),
            hasActiveClients: jest.fn().mockReturnValue(true),
            openClipStream: jest.fn().mockReturnValue(null),
            sendClipMeta: jest.fn(() => new Set()),
            dropClips: jest.fn(() => 0),
            STOP_CURRENT_AUDIO: 'STOP_CURRENT_AUDIO',
        }));

        ttsQueue = await import('../../src/components/tts/ttsQueue.js');
        const allowList = await import('../../src/lib/allowList.js');
        allowList.addAllowedChannel(TEST_CHANNEL, '12345');
        await ttsQueue.pauseQueue(TEST_CHANNEL);
    });

    describe('voice', () => {
        test('uses the Gemini voice of the channel as it is', async () => {
            expect(await voiceConfigFor()).toMatchObject({ voiceId: 'kore', voiceStyle: '' });
        });

        test('maps a stored MiniMax voice and takes the manner the map adds', async () => {
            channelConfig.voiceId = 'Wise_Woman';

            expect(await voiceConfigFor()).toMatchObject({ voiceId: 'aoede', voiceStyle: 'like an older woman' });
        });

        test('uses the default voice for an ID nothing knows', async () => {
            channelConfig.voiceId = 'No_Such_Voice';

            expect(await voiceConfigFor()).toMatchObject({ voiceId: 'puck', voiceStyle: '' });
        });

        test('uses the default of DEFAULT_TTS_SETTINGS when nothing stores a voice', async () => {
            const { DEFAULT_TTS_SETTINGS } = await import('../../src/components/tts/ttsConstants.js');
            delete channelConfig.voiceId;

            expect((await voiceConfigFor()).voiceId).toBe(resolveVoice(DEFAULT_TTS_SETTINGS.voiceId).voice);
        });

        test('a viewer voice wins over the channel voice, global before per-channel', async () => {
            channelUserPrefs({ voiceId: 'zephyr' });
            expect((await voiceConfigFor()).voiceId).toBe('zephyr');

            globalPrefs({ voiceId: 'Wise_Woman' });
            expect(await voiceConfigFor()).toMatchObject({ voiceId: 'aoede', voiceStyle: 'like an older woman' });
        });

        test('a voice passed in voiceOptions is resolved too', async () => {
            const config = await voiceConfigFor({ ...viewer, voiceOptions: { voiceId: 'Wise_Woman' } });

            expect(config).toMatchObject({ voiceId: 'aoede', voiceStyle: 'like an older woman' });
        });

        // The manner is read from the document that supplied the voice.
        test('a voice passed in voiceOptions takes no stored manner, only the one of the map', async () => {
            channelConfig.voiceStyle = 'for the channel voice';
            globalPrefs({ voiceId: 'zephyr', voiceStyle: 'for the viewer voice' });
            channelUserPrefs({ voiceId: 'kore', voiceStyle: 'for the per-channel voice' });

            expect(await voiceConfigFor({ ...viewer, voiceOptions: { voiceId: 'puck' } }))
                .toMatchObject({ voiceId: 'puck', voiceStyle: '' });
            expect(await voiceConfigFor({ ...viewer, voiceOptions: { voiceId: 'Wise_Woman' } }))
                .toMatchObject({ voiceId: 'aoede', voiceStyle: 'like an older woman' });
        });

        test('voiceOptions may still name a manner of their own', async () => {
            channelConfig.voiceStyle = 'for the channel voice';

            const config = await voiceConfigFor({ ...viewer, voiceOptions: { voiceId: 'puck', voiceStyle: 'passed in' } });

            expect(config.voiceStyle).toBe('passed in');
        });

        test('a global viewer voice does not take the manner of the per-channel voice', async () => {
            channelConfig.voiceStyle = 'for the channel voice';
            globalPrefs({ voiceId: 'zephyr' });
            channelUserPrefs({ voiceId: 'kore', voiceStyle: 'for the per-channel voice' });

            expect(await voiceConfigFor()).toMatchObject({ voiceId: 'zephyr', voiceStyle: '' });
        });

        test('a global viewer MiniMax voice with no stored manner takes the one of the map', async () => {
            channelUserPrefs({ voiceId: 'kore', voiceStyle: 'for the per-channel voice' });
            globalPrefs({ voiceId: 'Wise_Woman' });

            expect(await voiceConfigFor()).toMatchObject({ voiceId: 'aoede', voiceStyle: 'like an older woman' });
        });

        test('a per-channel viewer voice takes the manner stored with it, not a global one', async () => {
            channelConfig.voiceStyle = 'for the channel voice';
            globalPrefs({ voiceStyle: 'left over, no voice beside it' });
            channelUserPrefs({ voiceId: 'aoede', voiceStyle: 'for the per-channel voice' });

            expect(await voiceConfigFor()).toMatchObject({ voiceId: 'aoede', voiceStyle: 'for the per-channel voice' });
        });

        test('an empty manner stored beside a viewer MiniMax voice is kept', async () => {
            globalPrefs({ voiceId: 'Wise_Woman', voiceStyle: '' });

            expect((await voiceConfigFor()).voiceStyle).toBe('');
        });

        test('the manner the backfill stored for the channel wins over the map', async () => {
            channelConfig.voiceId = 'Wise_Woman';
            channelConfig.voiceStyle = 'stored by the backfill';
            expect((await voiceConfigFor()).voiceStyle).toBe('stored by the backfill');

            // An empty stored manner is a value: the voice was changed since.
            channelConfig.voiceStyle = '';
            expect((await voiceConfigFor()).voiceStyle).toBe('');
        });

        test('the manner of the channel voice is not put on a viewer voice', async () => {
            channelConfig.voiceId = 'Wise_Woman';
            channelConfig.voiceStyle = 'for the channel voice';
            globalPrefs({ voiceId: 'zephyr' });

            expect(await voiceConfigFor()).toMatchObject({ voiceId: 'zephyr', voiceStyle: '' });
        });

        test('a viewer voice takes the manner stored with it', async () => {
            globalPrefs({ voiceId: 'aoede', voiceStyle: 'stored for the viewer' });

            expect((await voiceConfigFor()).voiceStyle).toBe('stored for the viewer');
        });

        test('the provider is called with the resolved voice, the manner first in the style', async () => {
            channelConfig.voiceId = 'Wise_Woman';
            channelConfig.emotion = 'happy';
            await ttsQueue.enqueue(TEST_CHANNEL, viewer);

            await ttsQueue.resumeQueue(TEST_CHANNEL);
            await new Promise(resolve => setTimeout(resolve, 50));

            expect(mockTtsService.generateSpeech).toHaveBeenCalledWith(
                'hello',
                'aoede',
                expect.objectContaining({ style: 'like an older woman, happy and cheerful' })
            );
        });
    });

    // languageBoost set > stored voiceLanguage > language of the resolved voice > none
    describe('language', () => {
        /** Enqueue, let the queue run, and return the language the provider was given. */
        async function spokenLanguage(eventData = viewer) {
            await ttsQueue.enqueue(TEST_CHANNEL, eventData);
            await ttsQueue.resumeQueue(TEST_CHANNEL);
            await new Promise(resolve => setTimeout(resolve, 50));
            // Earlier items of the test may have been spoken too; this one is the last.
            expect(mockTtsService.generateSpeech).toHaveBeenCalled();
            return mockTtsService.generateSpeech.mock.calls.at(-1)[2].language;
        }

        test('is undefined for a voice that brings none and no languageBoost', async () => {
            expect(await voiceConfigFor()).toMatchObject({ voiceId: 'kore', voiceLanguage: null });
            expect(await spokenLanguage()).toBeUndefined();
        });

        test('is the language of the resolved voice', async () => {
            channelConfig.voiceId = 'de-de-advisor-1';

            expect((await voiceConfigFor()).voiceLanguage).toBe('de-DE');
            expect(await spokenLanguage()).toBe('de-DE');
        });

        test('is the language the map gives a MiniMax voice', async () => {
            channelConfig.voiceId = 'Cantonese_Host';

            expect(await voiceConfigFor()).toMatchObject({ voiceId: 'kore', voiceLanguage: 'yue-HK' });
            expect(await spokenLanguage()).toBe('yue-HK');
        });

        test('the stored voiceLanguage wins over the language of the resolved voice', async () => {
            channelConfig.voiceId = 'de-de-advisor-1';
            channelConfig.voiceLanguage = 'de-AT';

            expect((await voiceConfigFor()).voiceLanguage).toBe('de-AT');
            expect(await spokenLanguage()).toBe('de-AT');
        });

        test('a stored voiceLanguage gives a studio voice a language', async () => {
            channelConfig.voiceLanguage = 'th-TH';

            expect(await spokenLanguage()).toBe('th-TH');
        });

        test('an empty stored voiceLanguage falls through to the resolved voice', async () => {
            // Unlike voiceStyle: '' is what "!tts defaultvoice" writes, and it means "none stored".
            channelConfig.voiceId = 'de-de-advisor-1';
            channelConfig.voiceLanguage = '';

            expect((await voiceConfigFor()).voiceLanguage).toBe('de-DE');
        });

        test('a languageBoost wins over the stored and the resolved language', async () => {
            channelConfig.voiceId = 'de-de-advisor-1';
            channelConfig.voiceLanguage = 'de-AT';
            channelConfig.languageBoost = 'Spanish';

            // The voice language stays on the item; only the hint changes.
            expect(await voiceConfigFor()).toMatchObject({ voiceLanguage: 'de-AT', languageBoost: 'Spanish' });
            expect(await spokenLanguage()).toBe('es');
        });

        test('a viewer languageBoost wins over the language of the channel voice', async () => {
            channelConfig.voiceId = 'Cantonese_Host';
            globalPrefs({ languageBoost: 'French' });

            expect(await spokenLanguage()).toBe('fr');
        });

        test.each(['auto', 'Automatic', 'None', undefined])('a languageBoost of %p falls through to the voice language', async languageBoost => {
            channelConfig.voiceId = 'de-de-advisor-1';
            channelConfig.languageBoost = languageBoost;

            expect(await spokenLanguage()).toBe('de-DE');
        });

        // The stored language is read from the document that supplied the voice.
        test('a viewer voice does not take the voiceLanguage of the channel', async () => {
            channelConfig.voiceLanguage = 'th-TH';
            globalPrefs({ voiceId: 'zephyr' });

            expect(await voiceConfigFor()).toMatchObject({ voiceId: 'zephyr', voiceLanguage: null });
        });

        test('a viewer voice takes the voiceLanguage stored with it', async () => {
            channelConfig.voiceLanguage = 'th-TH';
            globalPrefs({ voiceId: 'zephyr', voiceLanguage: 'pt-BR' });

            expect((await voiceConfigFor()).voiceLanguage).toBe('pt-BR');
        });

        test('a global viewer voice does not take the voiceLanguage of the per-channel voice', async () => {
            globalPrefs({ voiceId: 'de-de-advisor-1' });
            channelUserPrefs({ voiceId: 'kore', voiceLanguage: 'pt-BR' });

            expect((await voiceConfigFor()).voiceLanguage).toBe('de-DE');
        });

        test('a per-channel viewer voice takes its own voiceLanguage, not a global one left behind', async () => {
            globalPrefs({ voiceLanguage: 'ja-JP' });
            channelUserPrefs({ voiceId: 'kore', voiceLanguage: 'pt-BR' });

            expect((await voiceConfigFor()).voiceLanguage).toBe('pt-BR');
        });

        test('a voice passed in voiceOptions takes no stored voiceLanguage, only the resolved one', async () => {
            channelConfig.voiceLanguage = 'th-TH';
            globalPrefs({ voiceId: 'zephyr', voiceLanguage: 'pt-BR' });

            expect((await voiceConfigFor({ ...viewer, voiceOptions: { voiceId: 'puck' } })).voiceLanguage).toBeNull();
            expect((await voiceConfigFor({ ...viewer, voiceOptions: { voiceId: 'Cantonese_Host' } })).voiceLanguage).toBe('yue-HK');
        });

        test('where viewer preferences are disabled, the channel voice and its language are used', async () => {
            mockTtsState.getTtsState.mockResolvedValue({ engineEnabled: true, allowViewerPreferences: false });
            channelConfig.voiceLanguage = 'th-TH';
            globalPrefs({ voiceId: 'de-de-advisor-1', voiceLanguage: 'pt-BR', languageBoost: 'French' });

            expect(await voiceConfigFor()).toMatchObject({ voiceId: 'kore', voiceLanguage: 'th-TH' });
            expect(await spokenLanguage()).toBe('th-TH');
        });
    });

    // viewer style > viewer emotion > channel style > channel emotion
    describe('style', () => {
        const built = async (eventData) => {
            const { buildStyle } = await import('../../src/components/tts/styleBuilder.js');
            return buildStyle(await voiceConfigFor(eventData));
        };

        test('with no style anywhere, the channel emotion is the style', async () => {
            channelConfig.emotion = 'sad';

            expect(await voiceConfigFor()).toMatchObject({ style: '', emotion: 'sad' });
            expect(await built()).toBe('sad and downcast');
        });

        test('the channel style replaces the channel emotion', async () => {
            channelConfig.emotion = 'sad';
            channelConfig.style = 'like a robot';

            expect((await voiceConfigFor()).style).toBe('like a robot');
            expect(await built()).toBe('like a robot');
        });

        test('a viewer emotion replaces the channel style', async () => {
            channelConfig.style = 'like a robot';
            globalPrefs({ emotion: 'happy' });

            expect(await voiceConfigFor()).toMatchObject({ style: '', emotion: 'happy' });
            expect(await built()).toBe('happy and cheerful');
        });

        test('a per-channel viewer emotion replaces the channel style too', async () => {
            channelConfig.style = 'like a robot';
            channelUserPrefs({ emotion: 'calm' });

            expect(await built()).toBe('calm and relaxed');
        });

        test('a viewer style replaces the viewer emotion and the channel style', async () => {
            channelConfig.style = 'like a robot';
            channelConfig.emotion = 'sad';
            globalPrefs({ style: 'like a pirate', emotion: 'happy' });

            expect((await voiceConfigFor()).style).toBe('like a pirate');
            expect(await built()).toBe('like a pirate');
        });

        test('the global viewer style wins over the per-channel one', async () => {
            channelUserPrefs({ style: 'whispering' });
            expect((await voiceConfigFor()).style).toBe('whispering');

            globalPrefs({ style: 'like a pirate' });
            expect((await voiceConfigFor()).style).toBe('like a pirate');
        });

        test('a viewer speed and pitch are added to the channel style', async () => {
            channelConfig.style = 'like a robot';
            globalPrefs({ speed: 2, pitch: 12 });

            expect(await built()).toBe('like a robot, speaking very rapidly, very high pitch');
        });

        test('viewer values replace channel values, they are not mixed', async () => {
            Object.assign(channelConfig, { emotion: 'sad', speed: 0.5, pitch: -12 });
            globalPrefs({ emotion: 'happy', speed: 1, pitch: 0 });

            expect(await voiceConfigFor()).toMatchObject({ emotion: 'happy', speed: 1, pitch: 0 });
            expect(await built()).toBe('happy and cheerful');
        });

        test('a viewer style is ignored where the channel disallows viewer preferences', async () => {
            mockTtsState.getTtsState.mockResolvedValue({ engineEnabled: true, allowViewerPreferences: false });
            channelConfig.style = 'like a robot';
            globalPrefs({ style: 'like a pirate', emotion: 'happy', voiceId: 'zephyr' });
            channelUserPrefs({ style: 'whispering' });

            expect(await voiceConfigFor()).toMatchObject({ style: 'like a robot', emotion: 'neutral', voiceId: 'kore' });
        });

        test('an item with no viewer gets the channel style', async () => {
            channelConfig.style = 'like a robot';
            globalPrefs({ style: 'like a pirate' });

            expect((await voiceConfigFor(anonymous)).style).toBe('like a robot');
        });

        test('voiceOptions override the stored style and emotion', async () => {
            channelConfig.style = 'like a robot';

            const config = await voiceConfigFor({ ...viewer, voiceOptions: { style: 'shouting', emotion: 'angry' } });

            expect(config).toMatchObject({ style: 'shouting', emotion: 'angry' });
        });
    });

    describe('volume', () => {
        test('is 1 when nothing is stored', async () => {
            delete channelConfig.volume;
            delete channelConfig.voiceVolumes;

            expect((await voiceConfigFor()).volume).toBe(1);
        });

        test('is the channel volume when the voice has none of its own', async () => {
            channelConfig.volume = 0.6;
            channelConfig.voiceVolumes = { zephyr: 1.8 };

            expect((await voiceConfigFor()).volume).toBe(0.6);
        });

        test('is the volume stored for the voice', async () => {
            channelConfig.volume = 0.6;
            channelConfig.voiceVolumes = { kore: 1.4 };

            expect((await voiceConfigFor()).volume).toBe(1.4);
        });

        test('is found under the MiniMax ID the dashboard wrote it with', async () => {
            channelConfig.voiceId = 'Wise_Woman';
            channelConfig.voiceVolumes = { Wise_Woman: 0.7 };

            expect(await voiceConfigFor()).toMatchObject({ voiceId: 'aoede', volume: 0.7 });
        });

        test('the Gemini ID wins when both spellings hold a volume', async () => {
            channelConfig.voiceId = 'Wise_Woman';
            channelConfig.voiceVolumes = { Wise_Woman: 0.7, aoede: 1.3 };

            expect((await voiceConfigFor()).volume).toBe(1.3);
        });

        test('follows the voice of the viewer, not the voice of the channel', async () => {
            channelConfig.voiceVolumes = { kore: 1.4, zephyr: 0.5 };
            globalPrefs({ voiceId: 'zephyr' });

            expect((await voiceConfigFor()).volume).toBe(0.5);
        });

        test('reaches the provider as the gain for the samples', async () => {
            channelConfig.voiceVolumes = { kore: 1.4 };
            await ttsQueue.enqueue(TEST_CHANNEL, viewer);

            await ttsQueue.resumeQueue(TEST_CHANNEL);
            await new Promise(resolve => setTimeout(resolve, 50));

            expect(mockTtsService.generateSpeech).toHaveBeenCalledWith('hello', 'kore', expect.objectContaining({ volume: 1.4 }));
        });

        test('caps stored volumes above 2 at 2', async () => {
            channelConfig.voiceVolumes = { kore: 5 };

            expect((await voiceConfigFor()).volume).toBe(2);
        });
    });

    test('the item keeps no field of the old provider', async () => {
        const config = await voiceConfigFor();

        expect(Object.keys(config).sort()).toEqual(['emotion', 'languageBoost', 'pitch', 'speed', 'style', 'voiceId', 'voiceLanguage', 'voiceStyle', 'volume']);
    });
});
