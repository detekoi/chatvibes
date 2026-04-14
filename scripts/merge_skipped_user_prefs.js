#!/usr/bin/env node
/**
 * merge_skipped_user_prefs.js
 *
 * Fixes users whose preferences were SKIPPED during the initial migration
 * because a userId-keyed document already existed (from the web UI).
 * Those userId docs may have only partial data (e.g., just emoteMode),
 * while the full set of prefs (voice, emotion, pitch, etc.) lives in
 * the old username-keyed document.
 *
 * This script merges the username doc fields INTO the userId doc
 * (userId doc fields take priority — they're newer), then deletes the
 * username doc to prevent stale data from being read as a fallback.
 *
 * Usage:
 *   node scripts/merge_skipped_user_prefs.js              # Dry-run
 *   node scripts/merge_skipped_user_prefs.js --execute     # Write changes
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

function isUserId(key) {
    return /^\d+$/.test(key);
}

async function resolveUsernamestoIds(usernames) {
    const token = await getTwitchAppToken();
    const results = new Map();
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

async function mergeGlobalPreferences() {
    console.log('\n=== Merging Skipped Global User Preferences ===\n');
    const snapshot = await db.collection('ttsUserPreferences').get();
    let totalMerged = 0;
    let totalSkipped = 0;

    // Find username-keyed docs that still exist (these were skipped previously)
    const usernameDocs = snapshot.docs.filter(doc => !isUserId(doc.id));

    if (usernameDocs.length === 0) {
        console.log('  No remaining username-keyed documents found.');
        return;
    }

    console.log(`  Found ${usernameDocs.length} remaining username-keyed documents to check.\n`);

    const usernames = usernameDocs.map(d => d.id);
    const usernameToId = await resolveUsernamestoIds(usernames);

    for (const doc of usernameDocs) {
        const username = doc.id;
        const userId = usernameToId.get(username);
        const usernameData = doc.data();

        if (!userId) {
            console.log(`    ⚠ Could not resolve "${username}". Skipping.`);
            totalSkipped++;
            continue;
        }

        // Check if userId doc exists
        const userIdDoc = await db.collection('ttsUserPreferences').doc(userId).get();

        if (!userIdDoc.exists) {
            // Straightforward migration (shouldn't happen if original script ran, but handle it)
            console.log(`    ✓ "${username}" → ${userId} (no userId doc exists, creating)`);
            if (!DRY_RUN) {
                await db.collection('ttsUserPreferences').doc(userId).set({
                    ...usernameData,
                    username: username,
                    migratedFrom: username,
                    migratedAt: FieldValue.serverTimestamp(),
                    updatedAt: FieldValue.serverTimestamp(),
                });
                await db.collection('ttsUserPreferences').doc(username).delete();
                console.log(`    ✅ Created and cleaned up.`);
            } else {
                console.log(`    [DRY RUN] Would create doc ${userId} and delete doc ${username}.`);
            }
            totalMerged++;
            continue;
        }

        // Both docs exist — merge username data into userId doc (userId fields win)
        const userIdData = userIdDoc.data();

        // Build merged data: start with username doc (legacy full prefs),
        // then overlay userId doc fields (newer, take priority)
        const prefKeys = ['voiceId', 'pitch', 'speed', 'emotion', 'languageBoost', 'englishNormalization', 'emoteMode'];

        const mergedFields = {};
        let fieldsToMerge = 0;

        for (const key of prefKeys) {
            const usernameVal = usernameData[key];
            const userIdVal = userIdData[key];

            if (usernameVal !== undefined && userIdVal === undefined) {
                // Username doc has this field, userId doc doesn't — merge it in
                mergedFields[key] = usernameVal;
                fieldsToMerge++;
            }
        }

        if (fieldsToMerge === 0) {
            console.log(`    ○ "${username}" (${userId}): userId doc already has all fields. Deleting legacy doc.`);
            if (!DRY_RUN) {
                await db.collection('ttsUserPreferences').doc(username).delete();
                console.log(`    ✅ Deleted legacy doc.`);
            } else {
                console.log(`    [DRY RUN] Would delete legacy doc ${username}.`);
            }
            totalMerged++;
            continue;
        }

        console.log(`    ✓ "${username}" (${userId}): Merging ${fieldsToMerge} fields from username doc: ${Object.keys(mergedFields).join(', ')}`);

        // Show what's being merged
        for (const [key, val] of Object.entries(mergedFields)) {
            console.log(`      + ${key}: ${val}`);
        }

        if (!DRY_RUN) {
            await db.collection('ttsUserPreferences').doc(userId).set({
                ...mergedFields,
                updatedAt: FieldValue.serverTimestamp(),
            }, { merge: true });
            await db.collection('ttsUserPreferences').doc(username).delete();
            console.log(`    ✅ Merged and cleaned up.`);
        } else {
            console.log(`    [DRY RUN] Would merge ${fieldsToMerge} fields into ${userId} and delete ${username}.`);
        }
        totalMerged++;
    }

    console.log(`\nMerge complete: ${totalMerged} processed, ${totalSkipped} skipped.`);
}

async function mergeChannelPreferences() {
    console.log('\n=== Checking Per-Channel User Preferences ===\n');
    const snapshot = await db.collection('ttsChannelConfigs').get();
    let totalMerged = 0;
    let totalSkipped = 0;

    for (const doc of snapshot.docs) {
        const channelName = doc.id;
        const data = doc.data();
        const userPreferences = data.userPreferences;

        if (!userPreferences || Object.keys(userPreferences).length === 0) {
            continue;
        }

        // Find remaining username-keyed entries
        const usernameKeys = Object.keys(userPreferences).filter(k => !isUserId(k));

        if (usernameKeys.length === 0) {
            continue;
        }

        console.log(`  [${channelName}] Found ${usernameKeys.length} remaining username-keyed entries: ${usernameKeys.join(', ')}`);

        const usernameToId = await resolveUsernamestoIds(usernameKeys);

        const updates = {};
        const deletes = {};

        for (const username of usernameKeys) {
            const userId = usernameToId.get(username);
            if (!userId) {
                console.log(`    ⚠ Could not resolve "${username}". Skipping.`);
                totalSkipped++;
                continue;
            }

            const usernamePrefs = userPreferences[username];
            const userIdPrefs = userPreferences[userId];

            if (!userIdPrefs) {
                // No userId entry — simple migration
                console.log(`    ✓ "${username}" → ${userId} (creating)`);
                updates[`userPreferences.${userId}`] = usernamePrefs;
            } else {
                // Both exist — merge (username data fills gaps in userId data)
                const merged = { ...usernamePrefs, ...userIdPrefs };
                console.log(`    ✓ "${username}" → ${userId} (merging)`);
                updates[`userPreferences.${userId}`] = merged;
            }

            deletes[`userPreferences.${username}`] = FieldValue.delete();
            totalMerged++;
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
                console.log(`    ✅ Merged ${Object.keys(updates).length} entries.`);
            }
        }
    }

    console.log(`\nPer-channel merge: ${totalMerged} processed, ${totalSkipped} skipped.`);
}

async function main() {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  TTS Preferences Merge: Fix Skipped Users`);
    console.log(`  Mode: ${DRY_RUN ? '🔍 DRY RUN (no changes)' : '🔥 EXECUTE (writing changes!)'}`);
    console.log(`${'='.repeat(60)}\n`);

    if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
        console.error('ERROR: TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET environment variables are required.');
        process.exit(1);
    }

    try {
        await mergeGlobalPreferences();
        await mergeChannelPreferences();

        console.log(`\n${'='.repeat(60)}`);
        if (DRY_RUN) {
            console.log('  Dry run complete. Run with --execute to apply changes.');
        } else {
            console.log('  Merge complete!');
        }
        console.log(`${'='.repeat(60)}\n`);
    } catch (error) {
        console.error('Merge failed:', error);
        process.exit(1);
    }
}

main();
