// cleanup-eventsub.js
// Script to list and clean up old EventSub subscriptions

import 'dotenv/config';
import { initializeHelixClient } from '../src/components/twitch/helixClient.js';
import { getEventSubSubscriptions, deleteEventSubSubscription } from '../src/components/twitch/twitchSubs.js';


const CURRENT_URL = 'https://chatvibes-tts-service-906125386407.us-central1.run.app/twitch/event';
const OLD_URL = 'https://chatvibes-tts-service-h7kj56ct4q-uc.a.run.app/twitch/event';

async function cleanupSubscriptions() {
    try {
        console.log('\n=== EventSub Subscription Cleanup ===\n');

        // Initialize Helix client
        await initializeHelixClient();

        // Get all subscriptions
        console.log('Fetching all EventSub subscriptions...');
        const result = await getEventSubSubscriptions();

        if (!result.success) {
            console.error('❌ Failed to fetch subscriptions');
            return;
        }

        const subscriptions = result.data?.data || [];
        console.log(`\nFound ${subscriptions.length} total subscriptions\n`);

        // Separate by URL
        const currentUrlSubs = [];
        const oldUrlSubs = [];
        const otherUrlSubs = [];

        for (const sub of subscriptions) {
            const callback = sub.transport?.callback;
            if (callback === CURRENT_URL) {
                currentUrlSubs.push(sub);
            } else if (callback === OLD_URL) {
                oldUrlSubs.push(sub);
            } else {
                otherUrlSubs.push(sub);
            }
        }

        console.log(`✅ Current URL subscriptions: ${currentUrlSubs.length}`);
        console.log(`⚠️  Old URL subscriptions: ${oldUrlSubs.length}`);
        console.log(`❓ Other URL subscriptions: ${otherUrlSubs.length}\n`);

        // Track deletion results
        let successCount = 0;
        let failureCount = 0;

        // Show details of old URL subscriptions
        if (oldUrlSubs.length > 0) {
            console.log('\n--- Subscriptions to DELETE (old URL) ---');
            for (const sub of oldUrlSubs) {
                console.log(`\nID: ${sub.id}`);
                console.log(`Type: ${sub.type}`);
                console.log(`Status: ${sub.status}`);
                console.log(`Broadcaster ID: ${sub.condition?.broadcaster_user_id || 'N/A'}`);
                console.log(`User ID: ${sub.condition?.user_id || 'N/A'}`);
            }

            console.log('\n\n⚠️  About to delete', oldUrlSubs.length, 'old URL subscriptions');
            console.log('Deleting in 3 seconds... (Press Ctrl+C to cancel)');

            await new Promise(resolve => setTimeout(resolve, 3000));

            // Delete old subscriptions
            for (const sub of oldUrlSubs) {
                console.log(`\nDeleting subscription ${sub.id} (${sub.type})...`);
                const deleteResult = await deleteEventSubSubscription(sub.id);
                if (deleteResult.success) {
                    console.log('  ✅ Deleted successfully');
                    successCount++;
                } else {
                    console.log('  ❌ Failed to delete:', deleteResult.error);
                    failureCount++;
                }
            }

            if (failureCount === 0) {
                console.log(`\n✅ Cleanup complete! Deleted ${successCount} old subscriptions`);
            } else {
                console.log(`\n⚠️  Cleanup completed with errors: ${successCount} succeeded, ${failureCount} failed`);
            }
        } else {
            console.log('\n✅ No old URL subscriptions to delete');
        }

        // Show other URLs for reference
        if (otherUrlSubs.length > 0) {
            console.log('\n--- Other URL subscriptions (NOT deleted) ---');
            for (const sub of otherUrlSubs) {
                console.log(`\nID: ${sub.id}`);
                console.log(`Type: ${sub.type}`);
                console.log(`Callback: ${sub.transport?.callback}`);
            }
        }

        console.log('\n=== Final Summary ===');
        console.log(`Kept: ${currentUrlSubs.length} subscriptions on current URL`);
        if (oldUrlSubs.length > 0) {
            console.log(`Deleted: ${successCount} subscriptions on old URL${failureCount > 0 ? ` (${failureCount} failed)` : ''}`);
        } else {
            console.log(`Deleted: 0 subscriptions on old URL`);
        }
        console.log(`Ignored: ${otherUrlSubs.length} subscriptions on other URLs\n`);

    } catch (error) {
        console.error('❌ Error during cleanup:', error.message);
        console.error('Stack:', error.stack);
    }
}

cleanupSubscriptions();
