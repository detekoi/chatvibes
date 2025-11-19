// src/components/twitch/chatClient.js
// Handles sending chat messages via Twitch Helix API
// Replaces the outbound functionality of the old IRC client

import config from '../../config/index.js';
import logger from '../../lib/logger.js';
import { getHelixClient, getUsersByLogin } from './helixClient.js';

// Cache for the bot's user ID
let cachedBotUserId = null;

export function _resetCache() {
    cachedBotUserId = null;
}

/**
 * Helper to get the Bot's User ID using its access token
 */
export async function getBotUserId() {
    if (cachedBotUserId) return cachedBotUserId;
    try {
        const users = await getUsersByLogin([config.twitch.username]);
        if (users && users.length > 0) {
            cachedBotUserId = users[0].id;
            return cachedBotUserId;
        }
        return null;
    } catch (error) {
        logger.error({ err: error }, 'ChatVibes: Error fetching bot user ID.');
        return null;
    }
}

/**
 * Sends a chat message to a specific channel using the Helix API
 * Requires 'user:write:chat' scope on the sending user (the bot)
 * 
 * @param {string} channelName - The name of the channel to send to
 * @param {string} message - The message text to send
 * @returns {Promise<boolean>} - True if successful, false otherwise
 */
export async function sendMessage(channelName, message) {
    if (!channelName || !message) {
        logger.warn('sendMessage called with missing channel or message');
        return false;
    }

    // Clean channel name (remove # if present)
    const cleanChannelName = channelName.replace(/^#/, '').toLowerCase();

    try {
        // Get the broadcaster ID for the target channel
        const users = await getUsersByLogin([cleanChannelName]);
        if (!users || users.length === 0) {
            logger.error({ channelName: cleanChannelName }, 'Could not find broadcaster ID for channel');
            return false;
        }
        const broadcasterId = users[0].id;

        // Get the bot's user ID (sender)
        const botId = await getBotUserId();
        if (!botId) {
            logger.error('Could not determine Bot User ID');
            return false;
        }

        // Send the message
        // Docs: https://dev.twitch.tv/docs/api/reference/#send-chat-message
        // helixClient handles Authorization and Client-Id headers automatically
        const client = getHelixClient();
        await client.post('/chat/messages', {
            broadcaster_id: broadcasterId,
            sender_id: botId,
            message: message
        });

        logger.info({ channel: cleanChannelName, message }, 'Sent chat message via Helix');
        return true;

    } catch (error) {
        logger.error({
            err: error.response ? error.response.data : error.message,
            channel: cleanChannelName
        }, 'Error sending chat message via Helix');
        return false;
    }
}

