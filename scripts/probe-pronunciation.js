#!/usr/bin/env node
// Empirical probe for MiniMax pronunciation behaviour, run by hand before the
// built-in pronunciation dictionary is finalised.
//
// Two things need answering and neither is documented:
//
//   1. Which Twitch acronyms does speech-2.8-turbo already say correctly? Only
//      the ones it mangles belong in PRONUNCIATION_DEFAULTS — every entry we
//      add is a chance to break something that already worked.
//   2. How does the API's own pronunciation_dict match? MiniMax's docs warn
//      that "read/(riːd)" would "force one pronunciation everywhere", which
//      reads like naive substring matching. If so, the API dictionary can
//      corrupt "lol" and we cannot stop it, which is why the shipped feature
//      rewrites text locally instead.
//
// Synthesis goes through 302.ai; the returned mp3 is transcribed by Gemini.
// The transcript alone is not enough — an ASR model will happily normalise
// "el oh el" back to "LOL" and destroy the exact signal we care about — so the
// response schema forces a separate phonetic self-report. Treat that as a
// screening tool: every clip is saved so a human can settle disputed cases.
//
// Hits paid APIs and is non-deterministic. Never wire this into CI.
//
// Usage:
//   node scripts/probe-pronunciation.js                 # everything
//   node scripts/probe-pronunciation.js --only=semantics
//   node scripts/probe-pronunciation.js --only=baseline
//   node scripts/probe-pronunciation.js --out=/tmp/probe --limit=5

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import axios from 'axios';
import { GoogleGenAI } from '@google/genai';
import 'dotenv/config';

const T302_ENDPOINT = process.env.T302_API_ENDPOINT || 'https://api.302.ai/minimaxi/v1/t2a_v2';
const T302_API_KEY = process.env.T302_API_KEY || process.env['302_KEY'];
const WAVESPEED_ENDPOINT = process.env.WAVESPEED_API_ENDPOINT || 'https://api.wavespeed.ai/api/v3/minimax/speech-02-turbo';
const WAVESPEED_API_KEY = process.env.WAVESPEED_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const MODEL = 'speech-2.8-turbo';
const VOICE_ID = 'Friendly_Person';
const TRANSCRIBE_MODEL = 'gemini-flash-latest';

// MiniMax rate-limits (base_resp 1002); space the calls out.
const CALL_DELAY_MS = 300;
const SYNTH_TIMEOUT_MS = 20000;
const TRANSCRIBE_TIMEOUT_MS = 30000;
const MAX_API_FAILURES = 2;

