// src/lib/ircSender.js
import logger from './logger.js';
import { getIrcClient } from '../components/twitch/ircClient.js';
import { sleep } from './timeUtils.js'; 

const messageQueue = [];
let isSending = false;

const IRC_SEND_INTERVAL_MS = 1100; // As per Twitch rate limits (20 msgs / 30 secs for normal users, 100 for mods)
const MAX_IRC_MESSAGE_LENGTH = 480; // Twitch IRC message limit is 500 chars, leave some buffer.

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function _processMessageQueue() {
    if (isSending || messageQueue.length === 0) {
        return;
    }

    isSending = true;
    // Log for ChatVibes
    logger.debug(`ChatVibes: Starting IRC sender queue processing (length: ${messageQueue.length})`);

    let ircClient = null;
    try {
        ircClient = getIrcClient();
    } catch (err) {
        logger.error({ err }, "ChatVibes: Failed to get IRC client in _processMessageQueue. Aborting queue processing.");
        isSending = false;
        messageQueue.length = 0;
        return;
    }

    while (messageQueue.length > 0) {
        const { channel, text } = messageQueue.shift();
        logger.debug(`ChatVibes: Sending queued message to ${channel}: "${text.substring(0, 30)}..."`);
        try {
            await ircClient.say(channel, text);
            await sleep(IRC_SEND_INTERVAL_MS);
        } catch (error) {
            logger.error({ err: error, channel, text: `"${text.substring(0, 30)}..."` }, 'ChatVibes: Failed to send queued message.');
            await sleep(IRC_SEND_INTERVAL_MS);
        }
    }

    logger.debug('ChatVibes: IRC sender queue processed.');
    isSending = false;
}

function initializeIrcSender() {
    logger.info('ChatVibes: Initializing IRC Sender...');
}

/**
 * Adds a message to the rate-limited send queue.
 * Truncates message if it exceeds MAX_IRC_MESSAGE_LENGTH.
 * @param {string} channel Channel name with '#'.
 * @param {string} text Message text.
 */
async function enqueueMessage(channel, text) { // Removed skipTranslation
    if (!channel || !text || typeof channel !== 'string' || typeof text !== 'string' || text.trim().length === 0) {
        logger.warn({ channel, text }, 'ChatVibes: Attempted to queue invalid message.');
        return;
    }

    let finalText = text;

    // REMOVED TRANSLATION LOGIC - Not part of ChatVibes TTS core

    if (finalText.length > MAX_IRC_MESSAGE_LENGTH) {
        logger.warn(`ChatVibes: Message too long (${finalText.length} chars), truncating before queueing.`);
        finalText = finalText.substring(0, MAX_IRC_MESSAGE_LENGTH - 3) + '...';
    }

    messageQueue.push({ channel, text: finalText });
    logger.debug(`ChatVibes: Message queued for ${channel}. Queue size: ${messageQueue.length}`);

    if (!isSending) {
        _processMessageQueue().catch(err => logger.error({ err }, "ChatVibes: Error in _processMessageQueue trigger"));
    }
}

function clearMessageQueue() {
    logger.info(`ChatVibes: Clearing IRC message queue (${messageQueue.length} messages).`);
    messageQueue.length = 0;
}

export {
    initializeIrcSender,
    enqueueMessage,
    clearMessageQueue,
};