#!/usr/bin/env node
// scripts/backfill_bot_responds_in_chat.js
//
// One-off, for the removal of the read-time `botRespondsInChat` fallbacks in
// ttsState.js, so that DEFAULT_TTS_SETTINGS is the only default.
//
// The bot used to decide a missing `botRespondsInChat` itself, in two steps.
// `botMode: 'authenticated'` read as responding in chat; `botMode` was never a
// working feature, but that read was live. Anything else read as silent, from a
// hardcoded `false` that was left behind when the default in ttsConstants.js
// moved to `true` (2025-11-19) — so a channel whose config lacked the field was
// silent while the documentation said it responded.
//
// With both gone a missing field means `true`. This writes down what each
// channel was actually getting, so nothing changes for them on deploy:
// `true` where `botMode` was 'authenticated', `false` for the rest. It also
// deletes the dead `botMode` field everywhere it exists.
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
    if (data.botRespondsInChat === undefined || data.botRespondsInChat === null) {
        update.botRespondsInChat = data.botMode === 'authenticated';
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