const argOf = (name, fallback) => {
    const hit = process.argv.find(a => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};

const only = argOf('only', 'all');
const outDir = argOf('out', join(process.cwd(), 'probe-output'));
const limit = Number(argOf('limit', '0')) || 0;

// Candidates from the plan. A carrier sentence is used rather than a bare token
// because MiniMax normalises differently mid-sentence than in isolation, and
// mid-sentence is what chat actually looks like.
const CANDIDATES = [
    // Known-good — these must NOT end up in the defaults. Probing them is the
    // point: "lol" reading as "el oh el" is behaviour we are protecting.
    'lol', 'omg', 'lmao', 'rofl', 'brb', 'afk', 'gg', 'fyi', 'asap', 'rip',
    'pog', 'sus', 'goat', 'yolo', 'fomo',
    // Twitch / stream
    'lfg', 'iktr', 'ikdr', 'glhf', 'ggwp', 'ggez', 'wp', 'ez', 'ttv', 'o7',
    'copium', 'omegalul', 'iykyk', 'ngmi', 'wagmi',
    // Chat slang
    'ngl', 'tbh', 'tbf', 'imo', 'imho', 'idk', 'idc', 'ikr', 'iirc', 'icymi',
    'wdym', 'wyd', 'hbu', 'smh', 'nvm', 'istg', 'ong', 'fr', 'frfr', 'rn',
    'mb', 'wb', 'gn', 'gm', 'ty', 'thx', 'yw', 'np', 'btw', 'tldr', 'ama',
    'eli5', 'jk', 'ftw', 'lmk', 'hmu', 'ttyl', 'otw', 'nbd', 'til', 'mfw',
    'tfw', 'uwu', 'owo',
    // Gaming
    '1v1', 'pvp', 'pve', 'aoe', 'dps', 'npc', 'rng', 'mmr', 'kda', 'qol', 'op',
    // Profane — expansions stay literal; the profanity filter cleans them.
    'stfu', 'gtfo', 'ffs', 'omfg', 'wtf', 'af', 'jfc',
];

const carrier = token => `Chat said ${token} right now.`;

// Group A: matching semantics. Each entry ships a pronunciation_dict so we can
// see how the API's own matcher behaves. Run once — the answers do not change.
const SEMANTICS_CASES = [
    {
        id: 'case',
        dict: ['lfg/lets go'],
        text: 'lfg LFG Lfg',
        asks: 'Is matching case sensitive? A lowercase key against three casings.',
    },
    {
        id: 'boundary',
        dict: ['ngl/not gonna lie'],
        text: 'NGL angle ANGLE mingle',
        asks: 'Word boundary or substring? "angle" and "mingle" contain "ngl".',
    },
    {
        id: 'lol-hazard',
        dict: ['ol/oh el'],
        text: 'lol',
        asks: 'Can a substring entry corrupt "lol"? The direct threat model.',
    },
    {
        id: 'punctuation',
        dict: ['lfg/lets go'],
        text: 'LFG! (LFG) LFG. LFG, LFG?',
        asks: 'Does adjacent punctuation block a match?',
    },
    {
        id: 'multiword',
        dict: ["i know that's right/i know thats right"],
        text: "iktr - i know that's right",
        asks: 'Are multi-token keys and apostrophes handled?',
    },
    {
        id: 'ipa',
        dict: ['resume/(rɪˈzjuːm)'],
        text: 'Please resume the stream.',
        asks: 'Does IPA notation work through the 302.ai passthrough?',
    },
    {
        id: 'entry-cap',
        dict: [...Array(100)].map((_, i) => `zzq${i}/filler ${i}`).concat('lfg/lets go'),
        text: 'LFG',
        asks: 'Is there an entry cap? 101 entries; watch for a non-zero base_resp.',
    },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Turn a transcription into a keep/drop call for the built-in dictionary.
 *
 * Three outcomes rather than two, because "said as a single word" is genuinely
 * ambiguous: "lol" as a word is fine, "iktr" as a word is not. Anything in that
 * bucket gets listened to rather than guessed at.
 *
 * @param {object|null} t
 * @returns {'ok'|'needs-entry'|'review'|'?'}
 */
function verdictFor(t) {
    if (!t) return '?';
    if (t.soundsLikeNonsense) return 'needs-entry';
    if (t.letterByLetter) return 'ok';
    // Multi-word means the model expanded it itself — no entry needed.
    if (String(t.spokenForm || '').trim().split(/\s+/).length > 1) return 'ok';
    return 'review';
}

let apiFailures = 0;

/**
 * Synthesize one clip. Mirrors the request body ttsService.js builds so the
 * probe measures the same thing production does.
 * @param {string} text
 * @param {object} [opts]
 * @param {string[]|null} [opts.dict] pronunciation_dict tone entries
 * @param {'302'|'wavespeed'} [opts.provider]
 * @returns {Promise<{url: string|null, statusCode: number, statusMsg: string, durationMs: number}>}
 */
async function synth(text, { dict = null, provider = '302' } = {}) {
    const startedAt = Date.now();

    if (provider === 'wavespeed') {
        // The Wavespeed wrapper takes a flat body, not MiniMax's nested shape.
        const body = {
            text,
            voice_id: VOICE_ID,
            speed: 1.0,
            vol: 1.0,
            pitch: 0,
            emotion: 'neutral',
            language_boost: 'English',
            english_normalization: false,
            sample_rate: 32000,
            bitrate: 128000,
            channel: '1',
            format: 'mp3',
            enable_sync_mode: true,
        };
        if (dict) body.pronunciation_dict = { tone: dict };

        const res = await axios({
            method: 'POST',
            url: WAVESPEED_ENDPOINT,
            headers: { Authorization: `Bearer ${WAVESPEED_API_KEY}`, 'Content-Type': 'application/json' },
            data: body,
            timeout: SYNTH_TIMEOUT_MS,
        });
        const outputs = res.data?.data?.outputs;
        return {
            url: Array.isArray(outputs) ? outputs[0] : null,
            statusCode: 0,
            statusMsg: res.data?.data?.status || 'ok',
            durationMs: Date.now() - startedAt,
        };
    }

    const body = {
        model: MODEL,
        text,
        stream: false,
        voice_setting: {
            voice_id: VOICE_ID,
            speed: 1.0,
            vol: 1.0,
            pitch: 0,
            emotion: 'neutral',
            text_normalization: false,
        },
        audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
        language_boost: 'English',
        output_format: 'url',
    };
    if (dict) body.pronunciation_dict = { tone: dict };

    const res = await axios({
        method: 'POST',
        url: T302_ENDPOINT,
        headers: { Authorization: `Bearer ${T302_API_KEY}`, 'Content-Type': 'application/json' },
        data: body,
        timeout: SYNTH_TIMEOUT_MS,
    });

    // MiniMax reports failures as HTTP 200 with a non-zero base_resp.
    const statusCode = res.data?.base_resp?.status_code ?? 0;
    const statusMsg = res.data?.base_resp?.status_msg || 'ok';
    if (statusCode !== 0) {
        apiFailures++;
        return { url: null, statusCode, statusMsg, durationMs: Date.now() - startedAt };
    }

    const d = res.data?.data;
    const url = d?.audio || res.data?.audio_file || (typeof d === 'string' ? d : null);
    return { url, statusCode, statusMsg, durationMs: Date.now() - startedAt };
}

const genAI = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

const TRANSCRIBE_SYSTEM = `You are a phonetic transcription assistant analysing text-to-speech output.

You are being used to check HOW a TTS engine vocalised an acronym, so a plain transcript is not enough — writing "LOL" when the voice said "el oh el" destroys the only signal that matters. Report what the voice literally produced, never a normalised or tidied form.`;

const TRANSCRIBE_SCHEMA = {
    type: 'object',
    properties: {
        transcript: {
            type: 'string',
            description: 'Verbatim words spoken, in order.',
        },
        spokenForm: {
            type: 'string',
            description: 'How the acronym under test was VOCALISED. Spelled out letter by letter: write the letters separated by periods, e.g. "L. O. L." Said as a single word: write it as a word, e.g. "lol". Expanded into a phrase: write the phrase.',
        },
        letterByLetter: {
            type: 'boolean',
            description: 'True if the acronym was spelled out letter by letter rather than said as a word or expanded.',
        },
        soundsLikeNonsense: {
            type: 'boolean',
            description: 'True if the acronym came out as an unintelligible or nonsense syllable rather than either clear letters or a real word.',
        },
    },
    required: ['transcript', 'spokenForm', 'letterByLetter', 'soundsLikeNonsense'],
};

/**
 * Transcribe an mp3 URL, forcing a phonetic self-report.
 * @param {string} mp3Url
 * @param {string} token The acronym under test, named in the prompt.
 * @returns {Promise<object|null>}
 */
async function transcribe(mp3Url, token) {
    if (!genAI) return null;

    let audioB64;
    try {
        const audio = await axios.get(mp3Url, { responseType: 'arraybuffer', timeout: SYNTH_TIMEOUT_MS });
        audioB64 = Buffer.from(audio.data).toString('base64');
    } catch (error) {
        console.error(`  ! audio fetch failed: ${error.message}`);
        return null;
    }

    // Flash models return 503 UNAVAILABLE under load often enough that a single
    // attempt leaves holes in the result table. Back off and retry rather than
    // silently recording an unknown for a token we paid to synthesize.
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const res = await Promise.race([
                genAI.models.generateContent({
                    model: TRANSCRIBE_MODEL,
                    systemInstruction: TRANSCRIBE_SYSTEM,
                    contents: [
                        { inlineData: { mimeType: 'audio/mpeg', data: audioB64 } },
                        { text: `The acronym under test is "${token}". Report exactly how the voice pronounced it.` },
                    ],
                    config: { responseMimeType: 'application/json', responseJsonSchema: TRANSCRIBE_SCHEMA },
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Gemini timeout')), TRANSCRIBE_TIMEOUT_MS)),
            ]);
            return JSON.parse(res.text);
        } catch (error) {
            const retryable = /503|UNAVAILABLE|429|RESOURCE_EXHAUSTED|timeout/i.test(error.message);
            if (!retryable || attempt === 3) {
                console.error(`  ! transcribe failed: ${error.message.slice(0, 120)}`);
                return null;
            }
            await sleep(2000 * (attempt + 1));
        }
    }
    return null;
}

/** Save a clip so a human can adjudicate anything the transcriber got wrong. */
async function saveClip(url, name) {
    try {
        const res = await axios.get(url, { responseType: 'arraybuffer', timeout: SYNTH_TIMEOUT_MS });
        const path = join(outDir, `${name}.mp3`);
        writeFileSync(path, Buffer.from(res.data));
        return path;
    } catch {
        return null;
    }
}

/**
 * Group B: how does the model say each candidate with no dictionary at all?
 * Anything it already handles must stay out of the defaults.
 */
async function runBaseline() {
    // --tokens lets a failed subset be re-run without paying for the whole list.
    const only = argOf('tokens', '');
    const selected = only ? only.split(',').map(t => t.trim()).filter(Boolean) : CANDIDATES;
    const tokens = limit ? selected.slice(0, limit) : selected;
    console.log(`\n=== Group B: baseline (${tokens.length} tokens, no pronunciation_dict) ===\n`);

    const results = [];
    for (const token of tokens) {
        if (apiFailures > MAX_API_FAILURES) {
            console.error('Too many API failures — aborting.');
            break;
        }

        const text = carrier(token);
        try {
            const { url, statusCode, statusMsg, durationMs } = await synth(text);
            if (!url) {
                console.log(`${token.padEnd(10)} FAILED  base_resp=${statusCode} ${statusMsg}`);
                results.push({ token, error: `${statusCode} ${statusMsg}` });
                await sleep(CALL_DELAY_MS);
                continue;
            }

            const clip = await saveClip(url, `baseline-${token}`);
            const t = await transcribe(url, token);

            results.push({ token, text, durationMs, clip, ...t, verdict: verdictFor(t) });

            const verdict = verdictFor(t);
            console.log(`${token.padEnd(10)} ${verdict.padEnd(12)} spoken="${t?.spokenForm ?? '?'}"`);
        } catch (error) {
            apiFailures++;
            console.log(`${token.padEnd(10)} ERROR   ${error.message}`);
            results.push({ token, error: error.message });
        }
        await sleep(CALL_DELAY_MS);
    }
    return results;
}

/** The one assertion this whole feature is built around. */
async function runLolRegression() {
    console.log('\n=== lol regression (no dictionary) ===\n');
    const results = [];
    // Distinct labels: these two differ only by casing, so a lowercased name
    // would have both writes land on the same file.
    for (const [label, text] of [['lower', "lol that's funny"], ['upper', "LOL that's funny"]]) {
        try {
            const { url, statusCode, statusMsg } = await synth(text);
            if (!url) {
                console.log(`"${text}" FAILED base_resp=${statusCode} ${statusMsg}`);
                continue;
            }
            const clip = await saveClip(url, `lol-${label}`);
            const t = await transcribe(url, 'lol');
            results.push({ text, clip, ...t });
            console.log(`"${text}"\n  spoken="${t?.spokenForm}" letterByLetter=${t?.letterByLetter}`);
            if (t && !t.letterByLetter) {
                console.log('  !! "lol" did NOT read letter-by-letter — revisit the premise before shipping.');
            }
        } catch (error) {
            console.log(`"${text}" ERROR ${error.message}`);
        }
        await sleep(CALL_DELAY_MS);
    }
    return results;
}

/** Group A: probe the API dictionary's undocumented matching rules. */
async function runSemantics() {
    console.log('\n=== Group A: pronunciation_dict matching semantics ===\n');
    const results = [];

    for (const c of SEMANTICS_CASES) {
        console.log(`[${c.id}] ${c.asks}`);
        console.log(`  text="${c.text}" dict=${JSON.stringify(c.dict.slice(0, 2))}${c.dict.length > 2 ? ` (+${c.dict.length - 2})` : ''}`);
        try {
            const { url, statusCode, statusMsg, durationMs } = await synth(c.text, { dict: c.dict });
            if (!url) {
                console.log(`  FAILED base_resp=${statusCode} ${statusMsg}\n`);
                results.push({ ...c, error: `${statusCode} ${statusMsg}` });
                await sleep(CALL_DELAY_MS);
                continue;
            }
            const clip = await saveClip(url, `semantics-${c.id}`);
            const t = await transcribe(url, c.id);
            results.push({ id: c.id, asks: c.asks, text: c.text, durationMs, clip, ...t });
            console.log(`  transcript="${t?.transcript ?? '?'}" (${durationMs}ms)\n`);
        } catch (error) {
            console.log(`  ERROR ${error.message}\n`);
            results.push({ id: c.id, error: error.message });
        }
        await sleep(CALL_DELAY_MS);
    }

    // Does the Wavespeed fallback honour the same parameter? If it does not,
    // an API-side dictionary would silently stop applying whenever 302.ai fails.
    if (WAVESPEED_API_KEY) {
        console.log('[wavespeed] Does the fallback provider honour pronunciation_dict?');
        try {
            const { url, durationMs } = await synth('LFG', { dict: ['lfg/lets go'], provider: 'wavespeed' });
            if (url) {
                const clip = await saveClip(url, 'semantics-wavespeed');
                const t = await transcribe(url, 'lfg');
                results.push({ id: 'wavespeed', text: 'LFG', durationMs, clip, ...t });
                console.log(`  transcript="${t?.transcript ?? '?'}" (${durationMs}ms)\n`);
            } else {
                console.log('  no audio returned\n');
            }
        } catch (error) {
            console.log(`  ERROR ${error.message}\n`);
        }
    }

    return results;
}

async function main() {
    if (!T302_API_KEY) {
        console.error('T302_API_KEY is not set.');
        process.exit(1);
    }
    if (!GEMINI_API_KEY) {
        console.error('GEMINI_API_KEY is not set — transcription is what makes this probe useful.');
        process.exit(1);
    }

    mkdirSync(outDir, { recursive: true });
    console.log(`Writing clips and results to ${outDir}`);

    const out = { startedAt: new Date().toISOString(), model: MODEL, voiceId: VOICE_ID };

    if (only === 'all' || only === 'semantics') out.semantics = await runSemantics();
    if (only === 'all' || only === 'baseline') {
        out.lolRegression = await runLolRegression();
        out.baseline = await runBaseline();
    }

    out.finishedAt = new Date().toISOString();
    const jsonPath = join(outDir, 'results.json');
    writeFileSync(jsonPath, JSON.stringify(out, null, 2));

    if (out.baseline) {
        const by = v => out.baseline.filter(r => r.verdict === v).map(r => r.token);
        console.log(`\n=== Summary ===`);
        console.log(`Already correct : ${by('ok').join(' ') || '(none)'}`);
        console.log(`Needs an entry  : ${by('needs-entry').join(' ') || '(none)'}`);
        console.log(`Listen and judge: ${by('review').join(' ') || '(none)'}`);
    }
    console.log(`\nFull results: ${jsonPath}`);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
