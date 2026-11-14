// scripts/build-voice-review.js
// Builds build/voice-map/review.html, the page for judging the MiniMax to Gemini voice map
// by ear before the backfill runs.
//
// The first section lists every channel and viewer with a stored voice, by name, with the
// old voice and the voice they get. The second section lists all 475 mappings by use.
// A row whose mapping adds a style also gets a clip with that style, rendered here.
//
// The page holds usernames, so it stays in build/, which git ignores. Read-only for
// Firestore. Twitch is asked for the login of a viewer document that stores none.
//
// Usage:  node --env-file=.env scripts/build-voice-review.js
//         Needs Application Default Credentials, GEMINI_API_KEY, and for the name lookup
//         TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Firestore } from '@google-cloud/firestore';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(HERE, '../build/voice-map');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const map = readJson(path.join(HERE, '../src/components/tts/minimax-to-gemini-voices.json'));
const catalog = Object.fromEntries(readJson(path.join(HERE, '../src/components/tts/gemini-voices.json')).voices.map(v => [v.id, v]));
const measurements = readJson(path.join(OUT_DIR, 'measurements.json'));
const mapByLower = new Map(Object.entries(map).map(([id, row]) => [id.toLowerCase(), [id, row]]));
const firestore = new Firestore({ projectId: process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'chatvibestts' });

const PHRASE = 'Chat, is this real?';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const slug = id => id.replace(/[^\w.-]/g, '_');

async function renderStyled(minimaxId, row) {
    const file = path.join(OUT_DIR, 'styled', `${slug(minimaxId)}.${row.voice}.wav`);
    if (fs.existsSync(file)) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
        method: 'POST',
        headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-lite-tts',
            input: [{ type: 'user_input', content: [{ type: 'text', text: PHRASE, annotations: [{ type: 'speech_metadata', style: row.style }] }] }],
            response_format: { type: 'audio' },
            generation_config: { speech_config: [{ voice: row.voice }] },
            store: false,
        }),
    });
    const audio = res.ok && (await res.json()).steps?.filter(s => s.type === 'model_output').flatMap(s => s.content).find(c => c.type === 'audio');
    if (audio) fs.writeFileSync(file, Buffer.from(audio.data, 'base64'));
    else console.error(`  could not render the styled clip for ${minimaxId} (${res.status})`);
}

