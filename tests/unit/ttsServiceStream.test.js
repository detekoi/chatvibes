// tests/unit/ttsServiceStream.test.js
// The audio side of the Gemini provider: reading the event stream, keeping slices on
// whole samples, the volume gain, and the WAV file built from the PCM.

import { jest } from '@jest/globals';
import { pcmOf, samplesOf, audioEvent, sse, bodyOf } from '../helpers/geminiSse.js';

const mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.unstable_mockModule('../../src/lib/logger.js', () => ({ default: mockLogger }));

const { readGeminiAudio, wavFromPcm, applyGain, createSampleAligner, TtsBlockedError } =
    await import('../../src/components/tts/ttsService.js');

beforeEach(() => {
    jest.clearAllMocks();
});

/** Run readGeminiAudio over these body parts and collect what the hooks saw. */
async function read(parts, { volume } = {}) {
    const slices = [];
    const onActivity = jest.fn();
    const result = await readGeminiAudio(bodyOf(...parts), { onSlice: slice => slices.push(slice), onActivity, volume });
    return { ...result, slices, onActivity };
}

describe('readGeminiAudio', () => {
    test('decodes audio deltas, hands them on in order and resolves with their concatenation', async () => {
        const a = pcmOf(1, 2);
        const b = pcmOf(3);

        const { pcm, slices, sampleRate, usage } = await read([sse(audioEvent(a)), sse(audioEvent(b))]);

        expect(slices).toEqual([a, b]);
        expect(pcm).toEqual(Buffer.concat([a, b]));
        expect(sampleRate).toBe(24000);
        expect(usage).toBeNull();
    });

    test('reassembles an event split across two reads', async () => {
        const wire = sse(audioEvent(pcmOf(7, 8, 9)));
        const cut = Math.floor(wire.length / 2);

        const { pcm } = await read([wire.slice(0, cut), wire.slice(cut)]);

        expect(samplesOf(pcm)).toEqual([7, 8, 9]);
    });

    test('reports activity once per network chunk', async () => {
        const { onActivity } = await read([sse(audioEvent(pcmOf(1))), sse(audioEvent(pcmOf(2))), sse('[DONE]')]);

        expect(onActivity).toHaveBeenCalledTimes(3);
    });

    test('ignores the closing [DONE] line', async () => {
        const { pcm } = await read([sse(audioEvent(pcmOf(5)), '[DONE]')]);

        expect(samplesOf(pcm)).toEqual([5]);
        expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    test('skips an unparseable line and keeps reading', async () => {
        const { pcm } = await read([sse(audioEvent(pcmOf(1)), '{not json', audioEvent(pcmOf(2)))]);

        expect(samplesOf(pcm)).toEqual([1, 2]);
        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    });

    test('ignores lines that are not data, and deltas that are not audio', async () => {
        const wire = 'event: step.delta\n: a comment\n'
            + sse({ event_type: 'step.delta', delta: { type: 'text', text: 'hi' } }, audioEvent(pcmOf(4)));

        const { slices } = await read([wire]);

        expect(slices).toEqual([pcmOf(4)]);
    });

    test('picks up the sample rate named on a delta, and warns that it is not the expected one', async () => {
        const { sampleRate } = await read([sse(audioEvent(pcmOf(1), { sample_rate: 48000 }), audioEvent(pcmOf(2), { sample_rate: 48000 }))]);

        expect(sampleRate).toBe(48000);
        // Once for the change, not once per slice.
        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        expect(mockLogger.warn).toHaveBeenCalledWith({ sampleRate: 48000 }, expect.stringMatching(/unexpected sample rate/));
    });

    test('does not warn for a delta that names the expected 24 kHz, or no rate', async () => {
        const { sampleRate } = await read([sse(audioEvent(pcmOf(1), { sample_rate: 24000 }), audioEvent(pcmOf(2)))]);

        expect(sampleRate).toBe(24000);
        expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    test('warns again when the rate changes in the middle of a stream', async () => {
        const { sampleRate } = await read([sse(audioEvent(pcmOf(1), { sample_rate: 48000 }), audioEvent(pcmOf(2), { sample_rate: 16000 }))]);

        expect(sampleRate).toBe(16000);
        expect(mockLogger.warn).toHaveBeenCalledTimes(2);
    });

    test('returns the usage carried by the interaction event', async () => {
        const usage = { total_input_tokens: 12 };

        const result = await read([sse(audioEvent(pcmOf(1)), { event_type: 'interaction.complete', interaction: { usage } })]);

        expect(result.usage).toEqual(usage);
    });

    test('throws on an error event', async () => {
        const wire = sse(audioEvent(pcmOf(1)), { error: { code: 'internal', message: 'model overloaded' } });

        await expect(read([wire])).rejects.toThrow('Gemini TTS stream error: model overloaded');
    });

    test('throws TtsBlockedError on an error event that is a refusal', async () => {
        const byCode = sse({ error: { code: 'prohibited_content', message: 'no' } });
        const byMessage = sse({ error: { message: 'Output blocked by the safety filter' } });

        await expect(read([byCode])).rejects.toBeInstanceOf(TtsBlockedError);
        await expect(read([byMessage])).rejects.toBeInstanceOf(TtsBlockedError);
    });

    test('throws on a stream that carried no audio', async () => {
        await expect(read([])).rejects.toThrow('no audio');
        await expect(read([sse('[DONE]')])).rejects.toThrow('no audio');
    });

    describe('sample alignment', () => {
        test('moves the odd byte of a slice to the front of the next one', async () => {
            const whole = pcmOf(100, -200, 300, -400);
            // 3 bytes, then 5: both deltas end in the middle of a sample.
            const wire = sse(audioEvent(whole.subarray(0, 3)), audioEvent(whole.subarray(3)));

            const { slices, pcm } = await read([wire]);

            expect(slices.map(slice => slice.length)).toEqual([2, 6]);
            expect(samplesOf(pcm)).toEqual([100, -200, 300, -400]);
        });

        test('sends nothing for a delta that holds less than one sample', async () => {
            const whole = pcmOf(1234, 5678);
            const wire = sse(audioEvent(whole.subarray(0, 1)), audioEvent(whole.subarray(1)));

            const { slices } = await read([wire]);

            expect(slices).toEqual([whole]);
        });

        test('applies the gain to a sample that was split across two deltas', async () => {
            const whole = pcmOf(1000, 2000);
            const wire = sse(audioEvent(whole.subarray(0, 3)), audioEvent(whole.subarray(3)));

            const { pcm } = await read([wire], { volume: 0.5 });

            expect(samplesOf(pcm)).toEqual([500, 1000]);
        });
    });

    test('applies the volume to every slice', async () => {
        const { slices, pcm } = await read([sse(audioEvent(pcmOf(100, -100)), audioEvent(pcmOf(20000)))], { volume: 2 });

        expect(slices.map(samplesOf)).toEqual([[200, -200], [32767]]);
        expect(samplesOf(pcm)).toEqual([200, -200, 32767]);
    });
});

describe('createSampleAligner', () => {
    test('passes even-length input through unchanged', () => {
        const aligner = createSampleAligner();

        expect(aligner.push(Buffer.from([1, 2, 3, 4]))).toEqual(Buffer.from([1, 2, 3, 4]));
        expect(aligner.push(Buffer.from([5, 6]))).toEqual(Buffer.from([5, 6]));
    });

    test('carries an odd byte over as many pushes as it takes', () => {
        const aligner = createSampleAligner();

        expect(aligner.push(Buffer.from([1]))).toHaveLength(0);
        expect(aligner.push(Buffer.from([2, 3]))).toEqual(Buffer.from([1, 2]));
        expect(aligner.push(Buffer.from([4, 5, 6]))).toEqual(Buffer.from([3, 4, 5, 6]));
    });
});

describe('applyGain', () => {
    test('scales the samples in place', () => {
        const pcm = pcmOf(100, -100, 3);

        expect(applyGain(pcm, 0.5)).toBe(pcm);
        expect(samplesOf(pcm)).toEqual([50, -50, 2]);
    });

    test('clips at full scale in both directions', () => {
        expect(samplesOf(applyGain(pcmOf(20000, -20000, 32767, -32768), 2))).toEqual([32767, -32768, 32767, -32768]);
    });

    test.each([1, 0, -1, undefined, NaN])('leaves the samples alone for a volume of %p', volume => {
        expect(samplesOf(applyGain(pcmOf(100, -100), volume))).toEqual([100, -100]);
    });
});

describe('wavFromPcm', () => {
    test('writes a 44-byte header for 16-bit mono PCM in front of the samples', () => {
        const pcm = pcmOf(1, 2, 3);

        const wav = wavFromPcm(pcm, 24000);

        expect(wav).toHaveLength(44 + pcm.length);
        expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
        expect(wav.readUInt32LE(4)).toBe(36 + pcm.length);  // file size minus the first 8 bytes
        expect(wav.toString('ascii', 8, 16)).toBe('WAVEfmt ');
        expect(wav.readUInt32LE(16)).toBe(16);              // size of the fmt chunk
        expect(wav.readUInt16LE(20)).toBe(1);               // PCM
        expect(wav.readUInt16LE(22)).toBe(1);               // channels
        expect(wav.readUInt32LE(24)).toBe(24000);           // sample rate
        expect(wav.readUInt32LE(28)).toBe(48000);           // bytes per second
        expect(wav.readUInt16LE(32)).toBe(2);               // bytes per sample frame
        expect(wav.readUInt16LE(34)).toBe(16);              // bits per sample
        expect(wav.toString('ascii', 36, 40)).toBe('data');
        expect(wav.readUInt32LE(40)).toBe(pcm.length);
        expect(wav.subarray(44)).toEqual(pcm);
    });

    test('uses the sample rate it is given, and 24 kHz without one', () => {
        expect(wavFromPcm(pcmOf(1), 48000).readUInt32LE(24)).toBe(48000);
        expect(wavFromPcm(pcmOf(1), 48000).readUInt32LE(28)).toBe(96000);
        expect(wavFromPcm(pcmOf(1)).readUInt32LE(24)).toBe(24000);
    });
});
