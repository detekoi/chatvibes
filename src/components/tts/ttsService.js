// src/components/tts/ttsService.js
// Speech synthesis through Gemini TTS (the Interactions API, streamed).
//
// The provider takes a voice, the text and one free-text style. It has no speed, pitch,
// emotion or volume numbers: styleBuilder.js turns the stored settings into the style,
// and the volume is applied to the samples here. Audio comes back as raw 16-bit mono
// PCM, slice by slice. See docs/audio-delivery.md.
import logger from '../../lib/logger.js';
import config from '../../config/index.js';
import { getVoiceCatalog, resolveVoice } from './voiceResolver.js';

const DEFAULT_SAMPLE_RATE = 24000;

// Measured against the live API on 2026-11-13 (us-west client): the first slice lands
// after 0.3-0.7 s, whatever the length of the text, and slices then arrive faster than
// they play. A request that has sent nothing after FIRST_CHUNK_TIMEOUT_MS is not coming.
const FIRST_CHUNK_TIMEOUT_MS = 4000;
// The longest silence allowed between two slices of a clip that has started.
const IDLE_TIMEOUT_MS = 4000;

/** The request was refused by the provider's content filter. A retry cannot help. */
export class TtsBlockedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'TtsBlockedError';
    }
}

/** A 44-byte RIFF header in front of 16-bit mono PCM. */
export function wavFromPcm(pcm, sampleRate = DEFAULT_SAMPLE_RATE) {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);  // PCM
    header.writeUInt16LE(1, 22);  // mono
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
}

/**
 * Multiply 16-bit samples by a volume, in place, and clip at full scale.
 * Gemini has no volume field, so the channel's volume is applied here.
 */
export function applyGain(pcm, volume) {
    if (!(volume > 0) || volume === 1) return pcm;
    for (let i = 0; i + 1 < pcm.length; i += 2) {
        const sample = Math.round(pcm.readInt16LE(i) * volume);
        pcm.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i);
    }
    return pcm;
}

/**
 * Cuts a byte stream into slices that always hold whole 16-bit samples. A network
 * chunk can end in the middle of a sample, and a player that gets half of one plays
 * noise from there on.
 */
export function createSampleAligner() {
    let carry = null;
    return {
        push(buf) {
            const joined = carry ? Buffer.concat([carry, buf]) : buf;
            const even = joined.length - (joined.length % 2);
            carry = even < joined.length ? joined.subarray(even) : null;
            return joined.subarray(0, even);
        },
    };
}

/**
 * Read the audio of one Gemini TTS response.
 *
 * The body is server-sent events. A `step.delta` event with an audio delta carries a
 * base64 slice of PCM. An `error` event, or a stream that closes with no audio, fails
 * the clip. Each slice is passed on with whole samples and the volume applied.
 *
 * @param {ReadableStream} body
 * @param {{ onSlice: (buf: Buffer) => void, onActivity: () => void, volume?: number }} hooks
 * @returns {Promise<{ pcm: Buffer, sampleRate: number, usage: object|null }>}
 */
