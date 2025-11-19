// src/components/twitch/chatClient.js
// Handles sending chat messages via Twitch Helix API
// Replaces the outbound functionality of the old IRC client

import axios from 'axios';
import config from '../../config/index.js';
import logger from '../../lib/logger.js';
import { getUsersByLogin } from './helixClient.js';
import { getClientId } from './auth.js';

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
 * Uses the bot's user access token (NOT app access token)
 *
 * @param {string} channelName - The name of the channel to send to
 * @param {string} message - The message text to send
 * @param {object} [options] - Optional parameters
 * @param {string} [options.replyToId] - Message ID to reply to
 * @returns {Promise<boolean>} - True if successful, false otherwise
 */
export async function sendMessage(channelName, message, options = {}) {
    if (!channelName || !message) {
        logger.warn('sendMessage called with missing channel or message');
        return false;
    }

    // Clean channel name (remove # if present)
    const cleanChannelName = channelName.replace(/^#/, '').toLowerCase();

    try {
        // Check if bot user access token is available
        const botAccessToken = config.twitch.accessToken;
        if (!botAccessToken) {
            logger.error('Bot user access token not available - cannot send chat messages');
            return false;
        }

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

        // Get Client ID
        const clientId = await getClientId();
        if (!clientId) {
            logger.error('Could not get Client ID');
            return false;
        }

        // Build request body
        const requestBody = {
            broadcaster_id: broadcasterId,
            sender_id: botId,
            message: message
        };

        // Add reply_parent_message_id if provided
        if (options.replyToId) {
            requestBody.reply_parent_message_id = options.replyToId;
        }

        // Send the message using bot's USER access token (not app token)
        // Docs: https://dev.twitch.tv/docs/api/reference/#send-chat-message
        // IMPORTANT: This endpoint requires a user access token, not an app access token
        const response = await axios.post(
            'https://api.twitch.tv/helix/chat/messages',
            requestBody,
            {
                headers: {
                    'Authorization': `Bearer ${botAccessToken.replace(/^oauth:/, '')}`,
                    'Client-Id': clientId,
                    'Content-Type': 'application/json'
                }
            }
        );

        const { is_sent, drop_reason } = response.data?.data?.[0] || {};

        if (is_sent === false) {
            logger.warn({
                channel: cleanChannelName,
                message,
                dropReason: drop_reason
            }, 'Message was not sent (dropped by Twitch)');
            return false;
        }

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

