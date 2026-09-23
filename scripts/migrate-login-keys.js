#!/usr/bin/env node

/**
 * scripts/migrate-login-keys.js
 *
 * Moves the remaining login-keyed TTS data to Twitch user ID keys. The bot and
 * the web UI read ID keys only, so anything still keyed by login is invisible
 * to them until this runs.
 *
 *   ttsUserPreferences/<login>                 → ttsUserPreferences/<userId>
 *   ttsChannelConfigs/<id>.userPreferences.<login> → .userPreferences.<userId>
 *   ttsChannelConfigs/<login>                  → ttsChannelConfigs/<broadcasterId>
 *
 * The earlier one-shot migrations skipped any login whose ID key already
 * existed, which is how these were left behind. This one merges instead: a
 * field already under the ID key wins, a field only under the login fills the
 * gap, and the login-keyed original is then deleted. Logins Twitch cannot
 * resolve (deleted or banned accounts) are reported and left alone.
 *
 * managedChannels documents are only reported: a document without a
 * twitchUserId needs repairing with scripts/add-streamer.js, not a copy.
 *
 * Usage:
 *   node scripts/migrate-login-keys.js [--apply]
 *
 * Without --apply the script only reports what it would do. Idempotent.
 * Needs TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET, and GOOGLE_CLOUD_PROJECT
 * pointing at the TTS project (chatvibestts), from the environment or .env.
 */

import { Firestore, FieldPath, FieldValue } from '@google-cloud/firestore';
import dotenv from 'dotenv';

dotenv.config();

const APPLY = process.argv.includes('--apply');
const db = new Firestore();

const USER_PREFS = 'ttsUserPreferences';
const CHANNEL_CONFIGS = 'ttsChannelConfigs';
const MANAGED_CHANNELS = 'managedChannels';

const isId = key => /^\d+$/.test(key);

async function getAppToken() {
    const resp = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: process.env.TWITCH_CLIENT_ID,
            client_secret: process.env.TWITCH_CLIENT_SECRET,
            grant_type: 'client_credentials',
        }),
    });
    if (!resp.ok) throw new Error(`Twitch app token request failed: ${resp.status}`);
    return (await resp.json()).access_token;
}

