#!/usr/bin/env node
// scripts/backfill_bot_responds_in_chat.js
//
// One-off, for the removal of the `botMode` read-time fallback in ttsState.js.
//
// `botMode` was never a working feature, but the bot still read it: a config
// with no `botRespondsInChat` and `botMode: 'authenticated'` was treated as
// responding in chat, while one with neither field is silent. With the fallback
// gone those channels would stop getting chat replies the moment the new bot
// deployed. This pins them to `botRespondsInChat: true` so nothing they see
// changes, and deletes the dead field everywhere it exists.
//
// Run it before deploying the bot. It is safe against the old bot too, which
// prefers `botRespondsInChat` whenever it is set. The dashboard must stop
// writing `botMode` on /api/bot/add or the field comes back (harmlessly).
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
    if (data.botRespondsInChat === undefined && data.botMode === 'authenticated') {
        update.botRespondsInChat = true;
    }
    if (data.botMode !== undefined) {
        update.botMode = FieldValue.delete();
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
