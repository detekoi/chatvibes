#!/usr/bin/env node
/**
 * migrate_ignored_users_to_ids.js
 *
 * One-time migration converting the TTS ignore list from `ignoredUsers` (an
 * array of lowercased Twitch logins) to `ignoredUserIds` (a map of
 * "twitch:<userId>" -> display name). See src/lib/ignoreList.js for why.
 *
 * Runs in two phases so the bot and the web dashboard can be deployed in any
 * order without a window where nobody is ignored:
 *
 *   1. backfill  — writes `ignoredUserIds`, leaves `ignoredUsers` untouched.
 *                  Run this BEFORE deploying. Old code keeps reading the old
 *                  field; new code reads the new one.
 *   2. --cleanup — deletes the now-unread `ignoredUsers` field.
 *                  Run this AFTER both deploys are confirmed healthy.
 *
 * A login that no longer resolves (renamed or deleted account) is reported and
 * left out — it could not have matched a live chatter anyway. Nothing is dropped
 * silently.
 *
 * Usage:
 *   node scripts/migrate_ignored_users_to_ids.js              # Dry-run (default)
 *   node scripts/migrate_ignored_users_to_ids.js --execute    # Write ignoredUserIds
 *   node scripts/migrate_ignored_users_to_ids.js --cleanup              # Dry-run of phase 2
 *   node scripts/migrate_ignored_users_to_ids.js --cleanup --execute    # Delete ignoredUsers
 */

import { Firestore, FieldValue } from '@google-cloud/firestore';
import dotenv from 'dotenv';

dotenv.config();

const db = new Firestore();
const DRY_RUN = !process.argv.includes('--execute');
const CLEANUP = process.argv.includes('--cleanup');

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
let accessToken = null;

async function getTwitchAppToken() {
    if (accessToken) return accessToken;
    const resp = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: TWITCH_CLIENT_ID,
            client_secret: TWITCH_CLIENT_SECRET,
            grant_type: 'client_credentials',
        }),
    });
    if (!resp.ok) throw new Error(`Failed to get Twitch app token: ${resp.status}`);
    const data = await resp.json();
    accessToken = data.access_token;
    return accessToken;
}

/**
 * Resolve logins to { id, displayName }. Helix takes 100 logins per request and
 * simply omits the ones it cannot find.
 */
async function resolveLogins(logins) {
    const token = await getTwitchAppToken();
    const results = new Map();
    for (let i = 0; i < logins.length; i += 100) {
        const batch = logins.slice(i, i + 100);
        const params = new URLSearchParams();
        batch.forEach(u => params.append('login', u));
        const resp = await fetch(`https://api.twitch.tv/helix/users?${params.toString()}`, {
            headers: {
                'Client-ID': TWITCH_CLIENT_ID,
                'Authorization': `Bearer ${token}`,
            },
        });
        if (!resp.ok) {
            console.error(`Helix API error: ${resp.status} ${await resp.text()}`);
            continue;
        }
        const data = await resp.json();
        for (const user of data.data) {
            results.set(user.login.toLowerCase(), { id: user.id, displayName: user.display_name || user.login });
        }
    }
    return results;
}

