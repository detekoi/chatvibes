#!/usr/bin/env node
// scripts/backfill_read_cheer_messages.js
//
// One-off, for the switch from `bitsModeEnabled` to `readCheerMessages`.
//
// The old field only ever added cheer reading to command mode (all mode read
// cheers regardless, bits_points_only always does). The new field defaults to
// true in every mode, so a command-mode channel that never turned the old one
// on would start hearing cheer messages the moment the new bot deployed. This
// pins those channels to `readCheerMessages: false` so nothing they hear
// changes, and deletes the dead field everywhere it exists.
//
// Dry run by default. Pass --apply to write.

import { Firestore, FieldValue } from '@google-cloud/firestore';

const apply = process.argv.includes('--apply');
const db = new Firestore({ projectId: process.env.GOOGLE_CLOUD_PROJECT || 'chatvibestts' });

const snapshot = await db.collection('ttsChannelConfigs').get();
let writes = 0;
for (const doc of snapshot.docs) {
    const data = doc.data();
    const name = data.channelName || doc.id;
    const update = {};
    if (data.mode === 'command' && data.bitsModeEnabled !== true && data.readCheerMessages === undefined) {
        update.readCheerMessages = false;
    }
    if (data.bitsModeEnabled !== undefined) {
        update.bitsModeEnabled = FieldValue.delete();
    }
    if (Object.keys(update).length === 0) continue;
    writes++;
    const summary = Object.entries(update).map(([k, v]) => `${k}=${v instanceof FieldValue ? '<delete>' : v}`).join(', ');
    if (apply) {
        await doc.ref.update(update);
        console.log(`  wrote  ${name.padEnd(20)} ${summary}`);
    } else {
        console.log(`  would write  ${name.padEnd(20)} ${summary}`);
    }
}
console.log(`${snapshot.size} channel configs, ${writes} ${apply ? 'updated' : 'to update'}`);
if (!apply && writes > 0) console.log('\nDry run. Re-run with --apply to write.');