export async function readGeminiAudio(body, { onSlice, onActivity, volume = 1 }) {
    const decoder = new TextDecoder();
    const aligner = createSampleAligner();
    const slices = [];
    let buffered = '';
    let sampleRate = DEFAULT_SAMPLE_RATE;
    let usage = null;

    const handle = event => {
        if (event.error) {
            const detail = event.error.message || JSON.stringify(event.error);
            if (isBlocked(event.error.code, detail)) throw new TtsBlockedError(`Gemini TTS blocked the text: ${detail}`);
            throw new Error(`Gemini TTS stream error: ${detail}`);
        }
        if (event.interaction?.usage) usage = event.interaction.usage;
        const delta = event.delta;
        if (delta?.type !== 'audio' || !delta.data) return;
        if (delta.sample_rate && delta.sample_rate !== sampleRate) {
            // The player is told 24 kHz when the clip starts (openClipStream). The
            // request does not ask for another rate, so this is a change at the provider.
            logger.warn({ sampleRate: delta.sample_rate }, 'Gemini TTS sent an unexpected sample rate; streamed playback will be at the wrong speed');
            sampleRate = delta.sample_rate;
        }
        const slice = aligner.push(Buffer.from(delta.data, 'base64'));
        if (slice.length === 0) return;
        // A copy: applyGain writes in place, and the slice can share memory with the carry.
        const out = applyGain(Buffer.from(slice), volume);
        slices.push(out);
        onSlice(out);
    };

    for await (const chunk of body) {
        onActivity();
        buffered += decoder.decode(chunk, { stream: true });
        let newline;
        while ((newline = buffered.indexOf('\n')) >= 0) {
            const line = buffered.slice(0, newline).trim();
            buffered = buffered.slice(newline + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue; // the closing line of the stream
            let event;
            try {
                event = JSON.parse(payload);
            } catch {
                logger.warn({ raw: line.substring(0, 120) }, 'Gemini TTS stream carried an unparseable event; skipping it');
                continue;
            }
            handle(event);
        }
    }

    if (slices.length === 0) throw new Error('Gemini TTS returned no audio (empty stream)');
    return { pcm: Buffer.concat(slices), sampleRate, usage };
}

function isBlocked(code, message) {
    return code === 'prohibited_content' || /\b(input|output|response|request) (was )?blocked\b/i.test(message || '');
}

/**
 * One request to one model. Rejects with TtsBlockedError for a refusal, with an
 * AbortError when the caller's signal fired, and with a plain Error for anything else.
 */
async function attemptGeneration(model, text, voice, { style, language, volume, signal, onSlice, serviceTier }) {
    const content = { type: 'text', text };
    if (style) content.annotations = [{ type: 'speech_metadata', style }];
    const speech = { voice };
    if (language) speech.language = language;

    // One controller for the caller's stop and for our own timeouts.
    const controller = new AbortController();
    let timedOut = null;
    const onCallerAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', onCallerAbort, { once: true });

    let timer = null;
    const arm = (ms, reason) => {
        clearTimeout(timer);
        timer = setTimeout(() => { timedOut = reason; controller.abort(); }, ms);
    };
    arm(FIRST_CHUNK_TIMEOUT_MS, 'no audio before the first-chunk timeout');

    try {
        const res = await fetch(config.tts.geminiEndpoint, {
            method: 'POST',
            headers: { 'x-goog-api-key': config.tts.geminiApiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                input: [{ type: 'user_input', content: [content] }],
                response_format: { type: 'audio' },
                generation_config: { speech_config: [speech] },
                stream: true,
                // Interactions are stored for weeks unless this is off. Chat text is not ours to keep there.
                store: false,
                // Only a clip that can wait asks for the cheaper tier. No field means standard.
                ...(serviceTier ? { service_tier: serviceTier } : {}),
            }),
            signal: controller.signal,
        });

        if (!res.ok) {
            const raw = await res.text();
            let code, message = raw.replace(/\s+/g, ' ').slice(0, 300);
            try {
                const parsed = JSON.parse(raw);
                code = parsed.error?.code;
                message = parsed.error?.message || message;
            } catch { /* not JSON, keep the text */ }
            if (isBlocked(code, message)) throw new TtsBlockedError(`Gemini TTS blocked the text: ${message}`);
            const err = new Error(`Gemini TTS HTTP ${res.status}: ${message}`);
            err.status = res.status;
            throw err;
        }

        return await readGeminiAudio(res.body, {
            volume,
            onSlice,
            onActivity: () => arm(IDLE_TIMEOUT_MS, 'the stream went silent'),
        });
    } catch (err) {
        if (timedOut) throw new Error(`Gemini TTS request timed out (${timedOut})`);
        throw err;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onCallerAbort);
    }
}

