#!/usr/bin/env node
// Finds pronunciation-dictionary candidates for a NON-English channel language.
//
// The English list in PRONUNCIATION_DEFAULTS was seeded by scripts/probe-pronunciation.js
// from a known candidate list. That does not transfer: German chat abbreviations
// ("vllt", "kp", "hdf") are not translations of English ones, they are a different
// vocabulary, and which of them MiniMax mangles is an empirical question about the
// voice model rather than a fact about the language.
//
// So this runs in two phases:
//
//   1. PROPOSE  — ask a model for abbreviations speakers of that language actually
//                 type in stream chat, with an expansion and a natural carrier
//                 sentence. Anything it reports as also being an ordinary word is
//                 dropped here, unprobed: adding such an entry would mangle real
//                 sentences, which is the exact bug the `except` scoping just fixed.
//   2. PROBE    — synthesise the carrier sentence with that language_boost and
//                 transcribe it, forcing a phonetic self-report. Only tokens the
//                 voice actually mishandles are worth a dictionary entry. An entry
//                 for something already spoken correctly is a chance to break it,
//                 which is why "lol" is deliberately absent from the English list.
//
// Output is a PROPOSAL for review, never applied automatically. Entries belong in
// tts-config.json scoped with `only: ["<bcp47>"]` so they fire on that language and
// leave every other channel alone.
//
// Hits two paid APIs and is non-deterministic. Never wire this into CI.
//
// Usage:
//   node scripts/probe-pronunciation-language.js --languages es,de
//   node scripts/probe-pronunciation-language.js --languages ja --limit 10
//   node scripts/probe-pronunciation-language.js --languages es,fr,de,it,pt,ja,ru --out /tmp/lang-probe.json

import { readFileSync, writeFileSync } from 'fs';
import axios from 'axios';
import { GoogleGenAI } from '@google/genai';
import 'dotenv/config';
import { withTimeout } from '../src/lib/timeUtils.js';

const T302_ENDPOINT = process.env.T302_API_ENDPOINT || 'https://api.302.ai/minimaxi/v1/t2a_v2';
const T302_API_KEY = process.env.T302_API_KEY || process.env['302_KEY'];
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const SYNTH_MODEL = 'speech-2.8-turbo';
const VOICE_ID = 'Friendly_Person';
const PROPOSE_MODEL = process.env.TRANSLATE_GEMINI_MODEL || 'gemini-3.7-flash';
const TRANSCRIBE_MODEL = 'gemini-flash-latest';

const CALL_DELAY_MS = 300;      // MiniMax rate-limits (base_resp 1002)
const SYNTH_TIMEOUT_MS = 20_000;
const TRANSCRIBE_TIMEOUT_MS = 30_000;
const PROPOSE_TIMEOUT_MS = 120_000;

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const locales = JSON.parse(readFileSync('src/i18n/locales.json', 'utf8'));
const ttsConfig = JSON.parse(readFileSync('src/components/tts/tts-config.json', 'utf8'));
const existingTokens = new Set(ttsConfig.PRONUNCIATION_DEFAULTS.map(e => e.match));

const requested = opt('languages', '').split(',').map(s => s.trim()).filter(Boolean);
const limit = Number(opt('limit', '0')) || 0;

const targets = Object.entries(locales.LANGUAGE_BOOSTS)
    .map(([languageBoost, v]) => ({ languageBoost, ...v }))
    .filter(l => requested.includes(l.bcp47));

const genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- phase 1

const PROPOSE_SYSTEM = `You list the abbreviations and acronyms that speakers of a given language actually type in live-stream chat.

Reply with ONLY the JSON object described by the schema. No preamble, no markdown fence.

Rules:
1. These must be abbreviations NATIVE to that language, not English acronyms borrowed into it. "brb" and "gg" are already handled globally; do not list them.
2. "say" is the full form written out in that same language, exactly as it should be read aloud. Never an English translation.
3. "carrier" is a short natural sentence in that language that uses the abbreviation the way a viewer would type it in chat.
4. "isAlsoAWord" is the safety check and matters more than coverage. Set it true if the token is ALSO an ordinary word, name, particle or common non-chat abbreviation in that language, so that replacing it everywhere would corrupt normal sentences. Be generous with this flag — a wrong false here silently mangles real messages.`;

