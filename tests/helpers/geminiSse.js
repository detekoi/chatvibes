// tests/helpers/geminiSse.js
// Builders for a Gemini TTS response as ttsService.js reads it: server-sent events
// whose audio deltas carry base64 PCM, delivered as an async iterable of byte chunks.

/** 16-bit little-endian mono PCM holding these samples. */
export function pcmOf(...samples) {
    const buf = Buffer.alloc(samples.length * 2);
    samples.forEach((sample, i) => buf.writeInt16LE(sample, i * 2));
    return buf;
}

/** The samples in a PCM buffer. */
export function samplesOf(pcm) {
    const out = [];
    for (let i = 0; i + 1 < pcm.length; i += 2) out.push(pcm.readInt16LE(i));
    return out;
}

/** One `step.delta` audio event. */
export function audioEvent(pcm, extra = {}) {
    return { event_type: 'step.delta', delta: { type: 'audio', data: Buffer.from(pcm).toString('base64'), ...extra } };
}

/** The wire text of events. A string is sent as the raw payload of a `data:` line. */
export function sse(...events) {
    return events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('');
}

/** A response body: an async iterable that yields each part as bytes. */
export async function* bodyOf(...parts) {
    for (const part of parts) yield Buffer.from(part);
}

/** A successful fetch response that streams these parts. */
export function okResponse(...parts) {
    return { ok: true, status: 200, text: async () => '', body: bodyOf(...parts) };
}

/** A failed fetch response. An object payload is sent as JSON. */
export function errorResponse(status, payload) {
    const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return { ok: false, status, text: async () => raw, body: bodyOf() };
}

/** A fetch that never answers and rejects like the real one when its signal fires. */
export function hangingFetch(_url, { signal } = {}) {
    return new Promise((_resolve, reject) => {
        const fail = () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
        if (signal?.aborted) fail();
        else signal?.addEventListener('abort', fail, { once: true });
    });
}
