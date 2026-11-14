// scripts/migrate-voices-to-gemini.js
// One-time backfill for the move from MiniMax to Gemini TTS. Rewrites every stored
// MiniMax voice ID to the Gemini voice that minimax-to-gemini-voices.json maps it to.
//
// The bot already maps an old ID each time it reads one (voiceResolver.js), so nothing
// breaks before this runs. The backfill makes the stored value match what the dashboard
// shows and lets the map be retired later.
//
// What it writes:
//   ttsChannelConfigs/<id>     voiceId, voiceStyle, voiceLanguage, voiceVolumes keys,
//                              userPreferences.<userId>.voiceId (legacy viewer settings)
//   ttsUserPreferences/<id>    voiceId, voiceStyle, voiceLanguage
// The old value is kept beside the new one as legacyVoiceId (and legacyVoiceVolumes).
// Speed, pitch and emotion are not touched: the bot converts them when it reads them.
//
// Usage:  node scripts/migrate-voices-to-gemini.js            dry run, prints every change
//         node scripts/migrate-voices-to-gemini.js --apply    writes the changes
//         Uses Application Default Credentials. Run validate-voice-map.js first.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Firestore, FieldValue } from '@google-cloud/firestore';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');
const firestore = new Firestore({ projectId: process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'chatvibestts' });

const readJson = file => JSON.parse(fs.readFileSync(path.join(HERE, '../src/components/tts', file), 'utf8'));
const catalog = readJson('gemini-voices.json').voices;
const geminiIds = new Set(catalog.map(v => v.id));
const studioIds = new Set(catalog.filter(v => v.studio).map(v => v.id));

/**
 * The language to store beside a new voice, or null. A MiniMax voice had a language of
 * its own. A studio voice has none, so a Cantonese or Thai voice that maps to a studio
 * voice keeps its language here. A library voice brings its language from the catalog.
 */
function keptLanguage(row) {
    const code = row.languageCode;
    return studioIds.has(row.voice) && typeof code === 'string' && !code.toLowerCase().startsWith('en') ? code : null;
}
const map = readJson('minimax-to-gemini-voices.json');
const mapByLower = new Map(Object.entries(map).map(([id, row]) => [id.toLowerCase(), row]));

/** The map row for a stored ID, or null when the ID is already a Gemini voice or unknown. */
function rowFor(voiceId) {
    if (typeof voiceId !== 'string' || !voiceId) return null;
    if (geminiIds.has(voiceId.toLowerCase())) return null;
    return mapByLower.get(voiceId.toLowerCase()) ?? null;
}

const stats = { channels: 0, viewers: 0, volumeKeys: 0, legacyViewers: 0, unknown: new Map() };
const noteUnknown = (voiceId, where) => {
    if (typeof voiceId !== 'string' || !voiceId || geminiIds.has(voiceId.toLowerCase())) return;
    stats.unknown.set(voiceId, `${where}`);
};

function voiceUpdate(voiceId, where) {
    const row = rowFor(voiceId);
    if (!row) { noteUnknown(voiceId, where); return null; }
    const update = { voiceId: row.voice, legacyVoiceId: voiceId };
    // The manner that the mapping adds for this voice. Deleted when there is none, so
    // that a manner from an earlier run cannot stay behind.
    update.voiceStyle = row.style ? row.style : FieldValue.delete();
    update.voiceLanguage = keptLanguage(row) ?? FieldValue.delete();
    return update;
}

function describe(voiceId) {
    const row = rowFor(voiceId);
    if (!row) return '';
    return `${row.style ? ` (style "${row.style}")` : ''}${keptLanguage(row) ? ` (language ${keptLanguage(row)})` : ''}`;
}

async function migrateChannels() {
    const snapshot = await firestore.collection('ttsChannelConfigs').get();
    for (const doc of snapshot.docs) {
        const data = doc.data();
        const update = {};
        const notes = [];

        const voice = voiceUpdate(data.voiceId, `channel ${doc.id}`);
        if (voice) {
            Object.assign(update, voice);
            notes.push(`voiceId ${data.voiceId} -> ${voice.voiceId}${describe(data.voiceId)}`);
        }

        // Per-voice volumes are keyed by voice ID. Two old voices can map to one new
        // voice: the first one in the document wins, and the old map is kept whole.
        const volumes = data.voiceVolumes;
        if (volumes && typeof volumes === 'object' && Object.keys(volumes).some(id => rowFor(id))) {
            const next = {};
            for (const [id, volume] of Object.entries(volumes)) {
                const target = rowFor(id)?.voice ?? id;
                if (!(target in next)) next[target] = volume;
                if (rowFor(id)) stats.volumeKeys++;
                else noteUnknown(id, `voiceVolumes of channel ${doc.id}`);
            }
            update.voiceVolumes = next;
            update.legacyVoiceVolumes = volumes;
            notes.push(`voiceVolumes ${Object.keys(volumes).length} keys -> ${Object.keys(next).length} keys`);
        }

        for (const [userId, prefs] of Object.entries(data.userPreferences || {})) {
            const row = rowFor(prefs?.voiceId);
            if (!row) { noteUnknown(prefs?.voiceId, `userPreferences.${userId} of channel ${doc.id}`); continue; }
            update[`userPreferences.${userId}.voiceId`] = row.voice;
            update[`userPreferences.${userId}.legacyVoiceId`] = prefs.voiceId;
            if (row.style) update[`userPreferences.${userId}.voiceStyle`] = row.style;
            if (keptLanguage(row)) update[`userPreferences.${userId}.voiceLanguage`] = keptLanguage(row);
            stats.legacyViewers++;
            notes.push(`userPreferences.${userId}.voiceId ${prefs.voiceId} -> ${row.voice}`);
        }

        if (notes.length === 0) continue;
        stats.channels++;
        console.log(`channel ${doc.id}: ${notes.join('; ')}`);
        // update() treats a dotted key as a path and replaces voiceVolumes as a whole
        // map, which is what removes the old keys. set(..., { merge: true }) would keep them.
        if (APPLY) await doc.ref.update(update);
    }
    return snapshot.size;
}

async function migrateViewers() {
    const snapshot = await firestore.collection('ttsUserPreferences').get();
    for (const doc of snapshot.docs) {
        const data = doc.data();
        const update = voiceUpdate(data.voiceId, `viewer ${doc.id}`);
        if (!update) continue;
        stats.viewers++;
        console.log(`viewer ${doc.id}: voiceId ${data.voiceId} -> ${update.voiceId}${describe(data.voiceId)}`);
        if (APPLY) await doc.ref.update(update);
    }
    return snapshot.size;
}

async function main() {
    console.log(APPLY ? 'APPLY: writing changes.\n' : 'Dry run: nothing is written. Add --apply to write.\n');
    const channelDocs = await migrateChannels();
    const viewerDocs = await migrateViewers();
    console.log(`\n${stats.channels} of ${channelDocs} channel documents and ${stats.viewers} of ${viewerDocs} viewer documents ${APPLY ? 'changed' : 'need a change'}.`);
    console.log(`${stats.volumeKeys} per-voice volume keys and ${stats.legacyViewers} legacy viewer settings inside channel documents.`);
    if (stats.unknown.size) {
        console.log(`\n${stats.unknown.size} stored voice IDs are neither Gemini voices nor in the map. They use the default voice:`);
        for (const [voiceId, where] of stats.unknown) console.log(`  ${voiceId}  (${where})`);
    }
}

main().catch(err => { console.error(err.message); process.exit(1); });
