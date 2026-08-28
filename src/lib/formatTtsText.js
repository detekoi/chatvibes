// src/lib/formatTtsText.js
// Shared TTS text formatting pipeline: Twitch emote processing + URL processing + emoji processing.
// Extracted from chatHandler.js so any entry point (chat messages, !tts commands,
// channel point redemptions, etc.) can apply the same emote mode rules.

import logger from './logger.js';
import { processMessageUrls } from './urlProcessor.js';
import { replaceEmojisWithText, stripEmojis } from './emojiUtils.js';
import { DEFAULT_LOCALE } from '../i18n/index.js';
import { isGeminiAvailable, processMessageWithEmoteDescriptions } from './emotes/index.js';
import { applyRewrites } from './textRewrite/replaceEngine.js';

/**
 * Apply the full TTS text formatting pipeline to a message.
 *
 * Steps (in order):
 *   1. Process Twitch emotes in fragments according to emoteMode (read / skip / describe)
 *   2. Process URLs (shorten to domain or pass through)
 *   3. Process Unicode emojis (describe or strip based on emoteMode)
 *   4. Expand pronunciation dictionary entries (LFG -> "lets fucking go")
 *
 * Pronunciation runs last so it sees the final string exactly once: emote
 * descriptions and emoji names are generated English and should be expanded
 * too, and running before step 2 would expand acronyms inside hostnames and
 * hand corrupted URLs to processMessageUrls.
 *
 * The profanity filter is step 5 and deliberately lives in ttsQueue.enqueue
 * instead. A viewer can override languageBoost for their own messages, and
 * that override is only resolved there — filtering here would apply the
 * channel's language to a viewer speaking another one.
 *
 * @param {string} text - The plain-text message content.
 * @param {Array<{type: string, text: string, emote?: object}>|null} fragments
 *     Twitch EventSub message fragments (cheermotes should already be filtered out).
 *     May be null/undefined if fragment data is not available (graceful fallback to 'read').
 * @param {object} options
 * @param {string} options.emoteMode - Resolved emote mode: 'read' | 'skip' | 'describe'.
 * @param {string} options.channelEmoteMode - Channel-level default (used as describe fallback).
 * @param {boolean} [options.readFullUrls=false] - Whether to read full URLs aloud.
 * @param {object|null} [options.pronunciationRules=null] - Compiled rule set from
 *     getPronunciationRules, or null to skip the pass.
 * @param {string} [options.locale='en'] - BCP-47 tag for the channel. Drives the emoji
 *     labels, the emote descriptions Gemini generates, and the wrapper wording around
 *     both. Channel-level, not per-viewer: these are heard by everyone watching, and a
 *     viewer's own languageBoost override is only resolved later in ttsQueue.enqueue.
 * @param {Function} [options.emoteProcessor] - Emote step override, same
 *     signature as processEmoteFragments. YouTube passes its own processor so
 *     both platforms share the rest of the pipeline rather than duplicating it.
 * @returns {Promise<string>} The processed TTS-ready text.
 */
export async function formatTtsText(text, fragments, { emoteMode = 'read', channelEmoteMode = 'read', readFullUrls = false, pronunciationRules = null, locale = DEFAULT_LOCALE, emoteProcessor = processEmoteFragments } = {}) {
    // Step 1: Process emotes via fragment data
    let processed = await emoteProcessor(text, fragments, emoteMode, channelEmoteMode, locale);

    // Step 2: Process URLs
    processed = processMessageUrls(processed, readFullUrls);

    // Step 3: Process Unicode emojis
    processed = emoteMode === 'skip'
        ? stripEmojis(processed)
        : replaceEmojisWithText(processed, locale);

    // Step 4: Expand pronunciation dictionary entries
    if (pronunciationRules) {
        processed = applyRewrites(processed, pronunciationRules);
    }

    return processed;
}

/**
 * Process Twitch emote fragments according to the emote mode.
 *
 * @param {string} text - Original plain text (used as-is for 'read' mode).
 * @param {Array|null} fragments - Twitch EventSub fragments.
 * @param {string} emoteMode - 'read' | 'skip' | 'describe'
 * @param {string} channelEmoteMode - Channel default, used for describe fallback.
 * @param {string} [locale] - BCP-47 tag the descriptions are generated in.
 * @returns {Promise<string>} Emote-processed text.
 */
async function processEmoteFragments(text, fragments, emoteMode, channelEmoteMode, locale = DEFAULT_LOCALE) {
    if (emoteMode === 'read' || !fragments) {
        return text;
    }

    if (emoteMode === 'skip') {
        return skipEmoteFragments(fragments);
    }

    // emoteMode === 'describe'
    if (isGeminiAvailable()) {
        try {
            const described = await processMessageWithEmoteDescriptions(fragments, locale);
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