async function runBackfill() {
    if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
        console.error('ERROR: TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET environment variables are required.');
        process.exit(1);
    }

    const snapshot = await db.collection('ttsChannelConfigs').get();
    const channels = [];
    const allLogins = new Set();

    snapshot.forEach(doc => {
        const list = doc.data().ignoredUsers;
        if (!Array.isArray(list) || list.length === 0) return;
        const logins = [...new Set(list.filter(u => typeof u === 'string' && u.trim()).map(u => u.trim().toLowerCase()))];
        if (logins.length === 0) return;
        channels.push({ doc, name: doc.data().channelName || doc.id, logins });
        logins.forEach(l => allLogins.add(l));
    });

    if (channels.length === 0) {
        console.log('No channel has a non-empty ignoredUsers array. Nothing to migrate.');
        return;
    }

    console.log(`${channels.length} channel(s) with an ignore list, ${allLogins.size} unique login(s).\n`);
    const resolved = await resolveLogins([...allLogins]);

    let migratedEntries = 0;
    const unresolvedByChannel = [];

    for (const { doc, name, logins } of channels) {
        const ignoredUserIds = {};
        const unresolved = [];
        for (const login of logins) {
            const user = resolved.get(login);
            if (!user) {
                unresolved.push(login);
                continue;
            }
            // A bare label, which src/lib/ignoreList.js reads as moderator-imposed.
            // That is the right provenance for these: the array this migrates from
            // was mod-managed, so nothing in it was ever a viewer's own opt-out.
            ignoredUserIds[`twitch:${user.id}`] = user.displayName;
        }

        console.log(`  ${name} (${doc.id}): ${Object.keys(ignoredUserIds).length}/${logins.length} migrated`);
        for (const [key, label] of Object.entries(ignoredUserIds)) {
            console.log(`      ${key}  ("${label}")`);
        }
        if (unresolved.length) {
            console.log(`      ⚠ unresolved, will NOT be carried over: ${unresolved.join(', ')}`);
            unresolvedByChannel.push({ name, docId: doc.id, unresolved });
        }

        migratedEntries += Object.keys(ignoredUserIds).length;

        // Written even when empty. Phase 2 tells "backfill has run" from "backfill
        // has not" by the presence of this field, so a channel whose every login
        // was stale still has to be marked — otherwise its old array is stranded
        // forever, indistinguishable from one the backfill never reached.
        if (DRY_RUN) {
            console.log(`      [DRY RUN] Would merge ignoredUserIds into ${doc.id}.`);
        } else {
            // merge:true so a re-run is idempotent and any entry added since the
            // deploy survives.
            await doc.ref.set({
                ignoredUserIds,
                updatedAt: FieldValue.serverTimestamp(),
            }, { merge: true });
            console.log(`      ✅ Written.`);
        }
    }

    console.log(`\n${migratedEntries} entries migrated across ${channels.length} channel(s).`);
    if (unresolvedByChannel.length) {
        console.log(`\n⚠ Logins that no longer resolve to a Twitch account:`);
        for (const c of unresolvedByChannel) {
            console.log(`    ${c.name}: ${c.unresolved.join(', ')}`);
        }
        console.log(`  These were renamed or deleted, so they could not have matched a live chatter.`);
        console.log(`  Re-add them by their current name if they are still around.`);
    }
}

async function runCleanup() {
    const snapshot = await db.collection('ttsChannelConfigs').get();
    let cleaned = 0;
    let blocked = 0;

    for (const doc of snapshot.docs) {
        const data = doc.data();
        if (data.ignoredUsers === undefined) continue;

        const oldCount = Array.isArray(data.ignoredUsers) ? data.ignoredUsers.length : 0;
        const newCount = Object.keys(data.ignoredUserIds || {}).length;

        // Refuse to delete a populated old list when the backfill has not run —
        // that would be the exact data loss this migration exists to avoid.
        //
        // The test is field presence, not entry count. A channel whose every login
        // had gone stale migrates to a legitimately empty map, and counting entries
        // would strand its old array here forever while reporting that the backfill
        // still needed running.
        if (oldCount > 0 && data.ignoredUserIds === undefined) {
            console.log(`  ⛔ ${data.channelName || doc.id}: ${oldCount} old entries and no ignoredUserIds field. Run the backfill first. Skipping.`);
            blocked++;
            continue;
        }

        console.log(`  ${data.channelName || doc.id}: dropping ignoredUsers (${oldCount} entries, ${newCount} now keyed by ID)`);
        if (DRY_RUN) {
            console.log(`      [DRY RUN] Would delete the ignoredUsers field.`);
        } else {
            await doc.ref.update({
                ignoredUsers: FieldValue.delete(),
                updatedAt: FieldValue.serverTimestamp(),
            });
            console.log(`      ✅ Deleted.`);
        }
        cleaned++;
    }

    console.log(`\n${cleaned} document(s) cleaned, ${blocked} skipped.`);
}

async function main() {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  TTS ignore list: logins -> immutable account IDs`);
    console.log(`  Phase: ${CLEANUP ? '2 (delete old ignoredUsers)' : '1 (backfill ignoredUserIds)'}`);
    console.log(`  Mode: ${DRY_RUN ? '🔍 DRY RUN (no changes)' : '🔥 EXECUTE (writing changes!)'}`);
    console.log(`${'='.repeat(60)}\n`);

    try {
        if (CLEANUP) {
            await runCleanup();
        } else {
            await runBackfill();
        }

        console.log(`\n${'='.repeat(60)}`);
        if (DRY_RUN) {
            console.log('  Dry run complete. Run with --execute to apply changes.');
        } else {
            console.log('  Done.');
        }
        console.log(`${'='.repeat(60)}\n`);
    } catch (error) {
        console.error('Migration failed:', error);
        process.exit(1);
    }
}

main();
