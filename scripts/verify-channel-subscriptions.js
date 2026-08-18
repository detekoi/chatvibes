#!/usr/bin/env node

// scripts/verify-channel-subscriptions.js
// Verifies that all active managed channels have required EventSub subscriptions

import { getEventSubSubscriptions } from '../src/components/twitch/twitchSubs.js';
import { getActiveManagedChannels } from '../src/components/twitch/channelManager.js';
import { getUsersByLogin } from '../src/components/twitch/helixClient.js';
import { initializeHelixClient } from '../src/components/twitch/helixClient.js';
import { initializeChannelManager } from '../src/components/twitch/channelManager.js';
import config from '../src/config/index.js';
import logger from '../src/lib/logger.js';

const REQUIRED_SUBSCRIPTION_TYPES = [
    'channel.chat.message',           // CRITICAL for receiving chat
    'channel.subscribe',
    'channel.subscription.message',
    'channel.subscription.gift',
    'channel.cheer',
    'channel.raid',
    'channel.channel_points_custom_reward_redemption.add',
    'channel.channel_points_custom_reward_redemption.update'
];

/**
 * Identity key for a subscription, matching how Twitch decides whether a new
 * subscription collides with an existing one — everything *except* the transport
 * callback. Two subs sharing this key deliver the same event twice.
 */
function subscriptionIdentity(sub) {
    const condition = sub.condition || {};
    const stable = Object.keys(condition).sort().map(k => `${k}=${condition[k]}`).join(',');
    return `${sub.type}(${stable})`;
}

