// tests/unit/ttsQueueClipCard.test.js
// The card data of a clip (`display`, spotlight mode) through the queue.
//
// enqueue keeps `display` on the item, after the same sound-tag and profanity rules
// as the speech, cut to length; an empty card is dropped and the clip still plays.
// The item survives the queue handoff, Firestore persistence and the Pub/Sub hop
// with its card. processQueue sends the card (clipMeta) directly before the clip's
// first frame on each delivery path, only with spotlightCard on, never at prefetch.

import { jest } from '@jest/globals';
import { createMockFirestore, FieldValue } from '../helpers/mockFirestore.js';
import { TEST_CHANNEL, TEST_USER, mockChannelConfig } from '../helpers/testData.js';

describe('ttsQueue clip card', () => {
    let ttsQueue;
    let mockWebServer;
    let mockTtsService;
    let mockTtsState;
    let mockDb;
    let calls;
    let streams;
    let channelConfig;

    const flush = () => new Promise(r => setImmediate(() => setImmediate(r)));
    const wav = hex => ({ kind: 'buffer', data: Buffer.from(hex, 'hex'), mime: 'audio/wav', sampleRate: 24000 });
    const item = () => ttsQueue.getOrCreateChannelQueue(TEST_CHANNEL).queue.at(-1);
    const display = (text, user = 'ViewerName') => ({ kind: 'spotlight', user, text });
    const enqueue = (text, extra = {}) =>
        ttsQueue.enqueue(TEST_CHANNEL, { text, user: TEST_USER, userId: '1', type: 'spotlight', ...extra });

    beforeEach(async () => {
        jest.resetModules();
        calls = [];
        streams = [];
        mockDb = createMockFirestore();
        channelConfig = { ...mockChannelConfig, engineEnabled: true, spotlightCard: true };

        mockTtsService = { generateSpeech: jest.fn().mockResolvedValue(wav('fffb')) };
        mockWebServer = {
            hasActiveClients: jest.fn().mockReturnValue(true),
            sendAudioToChannel: jest.fn((channel, audio, opts) => calls.push({ fn: 'wav', channel, opts })),
            openClipStream: jest.fn((channel, clipId) => {
                calls.push({ fn: 'audioStart', channel, clipId });
                const stream = { clipId, recipients: new Set(['pcm-socket']), chunk: jest.fn(), end: jest.fn() };
                streams.push(stream);
                return stream;
            }),
            sendClipMeta: jest.fn((channel, clipId, meta, opts = {}) => {
                calls.push({ fn: 'meta', channel, clipId, meta, opts });
                return new Set(opts.streamOnly ? ['pcm-socket'] : ['wav-socket']);
            }),
            STOP_CURRENT_AUDIO: 'STOP_CURRENT_AUDIO',
        };
        mockTtsState = {
            getTtsState: jest.fn(async () => ({ ...channelConfig })),
            getChannelTtsConfig: jest.fn().mockResolvedValue(mockChannelConfig),
            getGlobalUserPreferences: jest.fn().mockResolvedValue({}),
            getChannelUserPreferences: jest.fn().mockResolvedValue({}),
        };

        jest.unstable_mockModule('@google-cloud/firestore', () => ({ Firestore: jest.fn(() => mockDb), FieldValue }));
        jest.unstable_mockModule('../../src/lib/logger.js', () => ({
            default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        }));
        jest.unstable_mockModule('../../src/components/tts/ttsService.js', () => mockTtsService);
        jest.unstable_mockModule('../../src/components/web/server.js', () => mockWebServer);
        jest.unstable_mockModule('../../src/components/tts/ttsState.js', () => mockTtsState);

        ttsQueue = await import('../../src/components/tts/ttsQueue.js');
        const allowList = await import('../../src/lib/allowList.js');
        allowList.addAllowedChannel(TEST_CHANNEL, '12345');
    });

    describe('enqueue', () => {
        beforeEach(() => ttsQueue.pauseQueue(TEST_CHANNEL));

        it('keeps the card on the queue item', async () => {
            await enqueue('Chat spotlight from ViewerName: hello there', { display: display('hello there') });
            expect(item().display).toEqual({ kind: 'spotlight', user: 'ViewerName', text: 'hello there' });
        });

        it('adds no display field to an item without a card', async () => {
            await enqueue('hello there', { type: 'chat' });
            expect(item()).not.toHaveProperty('display');
        });

        it('ignores a card of an unknown kind', async () => {
            await enqueue('hello there', { display: { kind: 'other', user: 'x', text: 'hello' } });
            expect(item()).not.toHaveProperty('display');
        });

        it('runs the card text through the profanity filter the speech gets', async () => {
            channelConfig.profanityFilterEnabled = true;
            await enqueue('what the fuck was that', { display: display('what the fuck was that') });
            expect(item().text).not.toMatch(/fuck/);
            expect(item().display.text).toBe(item().text);
        });

        it('removes the sound tags the channel turned off', async () => {
            channelConfig.disabledSoundTags = ['moan'];
            await enqueue('hey <moan> there', { display: display('hey <moan> there') });
            expect(item().display.text).not.toMatch(/moan/);
            expect(item().display.text).toBe('hey there');
        });

        it('cuts the text to 200 code points with an ellipsis, without splitting a character', async () => {
            const long = '😀'.repeat(250);
            await enqueue('x', { display: display(long, 'n'.repeat(80)) });
            const shown = Array.from(item().display.text);
            expect(shown).toHaveLength(200);
            expect(shown.at(-1)).toBe('…');
            expect(shown.slice(0, -1).every(c => c === '😀')).toBe(true);
            expect(Array.from(item().display.user)).toHaveLength(50);
        });

        it('collapses whitespace in the card', async () => {
            await enqueue('x', { display: display('  two\n\nlines\t here ') });
            expect(item().display.text).toBe('two lines here');
        });

        it('drops a card with no text left but still queues the clip', async () => {
            channelConfig.disabledSoundTags = ['moan'];
            await enqueue('Chat spotlight from ViewerName: <moan>', { display: display('<moan>') });
            expect(item()).toBeDefined();
            expect(item()).not.toHaveProperty('display');
        });
    });

    describe('handoff, persistence and Pub/Sub', () => {
        beforeEach(async () => {
            await ttsQueue.pauseQueue(TEST_CHANNEL);
            await enqueue('Chat spotlight from ViewerName: hello', { display: display('hello') });
        });

        it('survives takeQueueForHandoff and adoptQueue, also as JSON', async () => {
            const handoff = JSON.parse(JSON.stringify(ttsQueue.takeQueueForHandoff(TEST_CHANNEL)));
            expect(handoff.items[0].display).toEqual(display('hello'));
            ttsQueue.adoptQueue(TEST_CHANNEL, handoff);
            expect(ttsQueue.getOrCreateChannelQueue(TEST_CHANNEL).queue[0].display).toEqual(display('hello'));
        });

        it('survives persistAllQueues and restoreAllQueues', async () => {
            await ttsQueue.persistAllQueues();
            const saved = (await mockDb.collection('ttsQueuePersistence').doc('12345').get()).data();
            expect(saved.queue[0].display).toEqual(display('hello'));

            ttsQueue.getOrCreateChannelQueue(TEST_CHANNEL).queue = [];
            await ttsQueue.restoreAllQueues();
            expect(ttsQueue.getOrCreateChannelQueue(TEST_CHANNEL).queue[0].display).toEqual(display('hello'));
        });
    });

    describe('processQueue', () => {
        const metaCalls = () => calls.filter(c => c.fn === 'meta');

        it('sends the card before audioStart with the same clipId, and before the WAV frame for the rest', async () => {
            await enqueue('Chat spotlight from ViewerName: hello', { display: display('hello') });
            await flush();

            expect(calls.map(c => c.fn)).toEqual(['meta', 'audioStart', 'meta', 'wav']);
            const [pcmMeta, start, wavMeta, frame] = calls;
            expect(pcmMeta.opts).toEqual({ streamOnly: true });
            expect(pcmMeta.clipId).toBe(start.clipId);
            expect(wavMeta.clipId).toBe(start.clipId);
            // The sockets that took the slices never get the meta a second time.
            expect([...wavMeta.opts.exclude]).toEqual(['pcm-socket']);
            expect(frame.opts).toEqual({ exclude: streams[0].recipients });
            expect(pcmMeta.meta).toEqual({ kind: 'spotlight', user: 'ViewerName', text: 'hello', label: 'Chat spotlight', lang: 'en' });
        });

        it('sends the card before the WAV frame when no player takes slices', async () => {
            mockWebServer.openClipStream.mockImplementation((channel, clipId) => {
                calls.push({ fn: 'audioStart?', channel, clipId });
                return null;
            });
            await enqueue('x', { display: display('hello') });
            await flush();
            expect(calls.map(c => c.fn)).toEqual(['meta', 'audioStart?', 'meta', 'wav']);
            const wavMeta = metaCalls()[1];
            expect(typeof wavMeta.clipId).toBe('string');
            expect(wavMeta.opts.exclude.size).toBe(0);
        });

        it('sends no card when spotlightCard is off', async () => {
            channelConfig.spotlightCard = false;
            await enqueue('x', { display: display('hello') });
            await flush();
            expect(metaCalls()).toEqual([]);
            expect(calls.map(c => c.fn)).toEqual(['audioStart', 'wav']);
        });

        it('sends no card for an item without one', async () => {
            await enqueue('hello', { type: 'chat' });
            await flush();
            expect(metaCalls()).toEqual([]);
        });

        it('sends the same card to every shared-chat target, each before its own frames', async () => {
            await ttsQueue.enqueue(TEST_CHANNEL, {
                text: 'x', user: TEST_USER, userId: '1', type: 'spotlight', display: display('hello'),
            }, { sessionId: 's1', channels: ['chan-a', 'chan-b'] });
            await flush();
            expect(calls.map(c => `${c.fn}:${c.channel}`)).toEqual([
                'meta:chan-a', 'audioStart:chan-a', 'meta:chan-b', 'audioStart:chan-b',
                'meta:chan-a', 'wav:chan-a', 'meta:chan-b', 'wav:chan-b',
            ]);
        });

        it('asks for the flex tier for a spotlight clip, also when it is prefetched', async () => {
            await ttsQueue.pauseQueue(TEST_CHANNEL);
            await enqueue('one');
            await enqueue('two');
            await ttsQueue.resumeQueue(TEST_CHANNEL);
            await flush();
            expect(mockTtsService.generateSpeech).toHaveBeenCalledTimes(2);
            for (const call of mockTtsService.generateSpeech.mock.calls) {
                expect(call[2]).toMatchObject({ serviceTier: 'flex' });
            }
        });

        it('does not ask for the flex tier for a clip of another type', async () => {
            await enqueue('hello there', { type: 'chat' });
            await flush();
            expect(mockTtsService.generateSpeech.mock.calls[0][2]).not.toHaveProperty('serviceTier');
        });

        it('sends no WAV card when synthesis fails; the stream ends with discard', async () => {
            mockTtsService.generateSpeech.mockRejectedValue(new Error('provider down'));
            await enqueue('x', { display: display('hello') });
            await flush();
            expect(calls.map(c => c.fn)).toEqual(['meta', 'audioStart']);
            expect(streams[0].end).toHaveBeenCalledWith({ discard: true });
        });

        it('sends a prefetched clip its card only when the clip is delivered', async () => {
            let releaseFirst;
            // The second clip finishes rendering first, while the first still renders.
            mockTtsService.generateSpeech.mockImplementation(text => (text === 'one'
                ? new Promise(r => { releaseFirst = r; })
                : Promise.resolve(wav('02'))));
            await ttsQueue.pauseQueue(TEST_CHANNEL);
            await enqueue('one', { display: display('first') });
            await enqueue('two', { display: display('second') });
            await ttsQueue.resumeQueue(TEST_CHANNEL);
            await flush();
            // The second clip is being prefetched, but only the first card went out.
            expect(mockTtsService.generateSpeech).toHaveBeenCalledTimes(2);
            expect(metaCalls().map(c => c.meta.text)).toEqual(['first']);

            releaseFirst(wav('01'));
            await flush();
            await flush();
            expect(metaCalls().map(c => c.meta.text)).toEqual(['first', 'first', 'second', 'second']);
        });
    });
});

