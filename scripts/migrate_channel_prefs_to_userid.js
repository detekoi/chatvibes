#!/usr/bin/env node
/**
 * migrate_channel_prefs_to_userid.js
 *
 * One-time migration script to convert per-channel user preferences
 * from username-keyed entries to Twitch User ID-keyed entries.
 *
 * Also migrates global ttsUserPreferences documents that were keyed by username.
 *
 * Usage:
 *   node scripts/migrate_channel_prefs_to_userid.js              # Dry-run (default)
 *   node scripts/migrate_channel_prefs_to_userid.js --execute    # Actually write changes
 *
 * Requires GOOGLE_APPLICATION_CREDENTIALS or equivalent Firestore auth.
 */

import { Firestore, FieldValue } from '@google-cloud/firestore';
import dotenv from 'dotenv';

dotenv.config();

const db = new Firestore();
const DRY_RUN = !process.argv.includes('--execute');

// Twitch Helix setup
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
 * Resolve a batch of usernames to Twitch User IDs via Helix API.
 * @param {string[]} usernames - Up to 100 usernames
 * @returns {Map<string, string>} Map of lowercase_username -> userId
 */
async function resolveUsernamestoIds(usernames) {
    const token = await getTwitchAppToken();
    const results = new Map();
    // Helix allows up to 100 per request
    const batches = [];
    for (let i = 0; i < usernames.length; i += 100) {
        batches.push(usernames.slice(i, i + 100));
    }
    for (const batch of batches) {
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
            results.set(user.login.toLowerCase(), user.id);
        }
    }
    return results;
}

/**
 * Checks if a key looks like a Twitch User ID (all digits).
 */
function isUserId(key) {
    return /^\d+$/.test(key);
}

async function migrateChannelPreferences() {
    console.log('\n=== Migrating Per-Channel User Preferences ===\n');
    const snapshot = await db.collection('ttsChannelConfigs').get();
    let totalMigrated = 0;
    let totalSkipped = 0;

    for (const doc of snapshot.docs) {
        const channelName = doc.id;
        const data = doc.data();
        const userPreferences = data.userPreferences;

        if (!userPreferences || Object.keys(userPreferences).length === 0) {
            continue;
        }

        // Find username-keyed entries (non-numeric keys)
        const usernameKeys = Object.keys(userPreferences).filter(k => !isUserId(k));

        if (usernameKeys.length === 0) {
            console.log(`  [${channelName}] All entries already keyed by userId. Skipping.`);
            continue;
        }

        console.log(`  [${channelName}] Found ${usernameKeys.length} username-keyed entries: ${usernameKeys.join(', ')}`);

        // Resolve usernames to IDs
        const usernameToId = await resolveUsernamestoIds(usernameKeys);

        const updates = {};
        const deletes = {};

        for (const username of usernameKeys) {
            const userId = usernameToId.get(username);
            if (!userId) {
                console.log(`    ⚠ Could not resolve "${username}" to a Twitch User ID (deleted/banned account?). Skipping.`);
                totalSkipped++;
                continue;
            }

            // Check if userId entry already exists (don't overwrite)
            if (userPreferences[userId]) {
                console.log(`    ⚠ userId ${userId} already exists for "${username}". Skipping to avoid overwrite.`);
                totalSkipped++;
                continue;
            }

            console.log(`    ✓ "${username}" → ${userId}`);
            updates[`userPreferences.${userId}`] = userPreferences[username];
            deletes[`userPreferences.${username}`] = FieldValue.delete();
            totalMigrated++;
        }

        if (Object.keys(updates).length > 0) {
            if (DRY_RUN) {
                console.log(`    [DRY RUN] Would write ${Object.keys(updates).length} updates and ${Object.keys(deletes).length} deletes.`);
            } else {
                await doc.ref.update({
                    ...updates,
                    ...deletes,
                    updatedAt: FieldValue.serverTimestamp(),
                });
                console.log(`    ✅ Migrated ${Object.keys(updates).length} entries.`);
            }
        }
    }

    console.log(`\nPer-channel migration: ${totalMigrated} migrated, ${totalSkipped} skipped.`);
}

async function migrateGlobalPreferences() {
    console.log('\n=== Migrating Global User Preferences (ttsUserPreferences) ===\n');
    const snapshot = await db.collection('ttsUserPreferences').get();
    let totalMigrated = 0;
    let totalSkipped = 0;

    // Find all docs keyed by username (non-numeric IDs)
    const usernameDocs = snapshot.docs.filter(doc => !isUserId(doc.id));

    if (usernameDocs.length === 0) {
        console.log('  All global preference documents already keyed by userId.');
        return;
    }

    console.log(`  Found ${usernameDocs.length} username-keyed documents.`);

    // Resolve in batches
    const usernames = usernameDocs.map(d => d.id);
    const usernameToId = await resolveUsernamestoIds(usernames);

    for (const doc of usernameDocs) {
        const username = doc.id;
        const userId = usernameToId.get(username);

        if (!userId) {
            console.log(`    ⚠ Could not resolve "${username}". Skipping.`);
            totalSkipped++;
            continue;
        }

        // Check if a userId doc already exists
        const existingDoc = await db.collection('ttsUserPreferences').doc(userId).get();
        if (existingDoc.exists) {
            console.log(`    ⚠ userId doc ${userId} already exists for "${username}". Skipping.`);
            totalSkipped++;
            continue;
        }

        const data = doc.data();
        console.log(`    ✓ "${username}" → ${userId} (keys: ${Object.keys(data).join(', ')})`);

        if (DRY_RUN) {
            console.log(`    [DRY RUN] Would create doc ${userId} and delete doc ${username}.`);
        } else {
            // Create new doc keyed by userId, preserving all data
            await db.collection('ttsUserPreferences').doc(userId).set({
                ...data,
                username: username, // Store username as metadata
                migratedFrom: username,
                migratedAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp(),
            });

            // Delete old username-keyed doc
            await db.collection('ttsUserPreferences').doc(username).delete();
            console.log(`    ✅ Migrated.`);
        }
        totalMigrated++;
    }

    console.log(`\nGlobal migration: ${totalMigrated} migrated, ${totalSkipped} skipped.`);
}

async function main() {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  TTS Preferences Migration: Username → User ID`);
    console.log(`  Mode: ${DRY_RUN ? '🔍 DRY RUN (no changes)' : '🔥 EXECUTE (writing changes!)'}`);
    console.log(`${'='.repeat(60)}\n`);

    if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
        console.error('ERROR: TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET environment variables are required.');
        process.exit(1);
    }

    try {
        await migrateChannelPreferences();
        await migrateGlobalPreferences();

        console.log(`\n${'='.repeat(60)}`);
        if (DRY_RUN) {
            console.log('  Dry run complete. Run with --execute to apply changes.');
        } else {
            console.log('  Migration complete!');
        }
        console.log(`${'='.repeat(60)}\n`);
    } catch (error) {
        console.error('Migration failed:', error);
        process.exit(1);
    }
}

main();
