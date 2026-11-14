// scripts/validate-voice-map.js
// Checks src/components/tts/minimax-to-gemini-voices.json before anything depends on it.
// Every MiniMax voice ID needs a row, and every target must be a real Gemini voice ID.
// The optional languageCode and style of a row are checked for shape.
//
// Usage:  node scripts/validate-voice-map.js [mapfile]     Exit code 1 on any problem.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WAVESPEED_VOICE_IDS } from '../src/components/tts/wavespeedVoices.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAP_FILE = path.resolve(process.argv[2] || path.join(HERE, '../src/components/tts/minimax-to-gemini-voices.json'));
const { voices } = JSON.parse(fs.readFileSync(path.join(HERE, '../src/components/tts/gemini-voices.json'), 'utf8'));
const geminiIds = new Set(voices.map(v => v.id));
const CONFIDENCE = ['high', 'medium', 'low'];

const problems = [];
let map;
try {
    map = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
} catch (err) {
    console.error(`Cannot read ${MAP_FILE}: ${err.message}`);
    process.exit(1);
}

const sourceIds = new Set(WAVESPEED_VOICE_IDS);
for (const id of sourceIds) {
    const row = map[id];
    if (!row) { problems.push(`missing row: ${id}`); continue; }
    if (!geminiIds.has(row.voice)) problems.push(`${id}: "${row.voice}" is not a Gemini voice ID`);
    if (!CONFIDENCE.includes(row.confidence)) problems.push(`${id}: confidence must be high, medium or low`);
    if (!Array.isArray(row.alternates)) problems.push(`${id}: alternates must be a list`);
    for (const alt of row.alternates || []) {
        if (!geminiIds.has(alt)) problems.push(`${id}: alternate "${alt}" is not a Gemini voice ID`);
    }
    if (typeof row.reason !== 'string' || !row.reason.trim()) problems.push(`${id}: reason is empty`);
    // Optional fields. The API answers 400 to a malformed language tag, and a long style makes the voice drift.
    if (row.languageCode !== undefined && !/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|\d{3}))?$/.test(row.languageCode)) {
        problems.push(`${id}: languageCode "${row.languageCode}" is not a BCP-47 tag like en-US`);
    }
    if (row.style !== undefined) {
        if (typeof row.style !== 'string') problems.push(`${id}: style must be text`);
        else if (row.style.trim().split(/\s+/).filter(Boolean).length > 6 || row.style.length > 60) problems.push(`${id}: style is longer than a few words`);
        if (row.style && row.needsStyleRender !== true) problems.push(`${id}: a row with a style needs needsStyleRender: true`);
    }
}
for (const id of Object.keys(map)) {
    if (!sourceIds.has(id)) problems.push(`unknown source voice: ${id}`);
}

if (problems.length) {
    console.error(`${problems.length} problems:\n${problems.slice(0, 80).map(p => `  ${p}`).join('\n')}`);
    process.exit(1);
}
const counts = Object.fromEntries(CONFIDENCE.map(c => [c, Object.values(map).filter(r => r.confidence === c).length]));
const targets = new Set(Object.values(map).map(r => r.voice));
const styled = Object.values(map).filter(r => r.style).length;
console.log(`OK. ${sourceIds.size} voices map to ${targets.size} Gemini voices. Confidence: ${JSON.stringify(counts)}. Rows with a style: ${styled}.`);
