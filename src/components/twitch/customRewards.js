// src/components/twitch/customRewards.js
// List a channel's custom channel point rewards.
//
// Not in helixClient.js because that client injects the *app* token on every
// request, and GET /channel_points/custom_rewards only answers to the
// broadcaster's own token (channel:read:redemptions or channel:manage:redemptions).
import axios from 'axios';
import logger from '../../lib/logger.js';
import { getClientId } from './tokenManager.js';
import { getBroadcasterAccessToken } from './broadcasterToken.js';

const CUSTOM_REWARDS_URL = 'https://api.twitch.tv/helix/channel_points/custom_rewards';

/**
 * Why the list could not be fetched. `code` is stable so a caller can pick a
 * reply without parsing the message:
 *   no_token        the streamer never signed in to the dashboard, or must again
 *   unauthorized    Helix refused the token (expired, or missing the scope)
 *   request_failed  anything else
 */
export class RewardListError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'RewardListError';
        this.code = code;
    }
}

/**
 * @typedef {object} CustomReward
 * @property {string} id
 * @property {string} title
 * @property {string} prompt  The reward's description, shown to viewers.
 * @property {number} cost
 * @property {boolean} isEnabled
 */

/**
 * @param {string} broadcasterId
 * @param {string} channelLogin For logging only.
 * @returns {Promise<CustomReward[]>}
 * @throws {RewardListError}
 */
export async function listCustomRewards(broadcasterId, channelLogin) {
    const token = await getBroadcasterAccessToken(broadcasterId, channelLogin);
    if (!token) {
        throw new RewardListError('no_token', 'Broadcaster access token not available');
    }
    const clientId = await getClientId();

    try {
        const response = await axios.get(CUSTOM_REWARDS_URL, {
            params: { broadcaster_id: broadcasterId },
            headers: { Authorization: `Bearer ${token}`, 'Client-ID': clientId },
            timeout: 8000,
        });
        // Spec: https://dev.twitch.tv/docs/api/reference/#get-custom-reward
        return (response.data?.data || []).map(r => ({
            id: r.id,
            title: r.title,
            prompt: r.prompt || '',
            cost: r.cost,
            isEnabled: r.is_enabled !== false,
        }));
    } catch (error) {
        const status = error.response?.status;
        logger.warn({ err: { message: error.message }, status, channelLogin }, 'Failed to list custom rewards');
        if (status === 401 || status === 403) {
            throw new RewardListError('unauthorized', `Helix refused the broadcaster token (${status})`);
        }
        throw new RewardListError('request_failed', error.message);
    }
}