/**
 * Generate speech audio.
 *
 * @param {string} text
 * @param {string} [voiceId] A Gemini voice ID. A stored MiniMax ID is mapped.
 * @param {object} [options]
 * @param {string} [options.style] The finished style text from styleBuilder.buildStyle
 * @param {string} [options.language] A BCP-47 hint for short or ambiguous text
 * @param {number} [options.volume] Gain applied to the samples, 1 = unchanged
 * @param {AbortSignal} [options.signal]
 * @param {'flex'} [options.serviceTier] 'flex' sends the first attempt on the flex tier,
 *   which costs half and can be slow. It is for a clip that already waited (a spotlight
 *   pick). The later attempts use the standard tier, so a slow flex answer costs one
 *   first-chunk timeout at most.
 * @param {(slice: Buffer) => void} [options.onChunk] Called with each PCM slice (whole
 *   16-bit samples, volume applied), in order, as the provider renders it. After a
 *   slice has gone out the request is not retried, so slices never repeat.
 * @returns {Promise<{kind: 'buffer', data: Buffer, mime: 'audio/wav', sampleRate: number,
 *   audioSeconds: number, model: string, serviceTier: string, usedFallbackModel: boolean}>}
 *   `data` is the whole clip as a WAV file.
 */
export async function generateSpeech(text, voiceId, options = {}) {
    if (!config.tts.geminiApiKey) throw new Error('GEMINI_API_KEY is missing');

    const { voice } = resolveVoice(voiceId);
    const { style, language, volume = 1, signal, onChunk, serviceTier } = options;
    const primary = config.tts.geminiModel;
    const fallback = config.tts.geminiFallbackModel;
    // The main model twice, then the larger model once. It shares the API, the voices
    // and the style format, so it covers an outage of one model with no mapping.
    // With serviceTier 'flex' the first of those attempts goes to the flex tier.
    const attempts = [primary, primary, ...(fallback && fallback !== primary ? [fallback] : [])]
        .map((model, i) => ({ model, tier: i === 0 && serviceTier === 'flex' ? 'flex' : null }));

    const startTime = Date.now();
    let slicesSent = 0;
    let lastError = null;

    for (let i = 0; i < attempts.length; i++) {
        const { model, tier } = attempts[i];
        try {
            const { pcm, sampleRate, usage } = await attemptGeneration(model, text, voice, {
                style, language, volume, signal, serviceTier: tier,
                onSlice: slice => { slicesSent++; onChunk?.(slice); },
            });
            const audioSeconds = +(pcm.length / 2 / sampleRate).toFixed(2);
            logger.info({
                logKey: 'GEMINI_TTS_OK', model, voice, tier: tier || 'standard', attempt: i + 1, bytes: pcm.length, audioSeconds,
                durationMs: Date.now() - startTime, inputTokens: usage?.total_input_tokens,
            }, 'TTS audio generated successfully via Gemini');
            return {
                kind: 'buffer',
                data: wavFromPcm(pcm, sampleRate),
                mime: 'audio/wav',
                sampleRate,
                audioSeconds,
                model,
                serviceTier: tier || 'standard',
                usedFallbackModel: model !== primary,
            };
        } catch (err) {
            if (signal?.aborted) {
                const abort = new Error('Speech generation was aborted');
                abort.name = 'AbortError';
                throw abort;
            }
            lastError = err;
            const blocked = err instanceof TtsBlockedError;
            logger[blocked ? 'info' : 'warn']({
                logKey: blocked ? 'GEMINI_TTS_BLOCKED' : 'GEMINI_TTS_ERROR',
                model, voice, tier: tier || 'standard', attempt: i + 1, status: err.status, durationMs: Date.now() - startTime,
            }, err.message);
            // A refusal stays a refusal. And once a slice reached a player, a second
            // request would repeat the start of the clip.
            if (blocked || slicesSent > 0) break;
        }
    }
    throw lastError;
}

/**
 * Every voice a user can choose, from the synced catalog.
 * @returns {Promise<Array<{id: string, name: string, language: string|null, gender: string|null, pitch: string|null, description: string}>>}
 */
export async function getAvailableVoices() {
    return getVoiceCatalog();
}