async function twitchLogins(ids) {
    const names = new Map();
    if (!ids.length || !process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) return names;
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        body: new URLSearchParams({ client_id: process.env.TWITCH_CLIENT_ID, client_secret: process.env.TWITCH_CLIENT_SECRET, grant_type: 'client_credentials' }),
    });
    if (!tokenRes.ok) { console.error(`  Twitch token request failed (${tokenRes.status}); some names stay as IDs`); return names; }
    const { access_token: token } = await tokenRes.json();
    for (let i = 0; i < ids.length; i += 100) {
        const query = ids.slice(i, i + 100).map(id => `id=${encodeURIComponent(id)}`).join('&');
        const res = await fetch(`https://api.twitch.tv/helix/users?${query}`, { headers: { 'Client-Id': process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` } });
        if (!res.ok) continue;
        for (const user of (await res.json()).data || []) names.set(user.id, user.login);
    }
    return names;
}

const minimaxSample = id => {
    const samples = measurements.minimax[id] || {};
    return (samples['chat-is-this-real'] || Object.values(samples)[0])?.file;
};
const player = src => `<audio controls preload="none" src="${esc(src)}"></audio>`;

function oldCell(id) {
    const file = minimaxSample(id);
    return `<b>${esc(id)}</b><br>${file ? player(`../../../chatvibes-web-ui/public/assets/voices/${encodeURIComponent(file)}`) : 'no sample'}`;
}

function newCell(id, row) {
    const voice = catalog[row.voice];
    const language = !row.languageCode.startsWith('en') && voice.studio ? row.languageCode : null;
    const native = language && fs.existsSync(path.join(OUT_DIR, 'native-check', `${row.voice}.${language}.wav`));
    return `<b>${esc(row.voice)}</b> <small>${esc(voice.name)}, ${esc(voice.studio ? 'studio voice' : voice.language)}, ${esc(voice.gender)}, ${esc(voice.pitch)} pitch</small><br>`
        + player(`gemini/${row.voice}.wav`)
        + (row.style ? `<br><small>with the style "${esc(row.style)}":</small><br>${player(`styled/${slug(id)}.${row.voice}.wav`)}` : '')
        + (native ? `<br><small>speaking ${esc(language)}:</small><br>${player(`native-check/${row.voice}.${language}.wav`)}` : '')
        + `<br><small>${esc(voice.description)}</small>`;
}

const noteCell = row => `<span class="c-${esc(row.confidence)}">${esc(row.confidence)}</span><br><small>${esc(row.reason)}</small>`;

async function main() {
    const [channels, viewers, managed] = await Promise.all([
        firestore.collection('ttsChannelConfigs').get(),
        firestore.collection('ttsUserPreferences').get(),
        firestore.collection('managedChannels').get(),
    ]);
    const names = new Map();
    managed.forEach(doc => names.set(doc.id, doc.data().twitchUserLogin || doc.data().channelName));
    viewers.forEach(doc => { if (doc.data().username) names.set(doc.id, doc.data().username); });

    // One entry for each stored voice: who it belongs to and where it is stored.
    const people = [];
    const use = new Map();
    const add = (userId, kind, voiceId, where) => {
        const hit = typeof voiceId === 'string' && mapByLower.get(voiceId.toLowerCase());
        if (!hit) return;
        people.push({ userId, kind, minimaxId: hit[0], row: hit[1], where });
        use.set(hit[0], (use.get(hit[0]) || 0) + 1);
    };
    channels.forEach(doc => {
        const data = doc.data();
        add(doc.id, 'channel default', data.voiceId, '');
        for (const [userId, prefs] of Object.entries(data.userPreferences || {})) add(userId, 'viewer', prefs?.voiceId, `old setting inside channel ${doc.id}`);
    });
    viewers.forEach(doc => add(doc.id, 'viewer', doc.data().voiceId, ''));

    const unnamed = [...new Set(people.map(p => p.userId).filter(id => !names.has(id) && /^\d+$/.test(id)))];
    for (const [id, login] of await twitchLogins(unnamed)) names.set(id, login);

    const styled = Object.entries(map).filter(([, row]) => row.style);
    console.log(`Rendering ${styled.length} styled clips (existing ones are kept)...`);
    for (const [id, row] of styled) await renderStyled(id, row);

    const nameOf = p => names.get(p.userId) || `(ID ${p.userId})`;
    people.sort((a, b) => (a.kind === 'viewer') - (b.kind === 'viewer') || nameOf(a).localeCompare(nameOf(b)));
    const peopleRows = people.map(p => `<tr><td><b>${esc(nameOf(p))}</b><br><small>${esc(p.kind)}${p.where ? `, ${esc(names.get(p.where.split(' ').pop()) ? `old setting inside channel ${names.get(p.where.split(' ').pop())}` : p.where)}` : ''}</small></td><td>${oldCell(p.minimaxId)}</td><td>${newCell(p.minimaxId, p.row)}</td><td>${noteCell(p.row)}</td></tr>`).join('\n');

    const all = Object.entries(map).sort((a, b) => (use.get(b[0]) || 0) - (use.get(a[0]) || 0) || a[0].localeCompare(b[0]));
    const allRows = all.map(([id, row]) => `<tr><td>${oldCell(id)}<br><small>used by ${use.get(id) || 0}</small></td><td>${newCell(id, row)}</td><td>${row.alternates.map(alt => `<small>${esc(alt)}</small><br>${player(`gemini/${alt}.wav`)}`).join('<br>')}</td><td>${noteCell(row)}</td></tr>`).join('\n');

    fs.writeFileSync(path.join(OUT_DIR, 'review.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Voice map review</title>
<style>
body{font:14px/1.45 system-ui,sans-serif;margin:24px;color:#1a1a1a;background:#fff}
h1{font-size:22px}h2{font-size:18px;margin-top:40px}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #ddd;padding:8px;text-align:left;vertical-align:top}
th{background:#f3f3f3;position:sticky;top:0}audio{height:32px;width:250px}small{color:#555}
.c-high{color:#17691d}.c-medium{color:#8a5a00}.c-low{color:#a40000;font-weight:600}
</style></head><body>
<h1>Voice map review</h1>
<p>Built at ${esc(new Date().toISOString())}. The old samples and the plain new samples say the same English sentence. This page holds usernames. Do not publish it.</p>
<h2>People with a stored voice (${people.length})</h2>
<p>Every channel default and every viewer voice in Firestore, with the voice that the backfill gives them. Channels are first, then viewers by name. A voice that is not listed here is not in use.</p>
<table><thead><tr><th>Who</th><th>Old voice</th><th>New voice</th><th>Confidence and reason</th></tr></thead><tbody>
${peopleRows}
</tbody></table>
<h2>All ${all.length} mappings, most used first</h2>
<table><thead><tr><th>Old voice</th><th>New voice</th><th>Alternates</th><th>Confidence and reason</th></tr></thead><tbody>
${allRows}
</tbody></table>
</body></html>`);
    const stillUnnamed = people.filter(p => !names.has(p.userId)).length;
    console.log(`${people.length} stored voices of ${new Set(people.map(p => p.userId)).size} people. ${stillUnnamed} have no name and show as an ID.`);
    console.log(`Wrote ${path.join(OUT_DIR, 'review.html')}`);
}

main().catch(err => { console.error(err); process.exit(1); });
