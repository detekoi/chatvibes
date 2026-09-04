// tests/unit/ttsServiceStream.test.js
// The 302.ai streaming path: the request asks for server-sent events, the slices
// are handed to onChunk in order as they land, and the concatenation is the clip.
// Failure inside the stream must still reach the Wavespeed fallback, and a stream
// that goes quiet must time out rather than hang the queue.

import { jest } from '@jest/globals';
import { Readable } from 'node:stream';

const sse = events => events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
const chunkEvent = hex => ({ data: { audio: hex, status: 1 }, base_resp: { status_code: 0, status_msg: 'success' } });
const finalEvent = (hex = '') => ({ data: { audio: hex, status: 2 }, base_resp: { status_code: 0, status_msg: 'success' } });

/** A Readable that emits the given string pieces one per tick, then ends. */
function streamOf(pieces, { end = true } = {}) {
    const queue = [...pieces];
    return new Readable({
        read() {
            if (queue.length) {
                setImmediate(() => this.push(queue.shift()));
            } else if (end) {
                setImmediate(() => this.push(null));
            }
        },
    });
}

describe('readSseAudio', () => {
    let readSseAudio;
    beforeEach(async () => {
        jest.resetModules();
        jest.unstable_mockModule('../../src/lib/logger.js', () => ({
            default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
        }));
        jest.unstable_mockModule('../../src/config/index.js', () => ({
            default: { tts: { t302ApiKey: 'k', t302Endpoint: 'https://302.test/t2a_v2', wavespeedApiKey: 'w', wavespeedEndpoint: 'https://ws.test' } }
        }));
        ({ readSseAudio } = await import('../../src/components/tts/ttsService.js'));
    });

    test('hands slices to onChunk in order and resolves with their concatenation', async () => {
        const onChunk = jest.fn();
        const stream = streamOf([sse([chunkEvent('fffb')]), sse([chunkEvent('9000'), finalEvent()])]);
        const data = await readSseAudio(stream, { onChunk, idleTimeoutMs: 1000 });
        expect(onChunk.mock.calls.map(([b]) => b.toString('hex'))).toEqual(['fffb', '9000']);
        expect(data.toString('hex')).toBe('fffb9000');
    });

    test('reassembles an event split across two reads', async () => {
        const whole = sse([chunkEvent('aabbccdd'), finalEvent()]);
        const stream = streamOf([whole.slice(0, 15), whole.slice(15)]);
        const data = await readSseAudio(stream, { idleTimeoutMs: 1000 });
        expect(data.toString('hex')).toBe('aabbccdd');
    });

    test('ignores an aggregated clip repeated on the final event', async () => {
        const stream = streamOf([sse([chunkEvent('01'), chunkEvent('02'), finalEvent('0102')])]);
        const data = await readSseAudio(stream, { idleTimeoutMs: 1000 });
        expect(data.toString('hex')).toBe('0102');
    });

    test('uses the final event audio when no slices preceded it', async () => {
        const stream = streamOf([sse([finalEvent('0102')])]);
        const data = await readSseAudio(stream, { idleTimeoutMs: 1000 });
        expect(data.toString('hex')).toBe('0102');
    });

    test('resolves on a stream that ends without a final event but carried audio', async () => {
        const stream = streamOf([sse([chunkEvent('ff')])]);
        const data = await readSseAudio(stream, { idleTimeoutMs: 1000 });
        expect(data.toString('hex')).toBe('ff');
    });

    test('rejects an empty stream', async () => {
        await expect(readSseAudio(streamOf(['']), { idleTimeoutMs: 1000 })).rejects.toThrow(/no audio payload/);
    });

    test('surfaces an API-level error carried inside the stream', async () => {
        const stream = streamOf([sse([{ base_resp: { status_code: 1002, status_msg: 'rate limited' } }])]);
        await expect(readSseAudio(stream, { idleTimeoutMs: 1000 })).rejects.toThrow('302.ai API error 1002: rate limited');
    });

    test('times out when the stream goes quiet, with a code the retry logic recognises', async () => {
        const stream = streamOf([sse([chunkEvent('ff')])], { end: false });
        const err = await readSseAudio(stream, { idleTimeoutMs: 30 }).catch(e => e);
        expect(err.message).toMatch(/timed out/);
        expect(err.code).toBe('ECONNABORTED');
        expect(stream.destroyed).toBe(true);
    });

    test('rejects with AbortError when the signal fires mid-stream', async () => {
        const controller = new AbortController();
        const stream = streamOf([sse([chunkEvent('ff')])], { end: false });
        const pending = readSseAudio(stream, { signal: controller.signal, idleTimeoutMs: 1000 });
        setTimeout(() => controller.abort(), 5);
        const err = await pending.catch(e => e);
        expect(err.name).toBe('AbortError');
        expect(stream.destroyed).toBe(true);
    });
});

