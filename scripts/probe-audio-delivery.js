// scripts/probe-audio-delivery.js
// Live check that generateSpeech returns playable audio from the real provider.
// Unit tests mock fetch, so nothing else verifies that our request body is one the
// Gemini API accepts, or that what comes back is the PCM the player expects.
//
// Usage:  node --env-file=.env scripts/probe-audio-delivery.js [outdir]
//         Writes each clip as a WAV file so that it can be played back by ear.

import fs from 'fs';
import path from 'path';
import config from '../src/config/index.js';
import { generateSpeech, TtsBlockedError } from '../src/components/tts/ttsService.js';
import { buildStyle } from '../src/components/tts/styleBuilder.js';

const OUT_DIR = path.resolve(process.argv[2] || 'build/audio-probe');

const CASES = [
    { name: 'tiny', text: 'lol' },
    { name: 'short', text: 'hey chat how is everyone doing today' },
    { name: 'styled', text: 'hey chat how is everyone doing today', options: { style: buildStyle({ emotion: 'happy', speed: 1.5 }), language: 'en', volume: 0.5 } },
    { name: 'long', text: 'Okay so I was watching the stream yesterday and I have to say that boss fight was the best thing I have seen all year. You dodged every single attack in the second phase, then you forgot to heal and died with the boss at one percent health. I laughed so hard my cat ran out of the room. Anyway, are you going to try the no hit run again tonight, or are we finally moving on to the DLC?' },
];

let failures = 0;
function check(label, condition, detail) {
    if (condition) {
        console.log(`  ok   ${label}${detail ? ` (${detail})` : ''}`);
    } else {
        console.error(`  FAIL ${label}${detail ? ` (${detail})` : ''}`);
        failures++;
    }
}

async function run(name, text, options = {}) {
    const started = Date.now();
    let firstSliceMs = null;
    let sliceBytes = 0;
    let oddSlice = false;
    const audio = await generateSpeech(text, 'puck', {
        ...options,
        onChunk: slice => {
            firstSliceMs ??= Date.now() - started;
            sliceBytes += slice.length;
            if (slice.length % 2) oddSlice = true;
        },
    });
    const totalMs = Date.now() - started;
    fs.writeFileSync(path.join(OUT_DIR, `${name}.wav`), audio.data);
    console.log(`${name}: ${text.length} chars, first slice ${firstSliceMs} ms, complete ${totalMs} ms, ${audio.audioSeconds} s of audio, model ${audio.model}`);
    check('the clip is a WAV file', audio.data.subarray(0, 4).toString() === 'RIFF' && audio.mime === 'audio/wav');
    check('the slices add up to the clip', sliceBytes === audio.data.length - 44, `${sliceBytes} bytes`);
    check('every slice holds whole samples', !oddSlice);
    check('the first slice came before the clip was complete', firstSliceMs !== null && firstSliceMs <= totalMs);
    return audio;
}

async function main() {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const { name, text, options } of CASES) await run(name, text, options);

    console.log('fallback model: the main model name is made invalid for one request');
    const realModel = config.tts.geminiModel;
    config.tts.geminiModel = 'no-such-tts-model';
    try {
        const audio = await run('fallback', 'This clip comes from the fallback model.');
        check('the fallback model answered', audio.usedFallbackModel === true, audio.model);
    } finally {
        config.tts.geminiModel = realModel;
    }

    console.log('refusal: text that the content filter blocks');
    try {
        await generateSpeech('I am twelve years old and I think you are sexy.', 'puck');
        check('the request was refused', false, 'audio came back');
    } catch (err) {
        check('the request was refused with TtsBlockedError', err instanceof TtsBlockedError, err.message.slice(0, 80));
    }

    console.log(failures ? `\n${failures} checks failed.` : `\nAll checks passed. Clips are in ${OUT_DIR}`);
    process.exit(failures ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