async function verifyChannelSubscriptions() {
    try {
        // Initialize
        await initializeHelixClient();
        await initializeChannelManager();

        // Get all active channels
        const activeChannels = await getActiveManagedChannels();
        console.log(`\n=== Verifying EventSub Subscriptions for ${activeChannels.length} Active Channels ===\n`);

        // Get all current subscriptions
        const subResult = await getEventSubSubscriptions();
        if (!subResult.success) {
            console.error('❌ Failed to fetch EventSub subscriptions');
            process.exit(1);
        }

        const allSubscriptions = subResult.data.data;

        // Twitch keys subscription identity on type + condition + transport callback, so the
        // same subscription registered under a second hostname for this very service is a
        // second subscription to Twitch. The 409 "already exists" guard in twitchSubs.js
        // cannot see across them, and neither can the per-delivery message-id dedup in
        // eventsub.js — each copy arrives with its own id. The result is every event firing
        // twice. Checking the callback is therefore not cosmetic tidiness.
        const expectedCallback = config.twitch.publicUrl
            ? `${config.twitch.publicUrl}/twitch/event`
            : null;
        if (!expectedCallback) {
            console.log('⚠️  PUBLIC_URL is not set — skipping callback-drift checks.\n');
        }

        // Keep every subscription, not just a set of type names: collapsing to a set is
        // exactly what hid a duplicated channel.chat.message until it reached air.
        const subsByBroadcaster = new Map();
        allSubscriptions.forEach(sub => {
            const broadcasterId = sub.condition?.broadcaster_user_id || sub.condition?.to_broadcaster_user_id;
            if (broadcasterId) {
                if (!subsByBroadcaster.has(broadcasterId)) {
                    subsByBroadcaster.set(broadcasterId, []);
                }
                subsByBroadcaster.get(broadcasterId).push(sub);
            }
        });

        // Verify each active channel
        const issues = [];
        const healthy = [];

        for (const channelName of activeChannels) {
            // Get broadcaster ID
            const userData = await getUsersByLogin([channelName]);
            if (!userData || userData.length === 0) {
                issues.push({
                    channel: channelName,
                    error: 'Channel not found on Twitch',
                    severity: 'CRITICAL'
                });
                continue;
            }

            const broadcasterId = userData[0].id;
            const channelSubs = subsByBroadcaster.get(broadcasterId) || [];
            const presentTypes = new Set(channelSubs.map(s => s.type));

            // Check for missing subscriptions
            const missing = REQUIRED_SUBSCRIPTION_TYPES.filter(type => !presentTypes.has(type));

            // Check for duplicates: same type + condition delivered over more than one
            // transport. Each extra copy is one extra render of every event.
            const byIdentity = new Map();
            channelSubs.forEach(sub => {
                const key = subscriptionIdentity(sub);
                if (!byIdentity.has(key)) byIdentity.set(key, []);
                byIdentity.get(key).push(sub);
            });
            const duplicates = [...byIdentity.entries()]
                .filter(([, subs]) => subs.length > 1)
                .map(([identity, subs]) => ({
                    identity,
                    count: subs.length,
                    callbacks: [...new Set(subs.map(s => s.transport?.callback))]
                }));

            // Check for callback drift — subs pointing somewhere other than PUBLIC_URL.
            const drifted = expectedCallback
                ? channelSubs.filter(s => s.transport?.callback !== expectedCallback)
                : [];

            const dupesChat = duplicates.some(d => d.identity.startsWith('channel.chat.message('));

            if (missing.length > 0 || duplicates.length > 0 || drifted.length > 0) {
                const isCritical = missing.includes('channel.chat.message') || dupesChat || drifted.length > 0;
                issues.push({
                    channel: channelName,
                    broadcasterId,
                    missing,
                    duplicates,
                    drifted,
                    severity: isCritical ? 'CRITICAL' : 'WARNING'
                });
            } else {
                healthy.push({ channel: channelName, broadcasterId });
            }
        }

        // Sweep every subscription, not just those of active channels. A stale callback on
        // a deactivated channel still fires, and a channel reactivated later would start
        // out already doubled.
        const orphanedCallbacks = expectedCallback
            ? allSubscriptions.filter(s => s.transport?.callback !== expectedCallback)
            : [];
        if (orphanedCallbacks.length > 0) {
            const byCallback = new Map();
            orphanedCallbacks.forEach(s => {
                const cb = s.transport?.callback || '(none)';
                if (!byCallback.has(cb)) byCallback.set(cb, []);
                byCallback.get(cb).push(s);
            });
            console.log(`🚨 ${orphanedCallbacks.length} subscription(s) are NOT on PUBLIC_URL:`);
            console.log(`   expected: ${expectedCallback}`);
            byCallback.forEach((subs, cb) => {
                console.log(`\n   ${cb}  (${subs.length})`);
                subs.forEach(s => console.log(`      ${s.type} ${JSON.stringify(s.condition)} [${s.id}]`));
            });
            console.log('');
        }

        // Print results
        console.log(`✅ Healthy channels: ${healthy.length}`);
        if (healthy.length > 0) {
            healthy.forEach(h => console.log(`   - ${h.channel}`));
        }

        console.log(`\n${issues.length > 0 ? '❌' : '✅'} Channels with issues: ${issues.length}`);

        if (issues.length > 0) {
            const critical = issues.filter(i => i.severity === 'CRITICAL');
            const warnings = issues.filter(i => i.severity === 'WARNING');

            const printIssue = (issue) => {
                console.log(`\n   Channel: ${issue.channel}`);
                if (issue.error) {
                    console.log(`   Error: ${issue.error}`);
                    return;
                }
                if (issue.missing?.length > 0) {
                    console.log(`   Missing subscriptions: ${issue.missing.join(', ')}`);
                    if (issue.missing.includes('channel.chat.message')) {
                        console.log(`   ⚠️  Missing channel.chat.message - CHAT WILL NOT WORK!`);
                    }
                }
                issue.duplicates?.forEach(dup => {
                    console.log(`   ⚠️  Duplicate x${dup.count}: ${dup.identity}`);
                    dup.callbacks.forEach(cb => console.log(`        via ${cb}`));
                    if (dup.identity.startsWith('channel.chat.message(')) {
                        console.log(`        Every chat message is spoken ${dup.count} times, and the`);
                        console.log(`        backed-up queue drifts further behind chat over time.`);
                    }
                });
                if (issue.drifted?.length > 0) {
                    console.log(`   ⚠️  ${issue.drifted.length} subscription(s) not on PUBLIC_URL (${expectedCallback}):`);
                    issue.drifted.forEach(s => console.log(`        ${s.type} -> ${s.transport?.callback} [${s.id}]`));
                }
            };

            if (critical.length > 0) {
                console.log(`\n🚨 CRITICAL Issues (${critical.length}):`);
                critical.forEach(printIssue);
            }

            if (warnings.length > 0) {
                console.log(`\n⚠️  Warnings (${warnings.length}):`);
                warnings.forEach(printIssue);
            }

            const anyMissing = issues.some(i => i.missing?.length > 0);
            const anyExtra = issues.some(i => i.duplicates?.length > 0 || i.drifted?.length > 0);
            console.log('');
            if (anyMissing) {
                console.log('💡 To fix missing subscriptions, run:');
                console.log('   node scripts/manage-eventsub.js subscribe <channel-name>');
            }
            if (anyExtra) {
                console.log('💡 To fix duplicate or drifted subscriptions, delete the copy that is');
                console.log('   NOT on PUBLIC_URL — confirm the survivor exists first, or you drop coverage:');
                console.log('   node scripts/manage-eventsub.js delete <subscription-id>');
            }
            console.log('');

            process.exit(1);
        } else if (orphanedCallbacks.length > 0) {
            // No active channel is affected, but the strays are still live and still fire.
            console.log('\n❌ Stray subscriptions on a non-PUBLIC_URL callback — delete them:');
            console.log('   node scripts/manage-eventsub.js delete <subscription-id>\n');
            process.exit(1);
        } else {
            console.log('\n✅ All channels have required EventSub subscriptions!\n');
            process.exit(0);
        }

    } catch (error) {
        logger.error({ err: error }, 'Error during verification');
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

verifyChannelSubscriptions();
