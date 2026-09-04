// tests/unit/ttsTiming.test.js
// The TTS_TIMING log line is how production latency gets read, so this pins that
// the record survives the trip from the async context to the queue item and that
// the stages it reports are computed from the right marks.

import { jest } from '@jest/globals';
import { createMockFirestore, FieldValue } from '../helpers/mockFirestore.js';
import { TEST_CHANNEL, TEST_USER, mockChannelConfig } from '../helpers/testData.js';

describe('ttsTiming', () => {
    let timing;

    beforeEach(async () => {
        jest.resetModules();
        timing = await import('../../src/lib/ttsTiming.js');
    });

    test('record follows the async context across awaits and nested calls', async () => {
        const inner = async () => {
            await new Promise(r => setTimeout(r, 1));
            timing.markTiming('claimedMs', 42);
            return timing.currentTiming();
        };
        const seen = await timing.runWithTiming({ source: 'eventsub', receivedMs: 10 }, inner);
        expect(seen).toEqual({ source: 'eventsub', receivedMs: 10, claimedMs: 42 });
        expect(timing.currentTiming()).toBeNull();
    });

    test('snapshot is detached from the live record', async () => {
        await timing.runWithTiming({ receivedMs: 1 }, () => {
            const snap = timing.snapshotTiming();
            timing.markTiming('claimedMs', 2);
            expect(snap).toEqual({ receivedMs: 1 });
            expect(timing.currentTiming()).toEqual({ receivedMs: 1, claimedMs: 2 });
        });
    });

    test('marking outside a context is a no-op and helpers return null', () => {
        expect(timing.markTiming('x')).toBeNull();
        expect(timing.snapshotTiming()).toBeNull();
        expect(timing.elapsed(null, 'a', 'b')).toBeNull();
        expect(timing.elapsed({ a: 5 }, 'a', 'b')).toBeNull();
        expect(timing.elapsed({ a: 5, b: 12 }, 'a', 'b')).toBe(7);
    });
});

