#!/usr/bin/env node
// One-off cleanup for per-voice volumes that were written as literal dotted
// root fields ("voiceVolumes.Friendly_Person") instead of entries in the nested
// voiceVolumes map. Firestore's set() treats a dotted key as a field name, not a
// path, so those writes never reached config.voiceVolumes and the bot ignored
// them. The web UI now writes the nested map; this migrates the stragglers.
//
// Dry run by default. Pass --apply to write.

import { Firestore, FieldPath, FieldValue } from '@google-cloud/firestore';

const PROJECT_ID = process.env.GCP_PROJECT || 'chatvibestts';
const COLLECTION = 'ttsChannelConfigs';
const PREFIX = 'voiceVolumes.';

const apply = process.argv.includes('--apply');
const firestore = new Firestore({ projectId: PROJECT_ID });

async function main() {
    console.log(`Scanning '${COLLECTION}' in ${PROJECT_ID} (${apply ? 'APPLY' : 'DRY RUN'})...\n`);

    const snapshot = await firestore.collection(COLLECTION).get();
    let docsWithStrays = 0;
    let fieldsMigrated = 0;
    let fieldsDropped = 0;
    let junkRemoved = 0;

    for (const doc of snapshot.docs) {
        const data = doc.data();
        const strays = Object.keys(data).filter(k => k.startsWith(PREFIX));
        const nested = data.voiceVolumes || {};
        // Entries written from an un-interpolated template literal. Only "${"
        // keys are treated as junk — an unrecognised voice name may simply be a
        // legacy ID that predates the current catalogue, so those are left alone.
        const junkNested = Object.keys(nested).filter(k => k.includes('${'));
        if (strays.length === 0 && junkNested.length === 0) continue;

        docsWithStrays++;
        const additions = {};
        const dropped = [];

        for (const key of strays) {
            const voiceId = key.slice(PREFIX.length);
            const value = data[key];
            // A nested value is authoritative: it was written through a path that
            // actually worked, so never overwrite it with the stray copy.
            if (typeof value === 'number' && nested[voiceId] === undefined) {
                additions[voiceId] = value;
            } else {
                dropped.push(key);
            }
        }

        fieldsMigrated += Object.keys(additions).length;
        fieldsDropped += dropped.length;
        junkRemoved += junkNested.length;

        console.log(`${doc.id}: ${strays.length} stray field(s), ${junkNested.length} junk map entr(ies)`);
        for (const [voiceId, value] of Object.entries(additions)) {
            console.log(`  migrate  ${PREFIX}${voiceId} -> voiceVolumes.${voiceId} = ${value}`);
        }
        for (const key of dropped) {
            console.log(`  drop     ${key} (nested value already set, or not a number)`);
        }
        for (const key of junkNested) {
            console.log(`  drop     voiceVolumes[${JSON.stringify(key)}] (un-interpolated template literal)`);
        }

        if (!apply) continue;

        if (Object.keys(additions).length > 0) {
            await doc.ref.set({ voiceVolumes: additions }, { merge: true });
        }
        // A field name containing a dot must be addressed via FieldPath, which
        // takes each argument as one literal segment: one segment for a stray
        // root field, two to reach inside the voiceVolumes map.
        const deletions = [];
        for (const key of strays) {
            deletions.push(new FieldPath(key), FieldValue.delete());
        }
        for (const key of junkNested) {
            deletions.push(new FieldPath('voiceVolumes', key), FieldValue.delete());
        }
        await doc.ref.update(...deletions);
    }

    console.log(`\nDocuments needing cleanup: ${docsWithStrays}`);
    console.log(`Volumes migrated: ${fieldsMigrated}`);
    console.log(`Fields dropped without migrating: ${fieldsDropped}`);
    console.log(`Junk map entries removed: ${junkRemoved}`);
    if (!apply && docsWithStrays > 0) {
        console.log('\nDry run — re-run with --apply to write these changes.');
    }
}

main().catch(err => {
    console.error('Cleanup failed:', err);
    process.exit(1);
});
