// src/lib/chatSender.js
import logger from './logger.js';
import { sendMessage } from '../components/twitch/chatClient.js';
import { sleep } from './timeUtils.js';

const messageQueue = [];
let isSending = false;

// Helix Chat API rate limits are generally higher, but let's keep a safe buffer.
// 100ms delay between messages is usually safe for Helix.
const SEND_INTERVAL_MS = 200;
const MAX_MESSAGE_LENGTH = 500;

async function _processMessageQueue() {
    if (isSending || messageQueue.length === 0) {
        return;
    }

    isSending = true;
    logger.debug(`ChatVibes: Starting Chat sender queue processing (length: ${messageQueue.length})`);

    while (messageQueue.length > 0) {
        const { channel, text, replyToId } = messageQueue.shift();
        logger.debug(`ChatVibes: Sending queued message to ${channel}: "${text.substring(0, 30)}..."`);

        try {
            // Helix Send Chat Message API handles replies via reply_parent_message_id in the body if supported,
            // but our current sendMessage implementation in chatClient.js takes (channel, message).
            // We should update chatClient.js to support replyToId if we want replies.
            // For now, we'll just send the message.

            // TODO: Update chatClient.js to support replyToId

            const success = await sendMessage(channel, text);
            if (!success) {
                logger.warn({ channel, text: text.substring(0, 30) }, 'ChatVibes: Failed to send message via Helix.');
            }
            await sleep(SEND_INTERVAL_MS);
        } catch (error) {
            logger.error({ err: error, channel, text: `"${text.substring(0, 30)}..."` }, 'ChatVibes: Error in message queue processing.');
            await sleep(SEND_INTERVAL_MS);
        }
    }

    logger.debug('ChatVibes: Chat sender queue processed.');
    isSending = false;
}

export function initializeChatSender() {
    logger.info('ChatVibes: Initializing Chat Sender...');
}

/**
 * Adds a message to the rate-limited send queue.
 * Truncates message if it exceeds MAX_MESSAGE_LENGTH.
 * @param {string} channel Channel name.
 * @param {string} text Message text.
 * @param {object} [options={}] Optional params.
 * @param {string|null} [options.replyToId=null] The ID of the message to reply to.
 */
export async function enqueueMessage(channel, text, options = {}) {
    if (!channel || !text || typeof channel !== 'string' || typeof text !== 'string' || text.trim().length === 0) {
        logger.warn({ channel, text }, 'ChatVibes: Attempted to queue invalid message.');
        return;
    }

    let finalText = text;
    const replyToId = options.replyToId || null;

    if (finalText.length > MAX_MESSAGE_LENGTH) {
        logger.warn(`ChatVibes: Message too long (${finalText.length} chars), truncating before queueing.`);
        finalText = finalText.substring(0, MAX_MESSAGE_LENGTH - 3) + '...';
    }

    messageQueue.push({ channel, text: finalText, replyToId });
    logger.debug(`ChatVibes: Message queued for ${channel}. Queue size: ${messageQueue.length}`);

    if (!isSending) {
        _processMessageQueue().catch(err => logger.error({ err }, "ChatVibes: Error in _processMessageQueue trigger"));
    }
}

export function clearMessageQueue() {
    logger.info(`ChatVibes: Clearing Chat message queue (${messageQueue.length} messages).`);
    messageQueue.length = 0;
}