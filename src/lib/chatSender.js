// src/lib/chatSender.js
import logger from './logger.js';
import { sendMessage } from '../components/twitch/chatClient.js';
import { sleep } from './timeUtils.js';
import { getTtsState } from '../components/tts/ttsState.js';

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
    logger.debug(`WildcatTTS: Starting Chat sender queue processing (length: ${messageQueue.length})`);

    while (messageQueue.length > 0) {
        const { channel, text, replyToId } = messageQueue.shift();
        logger.debug(`WildcatTTS: Sending queued message to ${channel}: "${text.substring(0, 30)}..."`);

        try {
            const success = await sendMessage(channel, text, { replyToId });
            if (!success) {
                logger.warn({ channel, text: text.substring(0, 30) }, 'WildcatTTS: Failed to send message via Helix.');
            }
            await sleep(SEND_INTERVAL_MS);
        } catch (error) {
            logger.error({ err: error, channel, text: `"${text.substring(0, 30)}..."` }, 'WildcatTTS: Error in message queue processing.');
            await sleep(SEND_INTERVAL_MS);
        }
    }

    logger.debug('WildcatTTS: Chat sender queue processed.');
    isSending = false;
}

export function initializeChatSender() {
    logger.info('WildcatTTS: Initializing Chat Sender...');
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
        logger.warn({ channel, text }, 'WildcatTTS: Attempted to queue invalid message.');
        return;
    }

    // Check if bot should respond in chat
    const channelName = channel.replace(/^#/, '').toLowerCase();
    try {
        const ttsState = await getTtsState(channelName);
        if (!ttsState.botRespondsInChat) {
            logger.debug({ channel: channelName }, 'WildcatTTS: Bot responses disabled for channel - message not queued');
            return;
        }
    } catch (error) {
        logger.error({ err: error, channel: channelName }, 'WildcatTTS: Error checking botRespondsInChat setting - message not queued');
        return;
    }

    let finalText = text;
    const replyToId = options.replyToId || null;

    if (finalText.length > MAX_MESSAGE_LENGTH) {
        logger.warn(`WildcatTTS: Message too long (${finalText.length} chars), truncating before queueing.`);
        finalText = finalText.substring(0, MAX_MESSAGE_LENGTH - 3) + '...';
    }

    messageQueue.push({ channel, text: finalText, replyToId });
    logger.debug(`WildcatTTS: Message queued for ${channel}. Queue size: ${messageQueue.length}`);

    if (!isSending) {
        _processMessageQueue().catch(err => logger.error({ err }, "WildcatTTS: Error in _processMessageQueue trigger"));
    }
}

export function clearMessageQueue() {
    logger.info(`WildcatTTS: Clearing Chat message queue (${messageQueue.length} messages).`);
    messageQueue.length = 0;
}