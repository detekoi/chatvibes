// tests/unit/ttsService.test.js
// generateSpeech against the Gemini provider: the request it sends, the clip it
// returns, and what it does when a request fails. fetch is mocked; nothing here
// touches the network.

import { jest } from '@jest/globals';
import { pcmOf, samplesOf, audioEvent, sse, okResponse, errorResponse, hangingFetch } from '../helpers/geminiSse.js';

const ENDPOINT = 'https://gemini.test/v1beta/interactions';
const MAIN_MODEL = 'main-tts-model';
const FALLBACK_MODEL = 'fallback-tts-model';

describe('ttsService generateSpeech', () => {
    let ttsService;
    let mockLogger;
    let mockConfig;
    let mockFetch;
    let realFetch;

    const requestBody = (call = 0) => JSON.parse(mockFetch.mock.calls[call][1].body);
    const modelsTried = () => mockFetch.mock.calls.map((_call, i) => requestBody(i).model);
    const oneSlice = (...samples) => okResponse(sse(audioEvent(pcmOf(...samples)), '[DONE]'));

    beforeEach(async () => {
        jest.resetModules();
        jest.clearAllMocks();

        mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
        mockConfig = {
            tts: {
                defaultVoiceId: 'puck',
                geminiApiKey: 'test_gemini_key',
                geminiEndpoint: ENDPOINT,
                geminiModel: MAIN_MODEL,
                geminiFallbackModel: FALLBACK_MODEL,
            },
        };

        jest.unstable_mockModule('../../src/lib/logger.js', () => ({ default: mockLogger }));
        jest.unstable_mockModule('../../src/config/index.js', () => ({ default: mockConfig }));

        realFetch = global.fetch;
        mockFetch = jest.fn();
        global.fetch = mockFetch;

        ttsService = await import('../../src/components/tts/ttsService.js');
    });

    afterEach(() => {
        global.fetch = realFetch;
        jest.useRealTimers();
    });

    describe('request', () => {
        test('posts to the configured endpoint with the API key header', async () => {
            mockFetch.mockResolvedValue(oneSlice(1));

            await ttsService.generateSpeech('Hello world', 'kore');

            expect(mockFetch).toHaveBeenCalledTimes(1);
            const [url, init] = mockFetch.mock.calls[0];
            expect(url).toBe(ENDPOINT);
            expect(init.method).toBe('POST');
            expect(init.headers).toEqual({ 'x-goog-api-key': 'test_gemini_key', 'Content-Type': 'application/json' });
            expect(init.signal).toBeInstanceOf(AbortSignal);
        });

        test('sends the model, the text and the voice, streamed and not stored', async () => {
            mockFetch.mockResolvedValue(oneSlice(1));

            await ttsService.generateSpeech('Hello world', 'kore');

            expect(requestBody()).toEqual({
                model: MAIN_MODEL,
                input: [{ type: 'user_input', content: [{ type: 'text', text: 'Hello world' }] }],
                response_format: { type: 'audio' },
                generation_config: { speech_config: [{ voice: 'kore' }] },
                stream: true,
                store: false,
            });
        });

        test('adds the style as a speech_metadata annotation only when there is one', async () => {
            mockFetch.mockImplementation(async () => oneSlice(1));

            await ttsService.generateSpeech('Hello', 'kore', { style: 'happy and cheerful' });
            await ttsService.generateSpeech('Hello', 'kore', { style: '' });

            expect(requestBody(0).input[0].content[0]).toEqual({
                type: 'text',
                text: 'Hello',
                annotations: [{ type: 'speech_metadata', style: 'happy and cheerful' }],
            });
            expect(requestBody(1).input[0].content[0]).toEqual({ type: 'text', text: 'Hello' });
        });

        test('adds the language to the speech config only when there is one', async () => {
            mockFetch.mockImplementation(async () => oneSlice(1));

            await ttsService.generateSpeech('Hola', 'kore', { language: 'es' });
            await ttsService.generateSpeech('Hola', 'kore', { language: undefined });

            expect(requestBody(0).generation_config.speech_config).toEqual([{ voice: 'kore', language: 'es' }]);
            expect(requestBody(1).generation_config.speech_config).toEqual([{ voice: 'kore' }]);
        });

        test('sends a catalog voice by its catalog ID whatever the letter case', async () => {
            mockFetch.mockResolvedValue(oneSlice(1));

            await ttsService.generateSpeech('Hello', 'KORE');

            expect(requestBody().generation_config.speech_config[0].voice).toBe('kore');
        });

        test.each([undefined, 'No_Such_Voice'])('uses the default voice for %p', async voiceId => {
            mockFetch.mockResolvedValue(oneSlice(1));

            await ttsService.generateSpeech('Hello', voiceId);

            expect(requestBody().generation_config.speech_config[0].voice).toBe('puck');
        });

        test('throws when the API key is missing, without a request', async () => {
            mockConfig.tts.geminiApiKey = undefined;

            await expect(ttsService.generateSpeech('Hello', 'kore')).rejects.toThrow('GEMINI_API_KEY is missing');
            expect(mockFetch).not.toHaveBeenCalled();
        });
    });

    describe('result', () => {
        test('returns the whole clip as a WAV buffer', async () => {
            const pcm = pcmOf(...Array.from({ length: 12000 }, (_v, i) => i)); // half a second at 24 kHz
            mockFetch.mockResolvedValue(okResponse(sse(audioEvent(pcm.subarray(0, 8000)), audioEvent(pcm.subarray(8000)), '[DONE]')));

            const audio = await ttsService.generateSpeech('Hello', 'kore');

            expect(audio).toEqual({
                kind: 'buffer',
                data: ttsService.wavFromPcm(pcm, 24000),
                mime: 'audio/wav',
                sampleRate: 24000,
                audioSeconds: 0.5,
                model: MAIN_MODEL,
                usedFallbackModel: false,
            });
            expect(audio.data.subarray(44)).toEqual(pcm);
        });

        test('uses the sample rate of the stream for the WAV header and the length', async () => {
            const pcm = pcmOf(...new Array(48000).fill(1));
            mockFetch.mockResolvedValue(okResponse(sse(audioEvent(pcm, { sample_rate: 48000 }))));

            const audio = await ttsService.generateSpeech('Hello', 'kore');

            expect(audio.sampleRate).toBe(48000);
            expect(audio.audioSeconds).toBe(1);
            expect(audio.data.readUInt32LE(24)).toBe(48000);
        });

        test('forwards each slice to onChunk in order, as whole samples', async () => {
            const whole = pcmOf(10, 20, 30);
            const onChunk = jest.fn();
            // Three network chunks; the first two deltas end in the middle of a sample.
            mockFetch.mockResolvedValue(okResponse(
                sse(audioEvent(whole.subarray(0, 1))),
                sse(audioEvent(whole.subarray(1, 3))),
                sse(audioEvent(whole.subarray(3))),
            ));

            const audio = await ttsService.generateSpeech('Hello', 'kore', { onChunk });

            const slices = onChunk.mock.calls.map(([slice]) => slice);
            expect(slices.every(slice => slice.length % 2 === 0)).toBe(true);
            expect(samplesOf(Buffer.concat(slices))).toEqual([10, 20, 30]);
            expect(audio.data.subarray(44)).toEqual(whole);
        });

        test('applies the volume to the slices and to the returned clip', async () => {
            const onChunk = jest.fn();
            mockFetch.mockResolvedValue(oneSlice(1000, -1000, 30000));

            const audio = await ttsService.generateSpeech('Hello', 'kore', { volume: 1.5, onChunk });

            expect(samplesOf(onChunk.mock.calls[0][0])).toEqual([1500, -1500, 32767]);
            expect(samplesOf(audio.data.subarray(44))).toEqual([1500, -1500, 32767]);
        });
    });

    describe('retries', () => {
        test('tries the main model twice, then the fallback model once', async () => {
            mockFetch
                .mockResolvedValueOnce(errorResponse(503, { error: { message: 'unavailable' } }))
                .mockRejectedValueOnce(new Error('socket hang up'))
                .mockResolvedValueOnce(oneSlice(1));

            const audio = await ttsService.generateSpeech('Hello', 'kore');

            expect(modelsTried()).toEqual([MAIN_MODEL, MAIN_MODEL, FALLBACK_MODEL]);
            expect(audio.model).toBe(FALLBACK_MODEL);
            expect(audio.usedFallbackModel).toBe(true);
        });

        test('a second attempt on the main model is not a fallback', async () => {
            mockFetch
                .mockResolvedValueOnce(errorResponse(500, 'Internal Server Error'))
                .mockResolvedValueOnce(oneSlice(1));

            const audio = await ttsService.generateSpeech('Hello', 'kore');

            expect(modelsTried()).toEqual([MAIN_MODEL, MAIN_MODEL]);
            expect(audio.model).toBe(MAIN_MODEL);
            expect(audio.usedFallbackModel).toBe(false);
        });

        test('throws the last error once every attempt failed', async () => {
            mockFetch
                .mockResolvedValueOnce(errorResponse(500, 'first'))
                .mockResolvedValueOnce(errorResponse(500, 'second'))
                .mockResolvedValueOnce(errorResponse(429, { error: { code: 'resource_exhausted', message: 'quota' } }));

            const failure = await ttsService.generateSpeech('Hello', 'kore').catch(err => err);

            expect(mockFetch).toHaveBeenCalledTimes(3);
            expect(failure.message).toBe('Gemini TTS HTTP 429: quota');
            expect(failure.status).toBe(429);
        });

        test.each([
            ['is empty', ''],
            ['is the main model', MAIN_MODEL],
        ])('makes two attempts when the fallback model %s', async (_label, fallbackModel) => {
            mockConfig.tts.geminiFallbackModel = fallbackModel;
            mockFetch.mockImplementation(async () => errorResponse(500, 'down'));

            await expect(ttsService.generateSpeech('Hello', 'kore')).rejects.toThrow('Gemini TTS HTTP 500');

            expect(modelsTried()).toEqual([MAIN_MODEL, MAIN_MODEL]);
        });

        test('retries a stream that closed with no audio', async () => {
            mockFetch
                .mockResolvedValueOnce(okResponse(sse('[DONE]')))
                .mockResolvedValueOnce(oneSlice(1));

            const audio = await ttsService.generateSpeech('Hello', 'kore');

            expect(mockFetch).toHaveBeenCalledTimes(2);
            expect(audio.kind).toBe('buffer');
        });

        test('retries an error event that arrived before any audio', async () => {
            const onChunk = jest.fn();
            mockFetch
                .mockResolvedValueOnce(okResponse(sse({ error: { message: 'model overloaded' } })))
                .mockResolvedValueOnce(oneSlice(1));

            await ttsService.generateSpeech('Hello', 'kore', { onChunk });

            expect(mockFetch).toHaveBeenCalledTimes(2);
            expect(onChunk).toHaveBeenCalledTimes(1);
        });

        test('does not retry once a slice was forwarded', async () => {
            const onChunk = jest.fn();
            mockFetch.mockResolvedValue(okResponse(sse(audioEvent(pcmOf(1, 2))), sse({ error: { message: 'stream broke' } })));

            await expect(ttsService.generateSpeech('Hello', 'kore', { onChunk })).rejects.toThrow('stream broke');

            expect(mockFetch).toHaveBeenCalledTimes(1);
            expect(onChunk).toHaveBeenCalledTimes(1);
        });

        test('does not retry after a slice even when the caller passed no onChunk', async () => {
            mockFetch.mockResolvedValue(okResponse(sse(audioEvent(pcmOf(1, 2))), sse({ error: { message: 'stream broke' } })));

            await expect(ttsService.generateSpeech('Hello', 'kore')).rejects.toThrow('stream broke');

            expect(mockFetch).toHaveBeenCalledTimes(1);
        });
    });

    describe('blocked text', () => {
        test.each([
            ['the prohibited_content code', { error: { code: 'prohibited_content', message: 'The text was refused.' } }],
            ['an "Input blocked" message', { error: { code: 'invalid_request', message: 'Input blocked by the safety filter.' } }],
            ['an "input was blocked" message', { error: { message: 'The input was blocked.' } }],
        ])('throws TtsBlockedError on HTTP 400 with %s, without a retry', async (_label, payload) => {
            mockFetch.mockImplementation(async () => errorResponse(400, payload));

            const failure = await ttsService.generateSpeech('Hello', 'kore').catch(err => err);

            expect(failure).toBeInstanceOf(ttsService.TtsBlockedError);
            expect(failure.name).toBe('TtsBlockedError');
            expect(failure.message).toContain(payload.error.message);
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        test('recognises a refusal in a body that is not JSON', async () => {
            mockFetch.mockImplementation(async () => errorResponse(400, 'Input blocked'));

            await expect(ttsService.generateSpeech('Hello', 'kore')).rejects.toBeInstanceOf(ttsService.TtsBlockedError);
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        test('does not retry a refusal carried inside the stream', async () => {
            mockFetch.mockImplementation(async () => okResponse(sse({ error: { code: 'prohibited_content', message: 'refused' } })));

            await expect(ttsService.generateSpeech('Hello', 'kore')).rejects.toBeInstanceOf(ttsService.TtsBlockedError);
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        test('logs a refusal at info, not as a provider error', async () => {
            mockFetch.mockImplementation(async () => errorResponse(400, { error: { code: 'prohibited_content', message: 'refused' } }));

            await ttsService.generateSpeech('Hello', 'kore').catch(() => {});

            expect(mockLogger.info).toHaveBeenCalledWith(expect.objectContaining({ logKey: 'GEMINI_TTS_BLOCKED' }), expect.any(String));
            expect(mockLogger.warn).not.toHaveBeenCalledWith(expect.objectContaining({ logKey: 'GEMINI_TTS_ERROR' }), expect.any(String));
        });

        test('an ordinary HTTP 400 is retried like any other failure', async () => {
            mockFetch.mockImplementation(async () => errorResponse(400, { error: { code: 'invalid_request', message: 'Unknown voice' } }));

            const failure = await ttsService.generateSpeech('Hello', 'kore').catch(err => err);

            expect(failure).not.toBeInstanceOf(ttsService.TtsBlockedError);
            expect(failure.status).toBe(400);
            expect(mockFetch).toHaveBeenCalledTimes(3);
        });
    });

    describe('abort', () => {
        test('rejects with AbortError when the signal fires during the request, and stops', async () => {
            mockFetch.mockImplementation(hangingFetch);
            const controller = new AbortController();

            const pending = ttsService.generateSpeech('Hello', 'kore', { signal: controller.signal });
            controller.abort();

            await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        test('passes the abort on to the request', async () => {
            mockFetch.mockImplementation(hangingFetch);
            const controller = new AbortController();

            const pending = ttsService.generateSpeech('Hello', 'kore', { signal: controller.signal });
            const requestSignal = mockFetch.mock.calls[0][1].signal;
            expect(requestSignal.aborted).toBe(false);
            controller.abort();

            await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
            expect(requestSignal.aborted).toBe(true);
        });

        test('rejects with AbortError when the signal fires in the middle of the stream', async () => {
            const controller = new AbortController();
            const onChunk = jest.fn();
            mockFetch.mockImplementation(async (_url, { signal }) => ({
                ok: true,
                status: 200,
                text: async () => '',
                body: (async function* () {
                    yield Buffer.from(sse(audioEvent(pcmOf(1, 2))));
                    await hangingFetch(null, { signal });
                })(),
            }));

            const pending = ttsService.generateSpeech('Hello', 'kore', { signal: controller.signal, onChunk });
            await new Promise(resolve => setImmediate(resolve));
            expect(onChunk).toHaveBeenCalledTimes(1);
            controller.abort();

            await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        test('rejects with AbortError for a signal that had already fired', async () => {
            mockFetch.mockImplementation(hangingFetch);
            const controller = new AbortController();
            controller.abort();

            await expect(ttsService.generateSpeech('Hello', 'kore', { signal: controller.signal }))
                .rejects.toMatchObject({ name: 'AbortError', message: 'Speech generation was aborted' });
            expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(1);
        });
    });

    describe('timeouts', () => {
        beforeEach(() => {
            jest.useFakeTimers();
        });

        test('gives up on a request with no answer after 4 s and moves to the next attempt', async () => {
            mockFetch
                .mockImplementationOnce(hangingFetch)
                .mockImplementationOnce(async () => oneSlice(1));

            const pending = ttsService.generateSpeech('Hello', 'kore');
            await jest.advanceTimersByTimeAsync(3999);
            expect(mockFetch).toHaveBeenCalledTimes(1);
            await jest.advanceTimersByTimeAsync(1);

            const audio = await pending;
            expect(mockFetch).toHaveBeenCalledTimes(2);
            expect(audio.usedFallbackModel).toBe(false);
        });

        test('reports a timeout, not an abort, when every attempt stays silent', async () => {
            mockFetch.mockImplementation(hangingFetch);

            const failure = ttsService.generateSpeech('Hello', 'kore').catch(err => err);
            await jest.advanceTimersByTimeAsync(12000);

            const err = await failure;
            expect(err.name).not.toBe('AbortError');
            expect(err.message).toBe('Gemini TTS request timed out (no audio before the first-chunk timeout)');
            expect(modelsTried()).toEqual([MAIN_MODEL, MAIN_MODEL, FALLBACK_MODEL]);
        });

        test('fails a clip whose stream goes silent for 4 s after a slice, with no retry', async () => {
            const onChunk = jest.fn();
            mockFetch.mockImplementation(async (_url, { signal }) => ({
                ok: true,
                status: 200,
                text: async () => '',
                body: (async function* () {
                    yield Buffer.from(sse(audioEvent(pcmOf(1, 2))));
                    await hangingFetch(null, { signal });
                })(),
            }));

            const failure = ttsService.generateSpeech('Hello', 'kore', { onChunk }).catch(err => err);
            await jest.advanceTimersByTimeAsync(3999);
            expect(onChunk).toHaveBeenCalledTimes(1);
            await jest.advanceTimersByTimeAsync(1);

            expect((await failure).message).toBe('Gemini TTS request timed out (the stream went silent)');
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        test('each network chunk restarts the silence timer', async () => {
            let release;
            mockFetch.mockImplementation(async () => ({
                ok: true,
                status: 200,
                text: async () => '',
                body: (async function* () {
                    yield Buffer.from(sse(audioEvent(pcmOf(1))));
                    await new Promise(resolve => { release = resolve; });
                    yield Buffer.from(sse(audioEvent(pcmOf(2))));
                })(),
            }));

            const pending = ttsService.generateSpeech('Hello', 'kore');
            // 3 s to the second chunk: past 4 s since the request began, within 4 s of the first chunk.
            await jest.advanceTimersByTimeAsync(3000);
            release();
            await jest.advanceTimersByTimeAsync(3000);

            const audio = await pending;
            expect(samplesOf(audio.data.subarray(44))).toEqual([1, 2]);
        });
    });

    describe('getAvailableVoices', () => {
        test('returns the catalog voices, each with the ID the commands match on', async () => {
            const { getVoiceCatalog } = await import('../../src/components/tts/voiceResolver.js');

            const voices = await ttsService.getAvailableVoices();

            expect(voices).toBe(getVoiceCatalog());
            expect(voices.length).toBeGreaterThan(0);
            expect(voices.every(voice => typeof voice.id === 'string' && voice.id === voice.id.toLowerCase())).toBe(true);
            expect(voices.map(voice => voice.id)).toEqual(expect.arrayContaining(['puck', 'kore', 'en-us-storyteller-11']));
            expect(voices.find(voice => voice.id === 'puck')).toMatchObject({ name: 'Puck', language: expect.any(String) });
        });

        test('lists every ID once', async () => {
            const ids = (await ttsService.getAvailableVoices()).map(voice => voice.id);

            expect(new Set(ids).size).toBe(ids.length);
        });

        test('makes no request', async () => {
            await ttsService.getAvailableVoices();

            expect(mockFetch).not.toHaveBeenCalled();
        });
    });
});