describe('Pub/Sub carries the card', () => {
    it('publishes eventData with display and hands it to the subscriber unchanged', async () => {
        jest.resetModules();
        let published;
        let onMessage;
        const subscription = { on: jest.fn((event, fn) => { if (event === 'message') onMessage = fn; }) };
        const topic = {
            exists: jest.fn().mockResolvedValue([true]),
            publishMessage: jest.fn(async ({ data }) => { published = data; return 'msg-1'; }),
            createSubscription: jest.fn().mockResolvedValue([subscription]),
        };
        jest.unstable_mockModule('@google-cloud/pubsub', () => ({
            PubSub: jest.fn(() => ({ topic: () => topic, createTopic: jest.fn() })),
        }));
        jest.unstable_mockModule('../../src/lib/logger.js', () => ({
            default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        }));
        const pubsub = await import('../../src/lib/pubsub.js');
        await pubsub.initializePubSub();

        const eventData = {
            text: 'Chat spotlight from ViewerName: hello', user: 'viewer', userId: '1', type: 'spotlight',
            display: { kind: 'spotlight', user: 'ViewerName', text: 'hello' },
        };
        await pubsub.publishTtsEvent(TEST_CHANNEL, eventData);

        const handler = jest.fn().mockResolvedValue(undefined);
        await pubsub.subscribeTtsEvents(handler);
        await onMessage({ id: 'm', data: published, ack: jest.fn(), nack: jest.fn() });

        expect(handler).toHaveBeenCalledWith(TEST_CHANNEL, eventData, null);
    });
});
