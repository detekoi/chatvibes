// scripts/backfill_emotion_to_style.js
// One-time backfill that retires the stored `emotion` field. The emotion was a setting
// of the old provider. Gemini TTS takes one style text, so each stored emotion becomes
// the style words that the bot already sends for it (STYLE_PRESETS in tts-config.json).
//
// The bot still reads a stored emotion (styleBuilder.buildStyle), so nothing breaks
// before this runs. After it ran, the read of the emotion can be removed.
//
// What it writes:
//   ttsChannelConfigs/<id>     style, emotion (removed),
//                              userPreferences.<userId>.style and .emotion (legacy viewer settings)
//   ttsUserPreferences/<id>    style, emotion (removed)
// The old value is kept beside the new one as legacyEmotion.
//
// The rules, for one record:
//   - A style that is not empty already replaces the emotion. Only the emotion is removed.
//   - A channel with `neutral`, `auto` or an unknown value gets no style.
//   - A viewer with `neutral` gets the style "in a neutral tone" (STYLE.NEUTRAL). That
//     viewer has a plain voice today in a channel that has a style, and a viewer with no
//     style gets the style of the channel.
//
// A write fails when the document changed after the script read it. The script reports
// the document, and a second run converts it. A second run skips every document that
// has no emotion.
//
// Usage:  node scripts/backfill_emotion_to_style.js            dry run, prints every change
//         node scripts/backfill_emotion_to_style.js --apply    writes the changes
//         Uses Application Default Credentials.

import { Firestore, FieldValue } from '@google-cloud/firestore';
import { styleForEmotion, sanitizeStyle } from '../src/components/tts/styleBuilder.js';

const APPLY = process.argv.includes('--apply');
const firestore = new Firestore({ projectId: process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'chatvibestts' });

const stats = { channels: 0, viewers: 0, legacyViewers: 0, changedMeanwhile: 0, byChange: new Map() };
const count = key => stats.byChange.set(key, (stats.byChange.get(key) || 0) + 1);

/**
 * The change for one record that holds an emotion, or null when it holds none.
 * @param {object} record A channel document, a viewer document, or a legacy viewer entry
 * @param {boolean} viewer
 * @param {string} prefix '' for a document, 'userPreferences.<id>.' for a legacy entry
 * @returns {{update: object, note: string}|null}
 */
function emotionChange(record, viewer, prefix = '') {
    if (!record || typeof record !== 'object' || !('emotion' in record)) return null;
    const { emotion } = record;
    const update = { [`${prefix}emotion`]: FieldValue.delete() };
    if (emotion !== null && emotion !== undefined && emotion !== '') update[`${prefix}legacyEmotion`] = emotion;

    const who = viewer ? 'viewer' : 'channel';
    if (sanitizeStyle(record.style)) {
        count(`${who}: has a style, emotion removed`);
        return { update, note: `${prefix}emotion ${emotion} removed (style "${record.style}" stays)` };
    }
    const words = styleForEmotion(emotion, { viewer });
    if (!words) {
        count(`${who}: ${emotion} -> no style`);
        return { update, note: `${prefix}emotion ${emotion} removed (no style)` };
    }
    update[`${prefix}style`] = words;
    count(`${who}: ${String(emotion).toLowerCase()} -> "${words}"`);
    return { update, note: `${prefix}emotion ${emotion} -> style "${words}"` };
}

/** Write one update, unless the document changed after the read. */
async function write(doc, update, label) {
    if (!APPLY) return;
    try {
        // update() treats a dotted key as a path.
        await doc.ref.update(update, { lastUpdateTime: doc.updateTime });
    } catch (error) {
        // 9 is FAILED_PRECONDITION: somebody saved the document in the meantime.
        if (error.code !== 9) throw error;
        stats.changedMeanwhile++;
        console.log(`  ${label} changed during the run and was not written. Run the script again.`);
    }
}

async function backfillChannels() {
    const snapshot = await firestore.collection('ttsChannelConfigs').get();
    for (const doc of snapshot.docs) {
        const data = doc.data();
        const update = {};
        const notes = [];

        const channel = emotionChange(data, false);
        if (channel) {
            Object.assign(update, channel.update);
            notes.push(channel.note);
        }
        for (const [userId, prefs] of Object.entries(data.userPreferences || {})) {
            const viewer = emotionChange(prefs, true, `userPreferences.${userId}.`);
            if (!viewer) continue;
            Object.assign(update, viewer.update);
            notes.push(viewer.note);
            stats.legacyViewers++;
        }

        if (notes.length === 0) continue;
        stats.channels++;
        console.log(`channel ${doc.id}: ${notes.join('; ')}`);
        await write(doc, update, `channel ${doc.id}`);
    }
    return snapshot.size;
}

async function backfillViewers() {
    const snapshot = await firestore.collection('ttsUserPreferences').get();
    for (const doc of snapshot.docs) {
        const change = emotionChange(doc.data(), true);
        if (!change) continue;
        stats.viewers++;
        console.log(`viewer ${doc.id}: ${change.note}`);
        await write(doc, change.update, `viewer ${doc.id}`);
    }
    return snapshot.size;
}

async function main() {
    console.log(APPLY ? 'APPLY: writing changes.\n' : 'Dry run: nothing is written. Add --apply to write.\n');
    const channelDocs = await backfillChannels();
    const viewerDocs = await backfillViewers();
    console.log(`\n${stats.channels} of ${channelDocs} channel documents and ${stats.viewers} of ${viewerDocs} viewer documents ${APPLY ? 'changed' : 'need a change'}.`);
    console.log(`${stats.legacyViewers} legacy viewer settings inside channel documents.`);
    for (const [change, total] of [...stats.byChange].sort((a, b) => b[1] - a[1])) console.log(`  ${String(total).padStart(5)}  ${change}`);
    if (stats.changedMeanwhile) console.log(`\n${stats.changedMeanwhile} documents changed during the run. Run the script again.`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
