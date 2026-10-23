// src/components/twitch/redemptionStatus.js
// Settles TTS reward redemptions on Twitch: approve, cancel (refund), and stop
// the reward from skipping the request queue.
//
// Twitch lets an app change a redemption only while it is UNFULFILLED, and only
// for a reward the same app created. A reward that skips the request queue is
// FULFILLED the moment a viewer redeems it, so nothing can refund it. The
// dashboard therefore creates the TTS reward with the queue on, and the bot
// approves or cancels each redemption itself (see handleChannelPointsRedemption).
//
// These calls use the broadcaster's own token (channel:manage:redemptions). Kept
// apart from the handler so that tests can replace them without the network.
import axios from 'axios';
import logger from '../../lib/logger.js';
import { getBroadcasterAccessToken } from './broadcasterToken.js';
import { getClientId } from './tokenManager.js';

const HELIX = 'https://api.twitch.tv/helix/channel_points/custom_rewards';

async function helixHeaders(broadcasterId, channelLogin) {
    const token = await getBroadcasterAccessToken(broadcasterId, channelLogin);
    if (!token) return null;
    return {
        'Authorization': `Bearer ${token}`,
        'Client-ID': await getClientId(),
        'Content-Type': 'application/json',
    };
}

/**
 * Set a redemption to FULFILLED or CANCELED. CANCELED refunds the viewer.
 * @param {object} args
 * @param {string} args.broadcasterId
 * @param {string} args.channelLogin For logging only
 * @param {string} args.rewardId
 * @param {string} args.redemptionId
 * @param {'FULFILLED'|'CANCELED'} args.status
 * @param {string} args.reason For logging only
 * @returns {Promise<boolean>} Whether Twitch accepted the change
 */
export async function setRedemptionStatus({ broadcasterId, channelLogin, rewardId, redemptionId, status, reason }) {
    if (!broadcasterId || !rewardId || !redemptionId) return false;
    try {
        const headers = await helixHeaders(broadcasterId, channelLogin);
        if (!headers) {
            logger.warn({ channelLogin, redemptionId, status, reason },
                'Cannot settle redemption - broadcaster access token not available (may need to re-authenticate)');
            return false;
        }
        const url = `${HELIX}/redemptions?broadcaster_id=${encodeURIComponent(broadcasterId)}`
            + `&reward_id=${encodeURIComponent(rewardId)}&id=${encodeURIComponent(redemptionId)}`;
        await axios.patch(url, { status }, { headers, timeout: 10000 });
        logger.info({ channelLogin, redemptionId, status, reason },
            status === 'CANCELED' ? 'Canceled Channel Points redemption and refunded points' : 'Fulfilled Channel Points redemption');
        return true;
    } catch (error) {
        logger.error({
            err: error,
            channelLogin,
            redemptionId,
            status,
            reason,
            httpStatus: error.response?.status,
            data: error.response?.data,
        }, 'Failed to settle Channel Points redemption via Twitch API');
        return false;
    }
}

// Rewards already switched in this process, so a busy channel does not repeat
// the call on every redemption. Losing it on a restart costs one more call.
const switchedRewards = new Set();

/**
 * Turn off "skip the request queue" on a TTS reward created before the bot
 * settled redemptions itself, so that its later redemptions can be refunded.
 * The streamer sees no change: the bot approves them at once.
 * @returns {Promise<boolean>} Whether Twitch accepted the change
 */
export async function stopRewardSkippingQueue({ broadcasterId, channelLogin, rewardId }) {
    if (!broadcasterId || !rewardId || switchedRewards.has(rewardId)) return false;
    switchedRewards.add(rewardId);
    try {
        const headers = await helixHeaders(broadcasterId, channelLogin);
        if (!headers) return false;
        const url = `${HELIX}?broadcaster_id=${encodeURIComponent(broadcasterId)}&id=${encodeURIComponent(rewardId)}`;
        await axios.patch(url, { should_redemptions_skip_request_queue: false }, { headers, timeout: 10000 });
        logger.info({ channelLogin, rewardId }, 'TTS reward no longer skips the request queue, so its redemptions can be refunded');
        return true;
    } catch (error) {
        logger.warn({ err: error, channelLogin, rewardId, httpStatus: error.response?.status },
            'Could not turn off skip-queue on the TTS reward');
        return false;
    }
}
