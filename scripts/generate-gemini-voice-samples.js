// scripts/generate-gemini-voice-samples.js
// Renders one short sample for every voice in gemini-voices.json.
// A voice that already has a file is skipped, so the script can be run again after a failure.
//
// Two sets exist:
//   default    Every voice says the English sentence. This set fed the voice mapping
//              (build/voice-map/gemini), where every clip had to say the same words.
//   --native   Every voice says the sentence in its own language, from
//              scripts/voice-sample-phrases.json. This set is for the dashboard. An English
//              voice says the same English sentence, so its clip is copied from the
//              default set when it exists there, and not rendered a second time.
//
//   --mp3=<dir>  After the render, encode every clip of the set to MP3 in that folder
//              (needs ffmpeg). The dashboard serves its samples from
//              ../chatvibes-web-ui/public/assets/voices/gemini/<voiceId>.mp3.
//
// Usage:  node --env-file=.env scripts/generate-gemini-voice-samples.js [outdir] [--native] [--mp3=<dir>] [--limit=N]
// The dashboard set:
//   node --env-file=.env scripts/generate-gemini-voice-samples.js --native --mp3=../chatvibes-web-ui/public/assets/voices/gemini

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const NATIVE = args.includes('--native');
const ENGLISH_DIR = path.resolve('build/voice-map/gemini');
const OUT_DIR = path.resolve(args.find(a => !a.startsWith('--')) || (NATIVE ? 'build/voice-samples' : 'build/voice-map/gemini'));
const LIMIT = Number(args.find(a => a.startsWith('--limit='))?.slice(8)) || Infinity;
const MP3_DIR = args.find(a => a.startsWith('--mp3='))?.slice(6);
const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-lite-tts';
const PHRASES = JSON.parse(fs.readFileSync(path.join(HERE, 'voice-sample-phrases.json'), 'utf8'));
const ENGLISH = PHRASES.en.text;

/** The sentence and the language hint for one voice. */
function phraseFor(voice) {
    const language = voice.language || 'en-US';
    if (!NATIVE || language.startsWith('en')) return { text: ENGLISH, language: null, english: true };
    const entry = PHRASES[language];
    if (!entry) throw new Error(`voice-sample-phrases.json has no sentence for ${language}`);
    return { text: entry.text, language, english: false };
}
const CONCURRENCY = 6;

const { voices } = JSON.parse(fs.readFileSync(path.join(HERE, '../src/components/tts/gemini-voices.json'), 'utf8'));

async function render(voice, text, language) {
    for (let attempt = 1; attempt <= 4; attempt++) {
        const res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
            method: 'POST',
            headers: { 'x-goog-api-key': KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: MODEL,
                input: [{ type: 'user_input', content: [{ type: 'text', text }] }],
                response_format: { type: 'audio' },
                generation_config: { speech_config: [language ? { voice, language } : { voice }] },
                store: false,
            }),
            signal: AbortSignal.timeout(60000),
        }).catch(err => ({ ok: false, status: 0, text: async () => err.message, headers: new Headers() }));
        if (res.ok) {
            const body = await res.json();
            const audio = (body.steps || []).filter(s => s.type === 'model_output')
                .flatMap(s => s.content || []).find(c => c.type === 'audio');
            if (audio?.data) return Buffer.from(audio.data, 'base64');
            throw new Error(`no audio: ${JSON.stringify(body).slice(0, 200)}`);
        }
        const detail = (await res.text()).replace(/\s+/g, ' ').slice(0, 200);
        // Retry a rate limit or a server error, and give up on anything else.
        if (res.status !== 429 && res.status !== 0 && res.status < 500) throw new Error(`${res.status} ${detail}`);
        const waitSec = Number(res.headers.get('retry-after')) || attempt * 5;
        await new Promise(resolve => setTimeout(resolve, waitSec * 1000));
    }
    throw new Error('still failing after 4 attempts');
}

async function main() {
    if (!KEY) throw new Error('GEMINI_API_KEY is missing');
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const pending = voices.filter(v => !fs.existsSync(path.join(OUT_DIR, `${v.id}.wav`)));
    const todo = pending.slice(0, LIMIT);
    console.log(`${voices.length} voices, ${voices.length - pending.length} already done, ${todo.length} to render now.`);

    let done = 0;
    let copied = 0;
    const failures = [];
    const worker = async () => {
        for (let voice = todo.shift(); voice; voice = todo.shift()) {
            try {
                const { text, language, english } = phraseFor(voice);
                const reusable = path.join(ENGLISH_DIR, `${voice.id}.wav`);
                if (NATIVE && english && fs.existsSync(reusable)) {
                    fs.copyFileSync(reusable, path.join(OUT_DIR, `${voice.id}.wav`));
                    copied++;
                } else {
                    fs.writeFileSync(path.join(OUT_DIR, `${voice.id}.wav`), await render(voice.id, text, language));
                }
            } catch (err) {
                failures.push({ id: voice.id, error: err.message });
                console.error(`  FAIL ${voice.id}: ${err.message}`);
            }
            if (++done % 100 === 0) console.log(`  ${done} done`);
        }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    console.log(`Finished. ${failures.length} failures. ${copied} English clips were copied and not rendered again.`);
    if (failures.length) {
        fs.writeFileSync(path.join(OUT_DIR, '_failures.json'), JSON.stringify(failures, null, 2));
        process.exitCode = 1;
    }

    if (MP3_DIR) {
        const target = path.resolve(MP3_DIR);
        fs.mkdirSync(target, { recursive: true });
        let encoded = 0;
        for (const voice of voices) {
            const wav = path.join(OUT_DIR, `${voice.id}.wav`);
            if (!fs.existsSync(wav)) continue;
            execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', wav, '-ac', '1', '-ar', '24000', '-b:a', '48k', path.join(target, `${voice.id}.mp3`)]);
            encoded++;
        }
        console.log(`Encoded ${encoded} clips to ${target}`);
    }
}

main().catch(err => { console.error(err.message); process.exit(1); });
