#!/usr/bin/env node
// Quick script to check the size and sample documents from dedup collections

import { Firestore, Timestamp } from '@google-cloud/firestore';

const PROJECT_ID = process.env.GCP_PROJECT || 'chatvibestts';
const firestore = new Firestore({ projectId: PROJECT_ID });

async function checkCollection(collectionName) {
    console.log(`\n📊 Checking '${collectionName}'...`);

    const collection = firestore.collection(collectionName);

    // Get total count (this might be slow for large collections)
    const snapshot = await collection.count().get();
    const count = snapshot.data().count;

    console.log(`   Total documents: ${count.toLocaleString()}`);

    if (count > 0) {
        // Get a few sample documents
        const samples = await collection.limit(5).get();
        console.log(`   Sample documents:`);

        samples.forEach((doc, idx) => {
            const data = doc.data();
            console.log(`   [${idx + 1}] ID: ${doc.id}`);
            console.log(`       createdAtMs: ${data.createdAtMs ? new Date(data.createdAtMs).toISOString() : 'N/A'}`);

            if (data.expireAt instanceof Timestamp) {
                console.log(`       expireAt: ${data.expireAt.toDate().toISOString()} (Timestamp)`);
                console.log(`       expired: ${data.expireAt.toMillis() <= Date.now() ? 'YES ⏰' : 'NO'}`);
            } else if (typeof data.expireAtMs === 'number') {
                console.log(`       expireAtMs: ${new Date(data.expireAtMs).toISOString()} (old format)`);
                console.log(`       expired: ${data.expireAtMs <= Date.now() ? 'YES ⏰' : 'NO'}`);
            } else {
                console.log(`       expireAt: MISSING ⚠️`);
            }
        });
    }

    return count;
}

async function main() {
    console.log('🔍 Checking Firestore deduplication collection stats...\n');

    try {
        const eventSubCount = await checkCollection('processedEventSubMessages');
        const ttsEventsCount = await checkCollection('processedTtsEvents');

        console.log(`\n📈 Summary:`);
        console.log(`   processedEventSubMessages: ${eventSubCount.toLocaleString()} documents`);
        console.log(`   processedTtsEvents: ${ttsEventsCount.toLocaleString()} documents`);
        console.log(`   Total: ${(eventSubCount + ttsEventsCount).toLocaleString()} documents`);

    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

main();
