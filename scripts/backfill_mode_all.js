#!/usr/bin/env node
// scripts/backfill_mode_all.js
//
// One-off. Writes `mode: 'all'` on every ttsChannelConfigs document that has no
// `mode` field.
//
// Why: until 2026-08-31 the bot's in-memory default for a missing `mode` was
// 'all', so every channel that never picked one was hearing all of chat. The
// default is now 'command' for new channels, and the dashboard writes it at
// first sign-in. Without this backfill the existing channels would silently
// flip from reading everything to reading only !tts the moment the new bot
// deployed. Pinning what they already had keeps their stream sounding the same.
//
// Dry run by default. Pass --apply to write.
//
//   node scripts/backfill_mode_all.js           # list what would change
//   node scripts/backfill_mode_all.js --apply   # write

import { Firestore } from '@google-cloud/firestore';

const apply = process.argv.includes('--apply');
const db = new Firestore({ projectId: process.env.GOOGLE_CLOUD_PROJECT || 'chatvibestts' });

const snapshot = await db.collection('ttsChannelConfigs').get();
const missing = snapshot.docs.filter((doc) => doc.data().mode === undefined);

console.log(`${snapshot.size} channel configs, ${missing.length} without a mode`);
for (const doc of missing) {
    const name = doc.data().channelName || doc.id;
    if (apply) {
        await doc.ref.set({ mode: 'all' }, { merge: true });
        console.log(`  wrote mode: 'all'  ${name} (${doc.id})`);
    } else {
        console.log(`  would write mode: 'all'  ${name} (${doc.id})`);
    }
}
if (!apply && missing.length > 0) {
    console.log('\nDry run. Re-run with --apply to write.');
}