describe('ttsQueue TTS_TIMING log', () => {
    let mockLogger;
    let mockTtsService;
    let mockWebServer;
    let ttsQueue;
    let timing;

    beforeEach(async () => {
        jest.resetModules();
        jest.clearAllMocks();

        mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
        mockTtsService = { generateSpeech: jest.fn() };
        mockWebServer = {
            sendAudioToChannel: jest.fn(),
            hasActiveClients: jest.fn().mockReturnValue(true),
            channelPrefersUrlAudio: jest.fn().mockReturnValue(false),
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

        jest.unstable_mockModule('@google-cloud/firestore', () => ({
            Firestore: jest.fn(() => createMockFirestore()),
            FieldValue
        }));
        jest.unstable_mockModule('../../src/lib/logger.js', () => ({ default: mockLogger }));
        jest.unstable_mockModule('../../src/components/tts/ttsService.js', () => mockTtsService);
        jest.unstable_mockModule('../../src/components/web/server.js', () => mockWebServer);
        jest.unstable_mockModule('../../src/components/tts/ttsState.js', () => mockTtsState);

        ttsQueue = await import('../../src/components/tts/ttsQueue.js');
        timing = await import('../../src/lib/ttsTiming.js');
        const allowList = await import('../../src/lib/allowList.js');
        allowList.addAllowedChannel(TEST_CHANNEL, '12345');
    });

    const timingLogs = () => mockLogger.info.mock.calls
        .map(([data]) => data)
        .filter(d => d && d.logKey === 'TTS_TIMING');

    const flush = () => new Promise(r => setImmediate(() => setImmediate(r)));

    test('emits one line per clip with the stages computed from the record', async () => {
        const buffer = { kind: 'buffer', data: Buffer.from([0xff, 0xfb, 0x90, 0x00]), mime: 'audio/mpeg' };
        mockTtsService.generateSpeech.mockResolvedValue(buffer);

        const originMs = Date.now() - 250;
        await timing.runWithTiming(
            { source: 'eventsub', originMs, receivedMs: originMs + 200, route: 'local' },
            () => ttsQueue.enqueue(TEST_CHANNEL, { text: 'hello chat', user: TEST_USER, type: 'chat' })
        );
        await flush();

        expect(mockWebServer.sendAudioToChannel).toHaveBeenCalledWith(TEST_CHANNEL, buffer);
        const logs = timingLogs();
        expect(logs).toHaveLength(1);
        const line = logs[0];
        expect(line).toMatchObject({
            channel: TEST_CHANNEL,
            user: TEST_USER,
            type: 'chat',
            source: 'eventsub',
            route: 'local',
            prefetched: false,
            textLength: 'hello chat'.length,
            audioKind: 'buffer',
            audioBytes: 4,
            twitchToWebhookMs: 200,
            claimMs: null,
            pubsubHopMs: null,
        });
        expect(line.handlerMs).toBeGreaterThanOrEqual(0);
        expect(line.enqueueMs).toBeGreaterThanOrEqual(0);
        expect(line.queueWaitMs).toBeGreaterThanOrEqual(0);
        expect(line.generateMs).toBeGreaterThanOrEqual(0);
        expect(line.waitedForAudioMs).toBe(line.generateMs);
        // Measured from Twitch's timestamp, so it includes the 250ms already elapsed.
        expect(line.totalMs).toBeGreaterThanOrEqual(250);
    });

    test('a prefetched clip reports generateMs from the prefetch start', async () => {
        const clip = { kind: 'buffer', data: Buffer.from([1, 2, 3]), mime: 'audio/mpeg' };
        const after = ms => new Promise(r => setTimeout(() => r(clip), ms));
        let resolveFirst;
        // Prefetch covers items queued *behind* the one being started, so three
        // items are needed: the first blocks so two and three are queued behind it.
        // When the queue starts on two, it prefetches three *before* making two's
        // own call, so provider calls go: one, three (prefetch), two. Three's render
        // is the slow one, so it is still in flight when the queue reaches it.
        mockTtsService.generateSpeech
            .mockReturnValueOnce(new Promise(r => { resolveFirst = r; }))
            .mockReturnValueOnce(after(40))   // three, prefetched
            .mockReturnValueOnce(after(10));  // two

        // Texts of distinct lengths so log lines can be told apart by textLength.
        const run = text => timing.runWithTiming(
            { source: 'eventsub', receivedMs: Date.now(), route: 'local' },
            () => ttsQueue.enqueue(TEST_CHANNEL, { text, user: TEST_USER, type: 'chat' })
        );
        await run('a');
        await run('bb');
        await run('ccc');
        await flush();
        expect(mockTtsService.generateSpeech).toHaveBeenCalledTimes(1);

        resolveFirst(clip);
        await new Promise(r => setTimeout(r, 80));

        const logs = timingLogs();
        expect(logs).toHaveLength(3);
        const two = logs.find(l => l.textLength === 2);
        const three = logs.find(l => l.textLength === 3);
        expect(two.prefetched).toBe(false);
        expect(three.prefetched).toBe(true);
        // Three's provider call started while two was still rendering, so the round
        // trip is longer than the time the queue actually blocked waiting for it.
        expect(three.generateMs).toBeGreaterThanOrEqual(40);
        expect(three.waitedForAudioMs).toBeLessThan(three.generateMs);
        expect(three.queueWaitMs).toBeGreaterThanOrEqual(10);
    });

    test('logs nothing for an item enqueued outside a timing context', async () => {
        mockTtsService.generateSpeech.mockResolvedValue({ kind: 'url', url: 'https://cdn.example/a.mp3' });
        await ttsQueue.enqueue(TEST_CHANNEL, { text: 'restored', user: TEST_USER, type: 'chat' });
        await flush();
        expect(mockWebServer.sendAudioToChannel).toHaveBeenCalled();
        expect(timingLogs()).toHaveLength(0);
    });
});
