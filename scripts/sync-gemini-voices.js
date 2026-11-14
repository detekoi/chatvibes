// scripts/sync-gemini-voices.js
// Downloads the Gemini TTS voice catalog and writes src/components/tts/gemini-voices.json.
// The catalog is the only source of voice IDs for the bot, the dashboard and the docs.
// Run it again when Google adds voices, then run `npm run sync-constants`.
//
// Usage:  node --env-file=.env scripts/sync-gemini-voices.js [--check]
//         --check prints the difference from the committed file and writes nothing.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/components/tts/gemini-voices.json');
const KEY = process.env.GEMINI_API_KEY;
const CHECK = process.argv.includes('--check');

// The 30 studio voices of the speech-generation guide. They speak every language.
const STUDIO = new Set(['zephyr', 'puck', 'charon', 'kore', 'fenrir', 'leda', 'orus', 'aoede', 'callirrhoe', 'autonoe',
    'enceladus', 'iapetus', 'umbriel', 'algieba', 'despina', 'erinome', 'algenib', 'rasalgethi', 'laomedeia', 'achernar',
    'alnilam', 'schedar', 'gacrux', 'pulcherrima', 'achird', 'zubenelgenubi', 'vindemiatrix', 'sadachbia', 'sadaltager', 'sulafat']);

async function fetchAll() {
    const voices = [];
    let token = '';
    do {
        const url = new URL('https://generativelanguage.googleapis.com/v1beta/voices');
        url.searchParams.set('type', 'prebuilt');
        url.searchParams.set('page_size', '1000');
        if (token) url.searchParams.set('page_token', token);
        const res = await fetch(url, { headers: { 'x-goog-api-key': KEY } });
        if (!res.ok) throw new Error(`Voice list request failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
        const page = await res.json();
        voices.push(...(page.voices || []));
        token = page.next_page_token || '';
    } while (token);
    return voices;
}

function tidy(voice) {
    return {
        id: voice.id,
        name: voice.display_name,
        studio: STUDIO.has(voice.id),
        language: voice.language_code || null,
        region: voice.region_code || null,
        accent: voice.accent || null,
        gender: voice.gender || null,
        pitch: voice.pitch || null,
        persona: voice.persona || null,
        context: voice.context || null,
        description: voice.description || '',
    };
}

async function main() {
    if (!KEY) throw new Error('GEMINI_API_KEY is missing');
    const voices = (await fetchAll()).filter(v => v.type === 'prebuilt').map(tidy);
    const ids = new Set(voices.map(v => v.id));
    if (ids.size !== voices.length) throw new Error('The voice list has duplicate IDs');
    const missingStudio = [...STUDIO].filter(id => !ids.has(id));
    if (missingStudio.length) throw new Error(`Studio voices missing from the list: ${missingStudio.join(', ')}`);

    // Studio voices first, then by language and ID, so that the file diffs cleanly.
    voices.sort((a, b) => (b.studio - a.studio) || (a.language || '').localeCompare(b.language || '') || a.id.localeCompare(b.id));

    const previous = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')).voices : [];
    const before = new Set(previous.map(v => v.id));
    const added = voices.filter(v => !before.has(v.id)).map(v => v.id);
    const removed = previous.filter(v => !ids.has(v.id)).map(v => v.id);
    console.log(`${voices.length} voices (${voices.filter(v => v.studio).length} studio). Added ${added.length}, removed ${removed.length}.`);
    if (removed.length) console.log(`Removed: ${removed.join(', ')}`);
    if (CHECK) return;

    fs.writeFileSync(OUT, JSON.stringify({ voices }, null, 1) + '\n');
    console.log(`Wrote ${OUT}`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
