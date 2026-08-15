// scripts/probe-audio-delivery.js
// Live check that generateSpeech returns playable audio from the real providers.
// Unit tests mock axios, so nothing else verifies that our request body is one the
// MiniMax API actually accepts, or that what comes back decodes as MP3.
//
// Follows the precedent of scripts/probe-pronunciation.js — see
// docs/pronunciation-probe-results.md.
//
// Usage:  node --env-file=.env scripts/probe-audio-delivery.js [outdir]
//         Writes the decoded clips so they can be played back by ear.

import fs from 'fs';
import path from 'path';
import config from '../src/config/index.js';
import { generateSpeech } from '../src/components/tts/ttsService.js';

const OUT_DIR = process.argv[2] || '/tmp/tts-probe';

// The two MP3 signatures observed from this API: an ID3v2 tag, or a bare frame sync.
function looksLikeMp3(buf) {
    if (buf.length < 3) return false;
    if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true; // "ID3"
    return buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;                     // frame sync
}

const CASES = [
    { name: 'tiny', text: 'lol' },
    { name: 'short', text: 'hey chat how is everyone doing today' },
    { name: 'max', text: ('okay so anyway that is basically what happened last night and honestly ').repeat(8).slice(0, 500) },
];

let failures = 0;

function check(label, condition, detail) {
    if (condition) {
        console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`);
    } else {
        console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
        failures++;
    }
}

async function main() {
    fs.mkdirSync(OUT_DIR, { recursive: true });

    console.log('302.ai — inline bytes (the default path)');
    for (const { name, text } of CASES) {
        const started = Date.now();
        const audio = await generateSpeech(text, 'Friendly_Person');
        const ms = Date.now() - started;

        check(`${name}: kind is 'buffer'`, audio.kind === 'buffer', `got '${audio.kind}'`);
        if (audio.kind !== 'buffer') continue;

        check(`${name}: decodes as MP3`, looksLikeMp3(audio.data),
            `${audio.data.length} bytes, head ${audio.data.subarray(0, 3).toString('hex')}`);
        check(`${name}: mime is audio/mpeg`, audio.mime === 'audio/mpeg', audio.mime);

        const file = path.join(OUT_DIR, `302-${name}.mp3`);
        fs.writeFileSync(file, audio.data);
        console.log(`       ${ms}ms, ${audio.data.length} bytes -> ${file}`);
    }

    console.log('\n302.ai — URL output (the outdated-player fallback)');
    const urlAudio = await generateSpeech('checking the url path', 'Friendly_Person', { preferUrlOutput: true });
    check("kind is 'url'", urlAudio.kind === 'url', `got '${urlAudio.kind}'`);
    check('url is fetchable http(s)', /^https?:\/\//.test(urlAudio.url || ''), urlAudio.url);

    console.log('\nWavespeed — fallback provider, always a URL');
    // getProviderForVoice sends every voice to 302, so reach the Wavespeed path the
    // way production does: let the 302 attempt fail and take the retry. The env var
    // is read into config at module load, so blanking it here would be too late —
    // attemptGeneration302 re-reads config.tts.t302ApiKey on every call, so mutate that.
    const realKey = config.tts.t302ApiKey;
    config.tts.t302ApiKey = '';
    try {
        const ws = await generateSpeech('checking the wavespeed fallback', 'Friendly_Person');
        check("kind is 'url'", ws.kind === 'url', `got '${ws.kind}'`);
        check('url is fetchable http(s)', /^https?:\/\//.test(ws.url || ''), ws.url);
    } catch (err) {
        check('wavespeed fallback reachable', false, err.message);
    } finally {
        config.tts.t302ApiKey = realKey;
    }

    console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('Probe failed:', err);
    process.exit(1);
});
