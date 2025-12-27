#!/usr/bin/env node
// Script to manually delete expired deduplication documents from Firestore
// This helps clean up the existing large collections before TTL policies take effect

import { Firestore, Timestamp } from '@google-cloud/firestore';

const firestore = new Firestore();
const BATCH_SIZE = 500; // Firestore batch limit

/**
 * Delete expired documents from a collection in batches
 */
async function cleanupExpiredDocuments(collectionName) {
    console.log(`\n🧹 Cleaning up expired documents from '${collectionName}'...`);

    const collection = firestore.collection(collectionName);
    const now = Date.now();
    let totalDeleted = 0;
    let hasMore = true;

    while (hasMore) {
        const batch = firestore.batch();
        let batchCount = 0;

        // Query for expired documents (both old and new format)
        const snapshot = await collection
            .limit(BATCH_SIZE)
            .get();

        if (snapshot.empty) {
            hasMore = false;
            break;
        }

        for (const doc of snapshot.docs) {
            const data = doc.data();
            let isExpired = false;

            // Check new format (Timestamp)
            if (data.expireAt instanceof Timestamp) {
                isExpired = data.expireAt.toMillis() <= now;
            }
            // Check old format (milliseconds number)
            else if (typeof data.expireAtMs === 'number') {
                isExpired = data.expireAtMs <= now;
            }
            // If no expiry field, consider it old and delete
            else if (!data.expireAt && !data.expireAtMs) {
                isExpired = true;
            }

            if (isExpired) {
                batch.delete(doc.ref);
                batchCount++;
            }
        }

        if (batchCount > 0) {
            await batch.commit();
            totalDeleted += batchCount;
            console.log(`  Deleted ${batchCount} expired documents (total: ${totalDeleted})`);
        }

        // If we got fewer docs than the batch size, we're done
        if (snapshot.size < BATCH_SIZE) {
            hasMore = false;
        }

        // Small delay to avoid overwhelming Firestore
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log(`✓ Cleanup complete for '${collectionName}': ${totalDeleted} documents deleted`);
    return totalDeleted;
}

/**
 * Main cleanup function
 */
async function main() {
    console.log('🚀 Starting Firestore deduplication cleanup...');
    console.log(`   Current time: ${new Date().toISOString()}\n`);

    try {
        const eventSubDeleted = await cleanupExpiredDocuments('processedEventSubMessages');
        const ttsEventsDeleted = await cleanupExpiredDocuments('processedTtsEvents');

        const total = eventSubDeleted + ttsEventsDeleted;

        console.log('\n✅ Cleanup Summary:');
        console.log(`   processedEventSubMessages: ${eventSubDeleted} documents deleted`);
        console.log(`   processedTtsEvents: ${ttsEventsDeleted} documents deleted`);
        console.log(`   Total: ${total} documents deleted`);

        if (total === 0) {
            console.log('\n✨ No expired documents found - collections are clean!');
        } else {
            console.log('\n💡 Tip: Run the enable-firestore-ttl.sh script to enable automatic cleanup in the future.');
        }
    } catch (error) {
        console.error('❌ Error during cleanup:', error);
        process.exit(1);
    }
}

main();
