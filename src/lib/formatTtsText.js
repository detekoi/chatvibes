// src/lib/formatTtsText.js
// Shared TTS text formatting pipeline: Twitch emote processing + URL processing + emoji processing.
// Extracted from chatHandler.js so any entry point (chat messages, !tts commands,
// channel point redemptions, etc.) can apply the same emote mode rules.

import logger from './logger.js';
import { processMessageUrls } from './urlProcessor.js';
import { replaceEmojisWithText, stripEmojis } from './emojiUtils.js';
import { isGeminiAvailable, processMessageWithEmoteDescriptions } from './emotes/index.js';

/**
 * Apply the full TTS text formatting pipeline to a message.
 *
 * Steps (in order):
 *   1. Process Twitch emotes in fragments according to emoteMode (read / skip / describe)
 *   2. Process URLs (shorten to domain or pass through)
 *   3. Process Unicode emojis (describe or strip based on emoteMode)
 *
 * @param {string} text - The plain-text message content.
 * @param {Array<{type: string, text: string, emote?: object}>|null} fragments
 *     Twitch EventSub message fragments (cheermotes should already be filtered out).
 *     May be null/undefined if fragment data is not available (graceful fallback to 'read').
 * @param {object} options
 * @param {string} options.emoteMode - Resolved emote mode: 'read' | 'skip' | 'describe'.
 * @param {string} options.channelEmoteMode - Channel-level default (used as describe fallback).
 * @param {boolean} [options.readFullUrls=false] - Whether to read full URLs aloud.
 * @returns {Promise<string>} The processed TTS-ready text.
 */
export async function formatTtsText(text, fragments, { emoteMode = 'read', channelEmoteMode = 'read', readFullUrls = false } = {}) {
    // Step 1: Process Twitch emotes via fragment data
    let processed = await processEmoteFragments(text, fragments, emoteMode, channelEmoteMode);

    // Step 2: Process URLs
    processed = processMessageUrls(processed, readFullUrls);

    // Step 3: Process Unicode emojis
    const processEmoji = emoteMode === 'skip' ? stripEmojis : replaceEmojisWithText;
    processed = processEmoji(processed);

    return processed;
}

/**
 * Process Twitch emote fragments according to the emote mode.
 *
 * @param {string} text - Original plain text (used as-is for 'read' mode).
 * @param {Array|null} fragments - Twitch EventSub fragments.
 * @param {string} emoteMode - 'read' | 'skip' | 'describe'
 * @param {string} channelEmoteMode - Channel default, used for describe fallback.
 * @returns {Promise<string>} Emote-processed text.
 */
async function processEmoteFragments(text, fragments, emoteMode, channelEmoteMode) {
    if (emoteMode === 'read' || !fragments) {
        return text;
    }

    if (emoteMode === 'skip') {
        return skipEmoteFragments(fragments);
    }

    // emoteMode === 'describe'
    if (isGeminiAvailable()) {
        try {
            const described = await processMessageWithEmoteDescriptions(fragments);
            if (described) return described;
        } catch (error) {
            logger.debug({ err: error }, 'Emote description failed, falling back');
        }
    }

    // Fallback: use channel's emote mode setting (but not 'describe' to avoid infinite loop)
    const fallbackMode = channelEmoteMode === 'describe' ? 'read' : channelEmoteMode;
    if (fallbackMode === 'skip') {
        return skipEmoteFragments(fragments);
    }
    return text; // 'read' fallback
}

/**
 * Filter out emote fragments, keeping only text and mention fragments.
 * @param {Array} fragments
 * @returns {string}
 */
function skipEmoteFragments(fragments) {
    return fragments
        .filter(f => f.type === 'text' || f.type === 'mention')
        .map(f => f.text)
        .join('')
        .trim();
}