describe('generateSpeech via 302.ai streaming', () => {
    let mockAxios;
    let mockLogger;
    let ttsService;

    beforeEach(async () => {
        jest.resetModules();
        mockAxios = jest.fn();
        mockAxios.get = jest.fn();
        mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
        jest.unstable_mockModule('axios', () => ({ default: mockAxios }));
        jest.unstable_mockModule('../../src/lib/logger.js', () => ({ default: mockLogger }));
        jest.unstable_mockModule('../../src/config/index.js', () => ({
            default: {
                tts: {
                    t302ApiKey: 'k', t302Endpoint: 'https://302.test/t2a_v2', t302Streaming: true,
                    wavespeedApiKey: 'w', wavespeedEndpoint: 'https://ws.test/speech',
                    defaultVoiceId: 'Friendly_Person', defaultEmotion: 'neutral', defaultLanguageBoost: 'auto',
                }
            }
        }));
        ttsService = await import('../../src/components/tts/ttsService.js');
        ttsService._resetT302Circuit();
    });

    test('asks for a stream, forwards slices, and returns the whole clip as a buffer', async () => {
        mockAxios.mockResolvedValueOnce({ data: streamOf([sse([chunkEvent('fffb'), chunkEvent('9000'), finalEvent()])]) });
        const onChunk = jest.fn();

        const audio = await ttsService.generateSpeech('hello', 'Friendly_Person', { onChunk });

        expect(mockAxios).toHaveBeenCalledTimes(1);
        const req = mockAxios.mock.calls[0][0];
        expect(req.url).toBe('https://302.test/t2a_v2');
        expect(req.responseType).toBe('stream');
        expect(req.data.stream).toBe(true);
        expect(req.data.output_format).toBe('hex');
        expect(req.data.stream_options).toEqual({ exclude_aggregated_audio: true });
        expect(onChunk).toHaveBeenCalledTimes(2);
        expect(audio).toEqual({ kind: 'buffer', data: Buffer.from('fffb9000', 'hex'), mime: 'audio/mpeg' });
    });

    test('does not stream when a stale player forces the URL path', async () => {
        mockAxios.mockResolvedValueOnce({ data: { data: { audio: 'https://oss.example/a.mp3' }, base_resp: { status_code: 0 } } });
        const audio = await ttsService.generateSpeech('hello', 'Friendly_Person', { preferUrlOutput: true });
        const req = mockAxios.mock.calls[0][0];
        expect(req.responseType).toBeUndefined();
        expect(req.data.stream).toBe(false);
        expect(req.data.stream_options).toBeUndefined();
        expect(audio).toEqual({ kind: 'url', url: 'https://oss.example/a.mp3' });
    });

    test('does not stream when T302_STREAMING is off', async () => {
        jest.resetModules();
        jest.unstable_mockModule('axios', () => ({ default: mockAxios }));
        jest.unstable_mockModule('../../src/lib/logger.js', () => ({ default: mockLogger }));
        jest.unstable_mockModule('../../src/config/index.js', () => ({
            default: { tts: { t302ApiKey: 'k', t302Endpoint: 'https://302.test/t2a_v2', t302Streaming: false, wavespeedApiKey: 'w', wavespeedEndpoint: 'https://ws.test/speech' } }
        }));
        const svc = await import('../../src/components/tts/ttsService.js');
        mockAxios.mockResolvedValueOnce({ data: { data: { audio: 'fffb' }, base_resp: { status_code: 0 } } });
        const audio = await svc.generateSpeech('hello', 'Friendly_Person');
        expect(mockAxios.mock.calls[0][0].data.stream).toBe(false);
        expect(audio.kind).toBe('buffer');
    });

    test('falls back to Wavespeed when the stream carries an API error', async () => {
        mockAxios
            .mockResolvedValueOnce({ data: streamOf([sse([{ base_resp: { status_code: 1039, status_msg: 'TPM limit' } }])]) })
            .mockResolvedValueOnce({ data: { data: { status: 'completed', outputs: ['https://cdn.example/a.mp3'] } } });

        const audio = await ttsService.generateSpeech('hello', 'Friendly_Person');

        expect(mockAxios).toHaveBeenCalledTimes(2);
        expect(mockAxios.mock.calls[1][0].url).toBe('https://ws.test/speech');
        expect(audio).toEqual({ kind: 'url', url: 'https://cdn.example/a.mp3' });
    });

    test('aborting mid-stream rejects with AbortError and does not trip the breaker', async () => {
        const controller = new AbortController();
        mockAxios.mockResolvedValueOnce({ data: streamOf([sse([chunkEvent('ff')])], { end: false }) });
        const onChunk = jest.fn(() => controller.abort());

        const err = await ttsService.generateSpeech('hello', 'Friendly_Person', { onChunk, signal: controller.signal }).catch(e => e);

        expect(err.name).toBe('AbortError');
        expect(mockAxios).toHaveBeenCalledTimes(1); // no Wavespeed fallback for an abort
    });
});
