// tests/unit/ttsQueueChunked.test.js
// Chunked delivery from the queue: slices are forwarded to chunk-capable players in
// order as the provider renders them, a prefetched clip's buffered slices are
// replayed when its turn comes, the whole buffer is not sent twice, and every
// opened clip is closed — with discard when the audio arrives another way or not at all.

import { jest } from '@jest/globals';
import { createMockFirestore, FieldValue } from '../helpers/mockFirestore.js';
import { TEST_CHANNEL, TEST_USER, mockChannelConfig } from '../helpers/testData.js';

describe('ttsQueue chunked delivery', () => {
    let mockLogger;
    let mockTtsService;
    let mockWebServer;
    let ttsQueue;
    let streams;

    const flush = () => new Promise(r => setImmediate(() => setImmediate(r)));
    const clip = hex => ({ kind: 'buffer', data: Buffer.from(hex, 'hex'), mime: 'audio/mpeg' });

    beforeEach(async () => {
        jest.resetModules();
        jest.clearAllMocks();

        streams = [];
        mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
        mockTtsService = { generateSpeech: jest.fn() };
        mockWebServer = {
            sendAudioToChannel: jest.fn(),
            hasActiveClients: jest.fn().mockReturnValue(true),
            channelPrefersUrlAudio: jest.fn().mockReturnValue(false),
            openClipStream: jest.fn((channel, clipId) => {
                const stream = { channel, clipId, recipients: new Set(['ws-1']), chunk: jest.fn(), end: jest.fn() };
                streams.push(stream);
                return stream;
            }),
            STOP_CURRENT_AUDIO: 'STOP_CURRENT_AUDIO'
        };
        const mockTtsState = {
            getTtsState: jest.fn().mockResolvedValue({ ...mockChannelConfig, engineEnabled: true }),
            getChannelTtsConfig: jest.fn().mockResolvedValue(mockChannelConfig),
            getGlobalUserPreferences: jest.fn().mockResolvedValue({}),
            getUserEmotionPreference: jest.fn().mockResolvedValue(null),
            getUserVoicePreference: jest.fn().mockResolvedValue(null),
            getUserPitchPreference: jest.fn().mockResolvedValue(null),
            getUserSpeedPreference: jest.fn().mockResolvedValue(null),
            getUserLanguagePreference: jest.fn().mockResolvedValue(null),
            getUserEnglishNormalizationPreference: jest.fn().mockResolvedValue(null)
        };

        jest.unstable_mockModule('@google-cloud/firestore', () => ({ Firestore: jest.fn(() => createMockFirestore()), FieldValue }));
        jest.unstable_mockModule('../../src/lib/logger.js', () => ({ default: mockLogger }));
        jest.unstable_mockModule('../../src/components/tts/ttsService.js', () => mockTtsService);
        jest.unstable_mockModule('../../src/components/web/server.js', () => mockWebServer);
        jest.unstable_mockModule('../../src/components/tts/ttsState.js', () => mockTtsState);

        ttsQueue = await import('../../src/components/tts/ttsQueue.js');
        const allowList = await import('../../src/lib/allowList.js');
        allowList.addAllowedChannel(TEST_CHANNEL, '12345');
    });

    const enqueue = text => ttsQueue.enqueue(TEST_CHANNEL, { text, user: TEST_USER, type: 'chat' });

    test('forwards slices in order, closes the clip, and excludes recipients from the whole-buffer send', async () => {
        mockTtsService.generateSpeech.mockImplementation(async (text, voiceId, options) => {
            options.onChunk(Buffer.from('ff', 'hex'));
            await new Promise(r => setTimeout(r, 5));
            options.onChunk(Buffer.from('fb', 'hex'));
            return clip('fffb');
        });

        await enqueue('hello');
        await new Promise(r => setTimeout(r, 30));

        expect(mockWebServer.openClipStream).toHaveBeenCalledTimes(1);
        expect(mockWebServer.openClipStream).toHaveBeenCalledWith(TEST_CHANNEL, expect.any(String));
        const [stream] = streams;
        expect(stream.chunk.mock.calls.map(([b]) => b.toString('hex'))).toEqual(['ff', 'fb']);
        expect(stream.end).toHaveBeenCalledWith({ discard: false });
        expect(mockWebServer.sendAudioToChannel).toHaveBeenCalledWith(TEST_CHANNEL, clip('fffb'), { exclude: stream.recipients });
        // The slices were forwarded before the clip closed.
        expect(stream.chunk.mock.invocationCallOrder.at(-1)).toBeLessThan(stream.end.mock.invocationCallOrder[0]);
    });

    test('falls back to the whole-buffer send when no player is chunk-capable', async () => {
        mockWebServer.openClipStream.mockReturnValue(null);
        mockTtsService.generateSpeech.mockResolvedValue(clip('fffb'));

        await enqueue('hello');
        await flush();

        expect(mockWebServer.sendAudioToChannel).toHaveBeenCalledWith(TEST_CHANNEL, clip('fffb'));
        expect(mockWebServer.sendAudioToChannel.mock.calls[0]).toHaveLength(2);
    });

    test('discards the streamed clip when the audio comes back as a URL, then sends the URL to everyone', async () => {
        mockTtsService.generateSpeech.mockImplementation(async (text, voiceId, options) => {
            options.onChunk(Buffer.from('ff', 'hex')); // a slice from a 302 attempt that then failed over
            return { kind: 'url', url: 'https://cdn.example/a.mp3' };
        });

        await enqueue('hello');
        await flush();

        const [stream] = streams;
        expect(stream.end).toHaveBeenCalledWith({ discard: true });
        expect(mockWebServer.sendAudioToChannel).toHaveBeenCalledWith(TEST_CHANNEL, { kind: 'url', url: 'https://cdn.example/a.mp3' });
        expect(mockWebServer.sendAudioToChannel.mock.calls[0]).toHaveLength(2);
    });

    test('discards the clip when generation fails, so the player does not wait forever', async () => {
        mockTtsService.generateSpeech.mockRejectedValue(new Error('provider down'));

        await enqueue('hello');
        await flush();

        const [stream] = streams;
        expect(stream.end).toHaveBeenCalledTimes(1);
        expect(stream.end).toHaveBeenCalledWith({ discard: true });
        expect(mockWebServer.sendAudioToChannel).not.toHaveBeenCalled();
    });

    test('replays the slices a prefetch already collected when the clip reaches the front', async () => {
        let resolveFirst;
        let resolveSecond;
        mockTtsService.generateSpeech
            .mockImplementationOnce(() => new Promise(r => { resolveFirst = r; }))
            // Prefetched while the first is still rendering: slices land now,
            // the clip completes later.
            .mockImplementationOnce((text, voiceId, options) => {
                options.onChunk(Buffer.from('aa', 'hex'));
                options.onChunk(Buffer.from('bb', 'hex'));
                return new Promise(r => { resolveSecond = r; });
            });

        await enqueue('one');
        await enqueue('two');
        await flush();
        expect(mockTtsService.generateSpeech).toHaveBeenCalledTimes(1);

        resolveFirst(clip('01'));
        await flush();
        await flush();
        // Second is now at the front: its prefetch started (slices already pushed)
        // and its stream opened with those slices replayed straight away.
        expect(mockTtsService.generateSpeech).toHaveBeenCalledTimes(2);
        expect(streams).toHaveLength(2);
        const second = streams[1];
        expect(second.chunk.mock.calls.map(([b]) => b.toString('hex'))).toEqual(['aa', 'bb']);
        expect(second.end).not.toHaveBeenCalled();

        resolveSecond(clip('aabb'));
        await flush();
        expect(second.end).toHaveBeenCalledWith({ discard: false });
        expect(mockWebServer.sendAudioToChannel).toHaveBeenCalledWith(TEST_CHANNEL, clip('aabb'), { exclude: second.recipients });
    });

    test('opens a stream on every participant of a shared session', async () => {
        const allowList = await import('../../src/lib/allowList.js');
        allowList.addAllowedChannel('partner', '67890');
        mockTtsService.generateSpeech.mockImplementation(async (text, voiceId, options) => {
            options.onChunk(Buffer.from('ff', 'hex'));
            return clip('ff');
        });

        await ttsQueue.enqueue(TEST_CHANNEL, { text: 'hi', user: TEST_USER, type: 'chat' }, { sessionId: 's1', channels: [TEST_CHANNEL, 'partner'] });
        await flush();

        expect(mockWebServer.openClipStream.mock.calls.map(([c]) => c)).toEqual([TEST_CHANNEL, 'partner']);
        const [a, b] = streams;
        expect(a.clipId).toBe(b.clipId);
        expect(a.chunk).toHaveBeenCalledTimes(1);
        expect(b.chunk).toHaveBeenCalledTimes(1);
        expect(a.end).toHaveBeenCalledWith({ discard: false });
        expect(b.end).toHaveBeenCalledWith({ discard: false });
    });
});
