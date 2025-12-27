#!/usr/bin/env node
// Improved cleanup script that deletes ALL documents (since they're all dedup records)
// Option 1: Delete everything older than 10 minutes
// Option 2: Delete everything (nuclear option)

import { Firestore, Timestamp } from '@google-cloud/firestore';

const PROJECT_ID = process.env.GCP_PROJECT || 'chatvibestts';
const firestore = new Firestore({ projectId: PROJECT_ID });
const BATCH_SIZE = 500;
const TEN_MINUTES_MS = 10 * 60 * 1000;

/**
 * Delete all documents from a collection (or just old ones)
 */
async function cleanupCollection(collectionName, deleteAll = false) {
    console.log(`\n🧹 Cleaning up '${collectionName}'...`);
    console.log(`   Mode: ${deleteAll ? 'DELETE ALL' : 'DELETE EXPIRED ONLY'}`);

    const collection = firestore.collection(collectionName);
    const now = Date.now();
    const cutoffTime = now - TEN_MINUTES_MS; // Anything older than 10 minutes
    let totalDeleted = 0;
    let hasMore = true;

    while (hasMore) {
        const batch = firestore.batch();
        let batchCount = 0;

        // Get a batch of documents
        const snapshot = await collection
            .limit(BATCH_SIZE)
            .get();

        if (snapshot.empty) {
            hasMore = false;
            break;
        }

        for (const doc of snapshot.docs) {
            const data = doc.data();
            let shouldDelete = deleteAll; // If deleteAll mode, always delete

            if (!deleteAll) {
                // Check if document is expired (old format or new format)
                if (data.expireAt instanceof Timestamp) {
                    shouldDelete = data.expireAt.toMillis() <= now;
                } else if (typeof data.expireAtMs === 'number') {
                    shouldDelete = data.expireAtMs <= now;
                } else if (typeof data.createdAtMs === 'number') {
                    // If no expiry but has creation time, check if older than 10 minutes
                    shouldDelete = data.createdAtMs < cutoffTime;
                } else {
                    // No expiry or creation time - delete it
                    shouldDelete = true;
                }
            }

            if (shouldDelete) {
                batch.delete(doc.ref);
                batchCount++;
            }
        }

        if (batchCount > 0) {
            await batch.commit();
            totalDeleted += batchCount;
            console.log(`  Deleted ${batchCount} documents (total: ${totalDeleted})`);
        } else if (!deleteAll) {
            // If we didn't delete anything and we're in selective mode,
            // we might need to keep going to find older documents
            console.log(`  Skipped ${snapshot.size} non-expired documents...`);
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

async function main() {
    const args = process.argv.slice(2);
    const deleteAll = args.includes('--all');

    console.log('🚀 Starting Firestore deduplication cleanup...');
    console.log(`   Current time: ${new Date().toISOString()}`);
    console.log(`   Mode: ${deleteAll ? '⚠️  DELETE ALL (nuclear option)' : 'Delete expired only'}\n`);

    if (deleteAll) {
        console.log('⚠️  WARNING: This will delete ALL documents from both collections!');
        console.log('   This is safe because they are only dedup records with a 10-minute lifetime.');
        console.log('   Press Ctrl+C now to cancel, or wait 5 seconds to continue...\n');
        await new Promise(resolve => setTimeout(resolve, 5000));
    }

    try {
        const eventSubDeleted = await cleanupCollection('processedEventSubMessages', deleteAll);
        const ttsEventsDeleted = await cleanupCollection('processedTtsEvents', deleteAll);

        const total = eventSubDeleted + ttsEventsDeleted;

        console.log('\n✅ Cleanup Summary:');
        console.log(`   processedEventSubMessages: ${eventSubDeleted.toLocaleString()} documents deleted`);
        console.log(`   processedTtsEvents: ${ttsEventsDeleted.toLocaleString()} documents deleted`);
        console.log(`   Total: ${total.toLocaleString()} documents deleted`);

        if (total === 0) {
            console.log('\n✨ No documents deleted - collections may already be clean!');
            console.log('   Run with --all to delete everything (safe for dedup collections)');
        }
    } catch (error) {
        console.error('❌ Error during cleanup:', error);
        process.exit(1);
    }
}

main();
