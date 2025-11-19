// src/components/twitch/eventUtils.js
// Shared utility functions for EventSub event processing

import * as sharedChatManager from './sharedChatManager.js';
import { getUsersByLogin } from './helixClient.js';
import logger from '../../lib/logger.js';

// In-memory cache for broadcaster IDs to avoid repeated API calls
const broadcasterIdCache = new Map();

/**
 * Get broadcaster ID from channel login, with caching
 * @param {string} channelLogin - The channel login name
 * @returns {Promise<string|null>} The broadcaster ID or null if not found
 */
export async function getBroadcasterIdByLogin(channelLogin) {
    if (broadcasterIdCache.has(channelLogin)) {
        return broadcasterIdCache.get(channelLogin);
    }

    const users = await getUsersByLogin([channelLogin]);
    if (users && users.length > 0) {
        const broadcasterId = users[0].id;
        broadcasterIdCache.set(channelLogin, broadcasterId);
        return broadcasterId;
    }

    return null;
}

/**
 * Get shared chat session information for a channel
 * @param {string} channelLogin - The channel login name
 * @returns {Promise<Object|null>} Shared session info or null if not in a shared session
 */
export async function getSharedSessionInfo(channelLogin) {
    try {
        const broadcasterId = await getBroadcasterIdByLogin(channelLogin);
        if (!broadcasterId) {
            return null;
        }

        const sessionId = sharedChatManager.getSessionForChannel(broadcasterId);
        if (!sessionId) {
            return null;
        }

        const session = sharedChatManager.getSession(sessionId);
        if (!session) {
            return null;
        }

        const channelLogins = session.participants.map(p => p.broadcaster_user_login);

        return {
            sessionId,
            channels: channelLogins,
            participantCount: channelLogins.length
        };
    } catch (error) {
        logger.warn({ err: error, channel: channelLogin }, 'Error getting shared session info');
        return null;
    }
}