const PROPOSE_SCHEMA = {
    type: 'object',
    properties: {
        entries: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    token: { type: 'string', description: 'Lowercase, letters/digits only, as typed in chat.' },
                    say: { type: 'string', description: 'Full form in the same language, written out for speech.' },
                    carrier: { type: 'string', description: 'A natural chat sentence in that language containing the token.' },
                    isAlsoAWord: { type: 'boolean', description: 'True if the token is also an ordinary word in that language.' },
                },
                required: ['token', 'say', 'carrier', 'isAlsoAWord'],
            },
        },
    },
    required: ['entries'],
};

async function propose(lang) {
    const response = await withTimeout(
        genAI.models.generateContent({
            model: PROPOSE_MODEL,
            systemInstruction: PROPOSE_SYSTEM,
            contents: [{
                text: `Language: ${lang.languageBoost} (${lang.endonym}).

List up to 30 abbreviations native to ${lang.languageBoost} that viewers type in Twitch or YouTube live-stream chat, and that a text-to-speech engine would plausibly get wrong when reading a message aloud.

Do not include these, which are already covered: ${[...existingTokens].join(', ')}`,
            }],
            config: { responseMimeType: 'application/json', responseJsonSchema: PROPOSE_SCHEMA },
        }),
        PROPOSE_TIMEOUT_MS,
        'propose timeout',
    );
    const parsed = JSON.parse(response.text);
    if (!parsed || !Array.isArray(parsed.entries)) {
        throw new Error(`unexpected propose shape: ${JSON.stringify(parsed).slice(0, 120)}`);
    }
    return parsed.entries;
}

// ---------------------------------------------------------------- phase 2

async function synth(text, languageBoost) {
    const res = await axios({
        method: 'POST',
        url: T302_ENDPOINT,
        headers: { Authorization: `Bearer ${T302_API_KEY}`, 'Content-Type': 'application/json' },
        data: {
            model: SYNTH_MODEL,
            text,
            stream: false,
            voice_setting: { voice_id: VOICE_ID, speed: 1.0, vol: 1.0, pitch: 0, emotion: 'neutral', text_normalization: false },
            audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
            language_boost: languageBoost,
            output_format: 'url',
        },
        timeout: SYNTH_TIMEOUT_MS,
    });
    // MiniMax reports failures as HTTP 200 with a non-zero base_resp.
    const statusCode = res.data?.base_resp?.status_code ?? 0;
    if (statusCode !== 0) throw new Error(`synth ${statusCode}: ${res.data?.base_resp?.status_msg}`);
    const d = res.data?.data;
    return d?.audio || res.data?.audio_file || (typeof d === 'string' ? d : null);
}

const TRANSCRIBE_SYSTEM = `You are a phonetic transcription assistant analysing text-to-speech output.

You are checking HOW a TTS engine vocalised an abbreviation, so a tidy transcript is useless — writing the expanded form when the voice actually spelled out letters destroys the only signal that matters. Report what the voice literally produced.`;

const TRANSCRIBE_SCHEMA = {
    type: 'object',
    properties: {
        transcript: { type: 'string', description: 'Verbatim words spoken, in order.' },
        spokenForm: { type: 'string', description: 'How the token under test was vocalised: letters separated by periods if spelled out, a word if said as one, or the phrase if expanded.' },
        letterByLetter: { type: 'boolean', description: 'True if spelled out letter by letter.' },
        soundsLikeNonsense: { type: 'boolean', description: 'True if it came out as an unintelligible syllable rather than clear letters or a real word.' },
        alreadyCorrect: { type: 'boolean', description: 'True if the voice already produced the intended full form, or a natural reading a listener would understand without help.' },
    },
    required: ['transcript', 'spokenForm', 'letterByLetter', 'soundsLikeNonsense', 'alreadyCorrect'],
};

