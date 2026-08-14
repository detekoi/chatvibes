#!/usr/bin/env node
// One-off cleanup for languageBoost values stored as the display label
// "Automatic" (or the legacy "None") instead of the "auto" that MiniMax's
// language_boost enum actually takes. The dashboard dropdown used to save the
// label; it now saves "auto", matching the viewer page.
//
// The readers all tolerate the old spellings (mapLanguageBoost in the bot, the
// dashboard load path, and /tts/test), so this is tidy-up, not a fix — it just
// lets those compatibility shims be retired later.
//
// Dry run by default. Pass --apply to write.

import { Firestore, FieldValue } from '@google-cloud/firestore';

const PROJECT_ID = process.env.GCP_PROJECT || 'chatvibestts';
const COLLECTIONS = ['ttsChannelConfigs', 'ttsUserPreferences'];
const STALE_VALUES = ['Automatic', 'None'];

const apply = process.argv.includes('--apply');
const firestore = new Firestore({ projectId: PROJECT_ID });

async function main() {
    console.log(`Scanning ${COLLECTIONS.join(', ')} in ${PROJECT_ID} (${apply ? 'APPLY' : 'DRY RUN'})...\n`);
    let updated = 0;

    for (const collection of COLLECTIONS) {
        const snapshot = await firestore.collection(collection).get();
        for (const doc of snapshot.docs) {
            const value = doc.data().languageBoost;
            if (!STALE_VALUES.includes(value)) continue;

            console.log(`${collection}/${doc.id}: languageBoost ${JSON.stringify(value)} -> "auto"`);
            updated++;
            if (apply) {
                await doc.ref.update({ languageBoost: 'auto', updatedAt: FieldValue.serverTimestamp() });
            }
        }
    }

    console.log(`\nDocuments ${apply ? 'updated' : 'to update'}: ${updated}`);
    if (!apply && updated > 0) {
        console.log('\nDry run — re-run with --apply to write these changes.');
    }
}

main().catch(err => {
    console.error('Cleanup failed:', err);
    process.exit(1);
});
