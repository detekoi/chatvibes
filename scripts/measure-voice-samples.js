// scripts/measure-voice-samples.js
// Measures pitch, loudness and length of every MiniMax sample and every Gemini sample.
// The voice mapping uses the numbers to shortlist candidates before anything is judged by ear.
//
// Usage:  node scripts/measure-voice-samples.js
//         Needs ffmpeg, the MiniMax samples in ../chatvibes-web-ui/public/assets/voices and the
//         Gemini samples from generate-gemini-voice-samples.js.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { measure } from './lib/audioMeasure.js';
import { WAVESPEED_VOICE_IDS } from '../src/components/tts/wavespeedVoices.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MINIMAX_DIR = path.resolve(HERE, '../../chatvibes-web-ui/public/assets/voices');
const GEMINI_DIR = path.resolve(HERE, '../build/voice-map/gemini');
const OUT = path.resolve(HERE, '../build/voice-map/measurements.json');
const PHRASES = ['chat-is-this-real', 'welcome-everyone-to-the-stream'];

// Some sample files spell a parenthesis in full width, and the voice list has both spellings.
const fold = name => name.replace(/（/g, '(').replace(/）/g, ')').replace(/\s+\(/g, '(');

const minimaxFiles = fs.readdirSync(MINIMAX_DIR).filter(f => f.endsWith('.mp3'));
const minimax = {};
for (const voiceId of WAVESPEED_VOICE_IDS) {
    const samples = {};
    for (const phrase of PHRASES) {
        const file = minimaxFiles.find(f => f === `${voiceId}-${phrase}.mp3`)
            || minimaxFiles.find(f => fold(f) === fold(`${voiceId}-${phrase}.mp3`));
        if (file) samples[phrase] = { file, ...measure(path.join(MINIMAX_DIR, file)) };
    }
    minimax[voiceId] = samples;
}

const gemini = {};
for (const file of fs.readdirSync(GEMINI_DIR).filter(f => f.endsWith('.wav'))) {
    gemini[file.slice(0, -4)] = { file, ...measure(path.join(GEMINI_DIR, file)) };
}

const noSample = Object.entries(minimax).filter(([, s]) => !Object.keys(s).length).map(([id]) => id);
fs.writeFileSync(OUT, JSON.stringify({ minimaxDir: MINIMAX_DIR, geminiDir: GEMINI_DIR, minimax, gemini }, null, 1) + '\n');
console.log(`Measured ${Object.keys(minimax).length - noSample.length} MiniMax voices and ${Object.keys(gemini).length} Gemini voices.`);
if (noSample.length) console.log(`MiniMax voices with no sample: ${noSample.join(', ')}`);
console.log(`Wrote ${OUT}`);
