#!/usr/bin/env node
/**
 * migrate_tts_configs_to_userid.js
 *
 * One-time migration script to convert ttsChannelConfigs from username-keyed
 * documents to Twitch User ID-keyed documents.
 *
 * Usage:
 *   node scripts/migrate_tts_configs_to_userid.js              # Dry-run (default)
 *   node scripts/migrate_tts_configs_to_userid.js --execute    # Actually write changes
 */

import { Firestore, FieldValue } from '@google-cloud/firestore';
import dotenv from 'dotenv';

dotenv.config();

const db = new Firestore();
const DRY_RUN = !process.argv.includes('--execute');

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

function isUserId(key) {
    return /^\d+$/.test(key);
}

async function main() {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  TTS Configs Migration: Username -> User ID`);
    console.log(`  Mode: ${DRY_RUN ? '🔍 DRY RUN (no changes)' : '🔥 EXECUTE (writing changes!)'}`);
    console.log(`${'='.repeat(60)}\n`);

    if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
        console.error('ERROR: TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET environment variables are required.');
        process.exit(1);
    }

    try {
        const snapshot = await db.collection('ttsChannelConfigs').get();
        let totalMigrated = 0;
        let totalSkipped = 0;

        const usernameDocs = snapshot.docs.filter(doc => !isUserId(doc.id));

        if (usernameDocs.length === 0) {
            console.log('All ttsChannelConfigs documents already keyed by userId.');
            return;
        }

        console.log(`Found ${usernameDocs.length} username-keyed documents.\n`);

        const usernames = usernameDocs.map(d => d.id);
        const usernameToId = await resolveUsernamestoIds(usernames);

        for (const doc of usernameDocs) {
            const username = doc.id;
            const userId = usernameToId.get(username.toLowerCase());

            if (!userId) {
                console.log(`  ⚠ Could not resolve "${username}". Skipping.`);
                totalSkipped++;
                continue;
            }

            const existingDoc = await db.collection('ttsChannelConfigs').doc(userId).get();
            if (existingDoc.exists) {
                console.log(`  ⚠ userId doc ${userId} already exists for "${username}". Skipping.`);
                totalSkipped++;
                continue;
            }

            const data = doc.data();
            console.log(`  ✓ "${username}" -> ${userId}`);

            if (DRY_RUN) {
                console.log(`    [DRY RUN] Would create doc ${userId} and delete doc ${username}.`);
            } else {
                await db.collection('ttsChannelConfigs').doc(userId).set({
                    ...data,
                    channelName: username,
                    migratedFrom: username,
                    migratedAt: FieldValue.serverTimestamp(),
                });
                await db.collection('ttsChannelConfigs').doc(username).delete();
                console.log(`    ✅ Migrated.`);
            }
            totalMigrated++;
        }

        console.log(`\nMigration: ${totalMigrated} migrated, ${totalSkipped} skipped.`);
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