async function transcribe(mp3Url, entry, lang) {
    const audio = await axios.get(mp3Url, { responseType: 'arraybuffer', timeout: SYNTH_TIMEOUT_MS });
    const audioB64 = Buffer.from(audio.data).toString('base64');

    // Flash returns 503 under load often enough that one attempt leaves holes in
    // the table for tokens we already paid to synthesise.
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const res = await withTimeout(
                genAI.models.generateContent({
                    model: TRANSCRIBE_MODEL,
                    systemInstruction: TRANSCRIBE_SYSTEM,
                    contents: [
                        { inlineData: { mimeType: 'audio/mpeg', data: audioB64 } },
                        { text: `The audio is ${lang.languageBoost}. The token under test is "${entry.token}", which should ideally be read as "${entry.say}". Report exactly how the voice pronounced "${entry.token}".` },
                    ],
                    config: { responseMimeType: 'application/json', responseJsonSchema: TRANSCRIBE_SCHEMA },
                }),
                TRANSCRIBE_TIMEOUT_MS,
                'transcribe timeout',
            );
            return JSON.parse(res.text);
        } catch (err) {
            if (attempt === 3) throw err;
            await sleep(1000 * (attempt + 1));
        }
    }
    return null;
}

// ---------------------------------------------------------------- driver

async function probeLanguage(lang) {
    process.stderr.write(`\n${lang.languageBoost} [${lang.bcp47}]: proposing…\n`);
    const proposed = await propose(lang);

    const risky = proposed.filter(e => e.isAlsoAWord);
    let candidates = proposed.filter(e => !e.isAlsoAWord && !existingTokens.has(e.token));
    if (limit) candidates = candidates.slice(0, limit);

    process.stderr.write(`  ${proposed.length} proposed, ${risky.length} dropped as real words, probing ${candidates.length}\n`);

    const results = [];
    for (const entry of candidates) {
        try {
            const url = await synth(entry.carrier, lang.languageBoost);
            if (!url) throw new Error('no audio url');
            const heard = await transcribe(url, entry, lang);
            results.push({ ...entry, heard, audio: url });
            const verdict = heard?.alreadyCorrect ? 'ok' : 'NEEDS ENTRY';
            process.stderr.write(`  ${entry.token.padEnd(10)} ${String(heard?.spokenForm).slice(0, 34).padEnd(36)} ${verdict}\n`);
        } catch (err) {
            results.push({ ...entry, error: err.message });
            process.stderr.write(`  ${entry.token.padEnd(10)} FAILED: ${err.message}\n`);
        }
        await sleep(CALL_DELAY_MS);
    }
    return { lang, proposed, risky, results };
}

async function main() {
    if (!T302_API_KEY || !GEMINI_API_KEY) {
        console.error('T302_API_KEY and GEMINI_API_KEY must both be set.');
        process.exit(1);
    }
    if (!targets.length) {
        console.error('Pass --languages with BCP-47 codes, e.g. --languages es,de,ja');
        process.exit(1);
    }

    const all = [];
    // Sequential across languages: MiniMax rate-limits, and the per-call delay
    // above is only meaningful if nothing else is calling at the same time.
    for (const lang of targets) {
        try {
            all.push(await probeLanguage(lang));
        } catch (err) {
            console.error(`${lang.bcp47} failed: ${err.message}`);
        }
    }

    console.log('# Per-language pronunciation probe\n');
    console.log('Proposals only. Each entry needs a speaker of the language to confirm the');
    console.log('expansion reads naturally before it goes into tts-config.json.\n');

    for (const { lang, risky, results } of all) {
        const needed = results.filter(r => r.heard && !r.heard.alreadyCorrect);
        console.log(`## ${lang.languageBoost} (${lang.endonym}) [${lang.bcp47}]\n`);
        if (!needed.length) {
            console.log('The voice already reads every probed token acceptably — no entries needed.\n');
        } else {
            console.log('```json');
            console.log(needed.map(r =>
                `  { "match": "${r.token}", "say": ${JSON.stringify(r.say)}, "only": ["${lang.bcp47}"] },`
            ).join('\n'));
            console.log('```\n');
            for (const r of needed) {
                console.log(`- \`${r.token}\` heard as **${r.heard.spokenForm}** — proposed "${r.say}"`);
            }
            console.log('');
        }
        const ok = results.filter(r => r.heard?.alreadyCorrect).map(r => r.token);
        if (ok.length) console.log(`Already read correctly, deliberately NOT added: ${ok.join(', ')}\n`);
        if (risky.length) {
            console.log(`Dropped before probing as ordinary words in ${lang.languageBoost}: ${risky.map(r => r.token).join(', ')}\n`);
        }
    }

    const outPath = opt('out', '');
    if (outPath) {
        writeFileSync(outPath, JSON.stringify(all, null, 2) + '\n');
        console.error(`\nwrote ${outPath}`);
    }
}

main().catch(err => { console.error(err); process.exit(1); });
