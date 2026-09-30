// src/lib/channelHandover.js
// What happens when this instance gains or loses a channel (channelOwnership.js).
//
// On gaining one it starts listening to the channel's inbox, for webhooks other
// instances forward and clips a previous owner handed over, and picks up any
// queue persisted at a shutdown. On losing one it stops listening and hands its
// pending clips to the channel's inbox for the next owner. Kept apart from
// channelOwnership.js, which knows nothing about queues or webhooks.

import logger from './logger.js';
import { INSTANCE_ID } from './instanceId.js';
import { isOwnershipEnabled, onOwnershipChange } from './channelOwnership.js';
import { forwardToInbox, startInbox, stopInbox, stopAllInboxes } from './channelInbox.js';
import { getChannelIdFromName, getChannelNameFromId } from './allowList.js';
import * as ttsQueue from '../components/tts/ttsQueue.js';

let unsubscribe = null;

/**
 * Writes a channel's pending clips to its inbox for whoever owns it next.
 * @param {string} broadcasterId
 * @param {string} channelName
 * @param {string} reason
 */
async function handOffQueue(broadcasterId, channelName, reason) {
    const handoff = ttsQueue.takeQueueForHandoff(channelName);
    if (!handoff) return;
    try {
        await forwardToInbox(broadcasterId, {
            kind: 'queueHandoff',
            messageId: `handoff-${INSTANCE_ID}-${Date.now()}`,
            payload: JSON.stringify(handoff),
        });
        logger.info({ channelName, broadcasterId, items: handoff.items.length, isPaused: handoff.isPaused, reason },
            '[ChannelHandover] Handed pending TTS queue to the next owner');
    } catch (err) {
        // Put the clips back: this instance may still reach the player, and
        // shutdown persists what is left.
        ttsQueue.adoptQueue(channelName, handoff);
        logger.error({ err, channelName, broadcasterId }, '[ChannelHandover] Could not hand the queue over; kept it here');
    }
}

/**
 * Dispatches one inbox event for a channel this instance owns.
 * @param {string} broadcasterId
 * @param {{kind: string, payload: object, timing: object|null}} event
 * @param {(notification: object, timing: object|null) => Promise<void>} onNotification
 */
async function handleInboxEvent(broadcasterId, event, onNotification) {
    if (event.kind === 'queueHandoff') {
        // This instance's own mapping first (it tracks renames), then the login
        // the sender queued under, which a just-added channel may still lack here.
        const channelName = getChannelNameFromId(broadcasterId) || event.payload?.channelName || broadcasterId;
        ttsQueue.adoptQueue(channelName, event.payload);
        return;
    }
    await onNotification(event.payload, event.timing);
}

/**
 * Connects ownership changes to the inbox and the queue.
 * @param {object} opts
 * @param {(notification: object, timing: object|null) => Promise<void>} opts.onNotification -
 *   Handler for forwarded EventSub notifications.
 */
export function wireChannelHandover({ onNotification }) {
    if (!isOwnershipEnabled() || unsubscribe) return;
    unsubscribe = onOwnershipChange(async ({ type, broadcasterId, channelName, reason }) => {
        if (type === 'acquired') {
            startInbox(broadcasterId, event => handleInboxEvent(broadcasterId, event, onNotification));
            try {
                await ttsQueue.restoreQueue(broadcasterId);
            } catch (err) {
                logger.warn({ err, broadcasterId }, '[ChannelHandover] Could not restore persisted queue');
            }
            return;
        }
        stopInbox(broadcasterId);
        await handOffQueue(broadcasterId, channelName, reason);
    });
}

/**
 * Shutdown, after the leases are released: hands on whatever is still queued
 * for channels this instance did not own (clips that reached it over Pub/Sub).
 */
export async function handOffRemainingQueues() {
    stopAllInboxes();
    const tasks = [];
    for (const channelName of ttsQueue.getChannelsWithPendingQueue()) {
        const broadcasterId = getChannelIdFromName(channelName);
        if (!broadcasterId) continue;
        tasks.push(handOffQueue(broadcasterId, channelName, 'shutdown'));
    }
    await Promise.allSettled(tasks);
}
