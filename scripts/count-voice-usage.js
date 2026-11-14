// scripts/count-voice-usage.js
// Read-only count of how many channels and viewers use each stored voice ID.
// The voice mapping reviews the most used voices first.
//
// Usage:  node scripts/count-voice-usage.js [outfile]
//         Uses Application Default Credentials, as the other Firestore scripts do.

import fs from 'fs';
import path from 'path';
import { Firestore } from '@google-cloud/firestore';

const OUT = path.resolve(process.argv[2] || 'build/voice-map/usage.json');
const firestore = new Firestore({ projectId: process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'chatvibestts' });

const usage = {};
const bump = (voiceId, kind) => {
    if (typeof voiceId !== 'string' || !voiceId) return;
    usage[voiceId] ??= { channels: 0, viewers: 0, volumeEntries: 0 };
    usage[voiceId][kind]++;
};

async function main() {
    const channels = await firestore.collection('ttsChannelConfigs').get();
    channels.forEach(doc => {
        const data = doc.data();
        bump(data.voiceId, 'channels');
        for (const voiceId of Object.keys(data.voiceVolumes || {})) bump(voiceId, 'volumeEntries');
        // Legacy per-channel viewer preferences, still read by ttsState.
        for (const prefs of Object.values(data.userPreferences || {})) bump(prefs?.voiceId, 'viewers');
    });
    const viewers = await firestore.collection('ttsUserPreferences').get();
    viewers.forEach(doc => bump(doc.data().voiceId, 'viewers'));

    const rows = Object.entries(usage)
        .map(([voiceId, counts]) => ({ voiceId, ...counts, total: counts.channels + counts.viewers }))
        .sort((a, b) => b.total - a.total || b.volumeEntries - a.volumeEntries);
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({ channelDocs: channels.size, viewerDocs: viewers.size, voices: rows }, null, 1) + '\n');
    console.log(`${channels.size} channel documents, ${viewers.size} viewer documents, ${rows.length} distinct voice IDs in use.`);
    console.log(rows.slice(0, 15).map(r => `  ${String(r.total).padStart(4)}  ${r.voiceId}`).join('\n'));
    console.log(`Wrote ${OUT}`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