/** lowercase login → user ID, for the logins Twitch still knows. */
async function resolveLogins(logins) {
    const ids = new Map();
    if (logins.length === 0) return ids;
    const token = await getAppToken();
    for (let i = 0; i < logins.length; i += 100) {
        const params = new URLSearchParams();
        logins.slice(i, i + 100).forEach(login => params.append('login', login));
        const resp = await fetch(`https://api.twitch.tv/helix/users?${params}`, {
            headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` },
        });
        if (!resp.ok) throw new Error(`Helix users lookup failed: ${resp.status} ${await resp.text()}`);
        for (const user of (await resp.json()).data) ids.set(user.login.toLowerCase(), user.id);
    }
    return ids;
}

const isMap = value => value !== null && typeof value === 'object' && value.constructor === Object;

/**
 * Fields of `from` that `into` lacks, for a merge:true write; `into` always wins.
 * Map fields present on both sides (userPreferences, ignoredUserIds, …) are merged
 * one level down, so a login doc's entries are not dropped just because the ID
 * doc already has the map.
 */
function missingFields(from, into) {
    const fill = {};
    for (const [key, value] of Object.entries(from)) {
        if (!(key in into)) {
            fill[key] = value;
        } else if (isMap(value) && isMap(into[key])) {
            const nested = Object.fromEntries(Object.entries(value).filter(([k]) => !(k in into[key])));
            if (Object.keys(nested).length) fill[key] = nested;
        }
    }
    return fill;
}

function describe(fields) {
    const keys = Object.keys(fields);
    return keys.length ? keys.join(', ') : 'nothing new';
}

async function migrateUserPreferenceDocs(ids, report) {
    const snapshot = await db.collection(USER_PREFS).get();
    for (const doc of snapshot.docs.filter(d => !isId(d.id))) {
        const login = doc.id.toLowerCase();
        const userId = ids.get(login);
        if (!userId) {
            report.unresolved.push(`${USER_PREFS}/${doc.id}`);
            continue;
        }
        const target = db.collection(USER_PREFS).doc(userId);
        const existing = (await target.get()).data() || {};
        const fill = missingFields(doc.data(), existing);
        delete fill.username;
        console.log(`  ${USER_PREFS}/${doc.id} → ${userId}: copy ${describe(fill)}`);
        if (APPLY) {
            const batch = db.batch();
            batch.set(target, { ...fill, username: login, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
            batch.delete(doc.ref);
            await batch.commit();
        }
        report.moved++;
    }
}

async function migrateChannelUserPreferences(ids, report) {
    const snapshot = await db.collection(CHANNEL_CONFIGS).get();
    for (const doc of snapshot.docs.filter(d => isId(d.id))) {
        const prefs = doc.data().userPreferences || {};
        const logins = Object.keys(prefs).filter(key => !isId(key));
        if (logins.length === 0) continue;

        const updates = [];
        for (const key of logins) {
            const userId = ids.get(key.toLowerCase());
            if (!userId) {
                report.unresolved.push(`${CHANNEL_CONFIGS}/${doc.id}.userPreferences.${key}`);
                continue;
            }
            const fill = missingFields(prefs[key] || {}, prefs[userId] || {});
            console.log(`  ${CHANNEL_CONFIGS}/${doc.id}.userPreferences.${key} → ${userId}: copy ${describe(fill)}`);
            for (const [field, value] of Object.entries(fill)) {
                updates.push(new FieldPath('userPreferences', userId, field), value);
            }
            updates.push(new FieldPath('userPreferences', key), FieldValue.delete());
            report.moved++;
        }
        if (APPLY && updates.length) await doc.ref.update(...updates);
    }
}

async function migrateChannelConfigDocs(ids, report) {
    const snapshot = await db.collection(CHANNEL_CONFIGS).get();
    for (const doc of snapshot.docs.filter(d => !isId(d.id))) {
        const login = doc.id.toLowerCase();
        const broadcasterId = ids.get(login);
        if (!broadcasterId) {
            report.unresolved.push(`${CHANNEL_CONFIGS}/${doc.id}`);
            continue;
        }
        const target = db.collection(CHANNEL_CONFIGS).doc(broadcasterId);
        const targetSnap = await target.get();
        const fill = missingFields(doc.data(), targetSnap.data() || {});
        console.log(`  ${CHANNEL_CONFIGS}/${doc.id} → ${broadcasterId}${targetSnap.exists ? '' : ' (new)'}: copy ${describe(fill)}`);
        if (APPLY) {
            const batch = db.batch();
            batch.set(target, fill, { merge: true });
            batch.delete(doc.ref);
            await batch.commit();
        }
        report.moved++;
    }
}

async function reportManagedChannels(report) {
    const snapshot = await db.collection(MANAGED_CHANNELS).get();
    for (const doc of snapshot.docs) {
        if (!isId(doc.id) || !doc.data().twitchUserId) {
            report.managedChannels.push(`${MANAGED_CHANNELS}/${doc.id} (channelName ${doc.data().channelName ?? '-'}, twitchUserId ${doc.data().twitchUserId ?? 'missing'})`);
        }
    }
}

async function collectLogins() {
    const logins = new Set();
    const [prefs, configs] = await Promise.all([
        db.collection(USER_PREFS).get(),
        db.collection(CHANNEL_CONFIGS).get(),
    ]);
    prefs.docs.filter(d => !isId(d.id)).forEach(d => logins.add(d.id.toLowerCase()));
    configs.docs.forEach(d => {
        if (!isId(d.id)) logins.add(d.id.toLowerCase());
        Object.keys(d.data().userPreferences || {}).filter(k => !isId(k)).forEach(k => logins.add(k.toLowerCase()));
    });
    return [...logins];
}

async function main() {
    if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) {
        console.error('TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET are required.');
        process.exit(1);
    }
    console.log(`${APPLY ? 'APPLYING' : 'Dry run'} against ${process.env.GOOGLE_CLOUD_PROJECT || 'the default project'}\n`);

    const ids = await resolveLogins(await collectLogins());
    const report = { moved: 0, unresolved: [], managedChannels: [] };

    await migrateUserPreferenceDocs(ids, report);
    // Config docs first: their userPreferences land on the ID doc still keyed by
    // login, and the next pass moves those entries. A dry run cannot show that
    // second hop, so it reports those entries under the config doc only.
    await migrateChannelConfigDocs(ids, report);
    await migrateChannelUserPreferences(ids, report);
    await reportManagedChannels(report);

    console.log(`\n${report.moved} ${APPLY ? 'moved' : 'to move'}.`);
    if (report.unresolved.length) {
        console.log(`\nUnresolved logins (left in place; no Twitch account by that name):\n  ${report.unresolved.join('\n  ')}`);
    }
    if (report.managedChannels.length) {
        console.log(`\nmanagedChannels documents to repair by hand:\n  ${report.managedChannels.join('\n  ')}`);
    }
    if (!APPLY) console.log('\nRun with --apply to write.');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
