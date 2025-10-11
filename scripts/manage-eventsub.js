#!/usr/bin/env node

// scripts/manage-eventsub.js
// Utility script to manage Twitch EventSub subscriptions for TTS event announcements

import {
    getEventSubSubscriptions,
    deleteEventSubSubscription,
    subscribeChannelToTtsEvents,
    subscribeAllManagedChannelsToTtsEvents
} from '../src/components/twitch/twitchSubs.js';
import { getUsersByLogin } from '../src/components/twitch/helixClient.js';
import { initializeHelixClient } from '../src/components/twitch/helixClient.js';
import { initializeChannelManager } from '../src/components/twitch/channelManager.js';
import config from '../src/config/index.js';
import logger from '../src/lib/logger.js';

/**
 * List all EventSub subscriptions
 */
async function listSubscriptions() {
    logger.info('Fetching all EventSub subscriptions...');
    const result = await getEventSubSubscriptions();

    if (result.success) {
        console.log('\n=== EventSub Subscriptions ===');
        if (result.data.data.length === 0) {
            console.log('No subscriptions found.');
        } else {
            result.data.data.forEach((sub, index) => {
                console.log(`${index + 1}. ID: ${sub.id}`);
                console.log(`   Type: ${sub.type}`);
                console.log(`   Status: ${sub.status}`);
                console.log(`   Condition: ${JSON.stringify(sub.condition)}`);
                console.log(`   Created: ${sub.created_at}`);
                console.log('');
            });
            console.log(`Total: ${result.data.data.length} subscriptions`);
        }
    } else {
        logger.error({ error: result.error }, 'Failed to fetch subscriptions');
    }
}

/**
 * Subscribe a specific channel to TTS events
 */
async function subscribeChannel(channelName) {
    logger.info({ channelName }, 'Subscribing channel to TTS events...');

    // Get the broadcaster ID
    const userData = await getUsersByLogin([channelName]);
    if (!userData || userData.length === 0) {
        console.error(`Could not find user: ${channelName}`);
        return;
    }

    const userId = userData[0].id;
    logger.info({ channelName, userId }, `Found user ID for ${channelName}`);

    // Subscribe to all TTS events
    const result = await subscribeChannelToTtsEvents(userId);

    console.log('\n=== Subscription Results ===');
    console.log(`Channel: ${channelName} (${userId})`);
    console.log(`Successful: ${result.successful.length}`);
    console.log(`Failed: ${result.failed.length}`);

    if (result.successful.length > 0) {
        console.log('\nSuccessful subscriptions:');
        result.successful.forEach(type => console.log(`  ✓ ${type}`));
    }

    if (result.failed.length > 0) {
        console.log('\nFailed subscriptions:');
        result.failed.forEach(fail => {
            console.log(`  ✗ ${fail.type}: ${fail.error}`);
        });
    }
}

/**
 * Subscribe all managed channels to TTS events
 */
async function subscribeAll() {
    logger.info('Subscribing all managed channels to TTS events...');
    const result = await subscribeAllManagedChannelsToTtsEvents();

    console.log('\n=== Batch Subscription Results ===');
    console.log(`Total channels: ${result.total}`);
    console.log(`Successful: ${result.successful.length}`);
    console.log(`Failed: ${result.failed.length}`);

    if (result.successful.length > 0) {
        console.log('\nSuccessful channels:');
        result.successful.forEach(sub => {
            console.log(`- ${sub.channel} (${sub.userId})`);
            console.log(`  Events: ${sub.events.join(', ')}`);
        });
    }

    if (result.failed.length > 0) {
        console.log('\nFailed channels:');
        result.failed.forEach(fail => {
            console.log(`- ${fail.channel}: ${fail.error}`);
        });
    }
}

/**
 * Delete a specific EventSub subscription by ID
 */
async function deleteSubscription(subscriptionId) {
    logger.info({ subscriptionId }, 'Deleting EventSub subscription...');
    const result = await deleteEventSubSubscription(subscriptionId);

    if (result.success) {
        console.log(`✓ Successfully deleted subscription: ${subscriptionId}`);
    } else {
        logger.error({ error: result.error }, 'Failed to delete subscription');
    }
}

/**
 * Delete all EventSub subscriptions
 */
async function deleteAll() {
    logger.info('Deleting all EventSub subscriptions...');
    const listResult = await getEventSubSubscriptions();

    if (!listResult.success || !listResult.data || !listResult.data.data) {
        logger.error({ error: listResult.error }, 'Failed to fetch subscriptions for deletion');
        return;
    }

    if (listResult.data.data.length === 0) {
        console.log('No subscriptions to delete.');
        return;
    }

    console.log(`Found ${listResult.data.data.length} subscriptions to delete...`);

    for (const sub of listResult.data.data) {
        const result = await deleteEventSubSubscription(sub.id);
        if (result.success) {
            console.log(`✓ Deleted: ${sub.id} (${sub.type})`);
        } else {
            console.log(`✗ Failed to delete: ${sub.id} - ${result.error}`);
        }
    }
}

/**
 * Main entry point
 */
async function main() {
    const command = process.argv[2];
    const arg = process.argv[3];

    if (!command) {
        console.log(`
Usage: node scripts/manage-eventsub.js <command> [args]

Commands:
  list                       - List all EventSub subscriptions
  subscribe <channel_name>   - Subscribe a specific channel to TTS events
  subscribe-all              - Subscribe all managed channels to TTS events
  delete <subscription_id>   - Delete a specific subscription by ID
  delete-all                 - Delete all subscriptions

Examples:
  node scripts/manage-eventsub.js list
  node scripts/manage-eventsub.js subscribe parfaitfair
  node scripts/manage-eventsub.js subscribe-all
  node scripts/manage-eventsub.js delete abcd-1234-efgh-5678
  node scripts/manage-eventsub.js delete-all

Event Types Subscribed:
  - channel.subscribe             (new subscriptions)
  - channel.subscription.message  (resubs with messages)
  - channel.subscription.gift     (gift subs)
  - channel.cheer                 (bits cheers)
  - channel.raid                  (incoming raids)

Note: Ensure PUBLIC_URL and TWITCH_EVENTSUB_SECRET are set in your .env file
before running subscription commands.
        `);
        process.exit(1);
    }

    try {
        // Initialize required services
        logger.info('Initializing services...');
        await initializeHelixClient();
        await initializeChannelManager();

        switch (command.toLowerCase()) {
            case 'list':
                await listSubscriptions();
                break;

            case 'subscribe':
                if (!arg) {
                    console.error('Please provide a channel name');
                    process.exit(1);
                }
                await subscribeChannel(arg.toLowerCase());
                break;

            case 'subscribe-all':
                await subscribeAll();
                break;

            case 'delete':
                if (!arg) {
                    console.error('Please provide a subscription ID to delete');
                    process.exit(1);
                }
                await deleteSubscription(arg);
                break;

            case 'delete-all':
                await deleteAll();
                break;

            default:
                console.error(`Unknown command: ${command}`);
                process.exit(1);
        }

        logger.info('Command completed successfully');
        process.exit(0);

    } catch (error) {
        logger.error({ err: error }, 'Script failed');
        process.exit(1);
    }
}

main();
