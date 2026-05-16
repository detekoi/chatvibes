// src/components/youtube/ytEmoteProcessor.js
// YouTube-specific emote processing adapter.
// Converts emoteFragments from yt-chat-proxy into TTS text according to the
// broadcaster's emoteMode setting (read / skip / describe).

import { createHash } from 'crypto';
import logger from '../../lib/logger.js';
import { isGeminiAvailable, describeEmoteFromUrl } from '../../lib/emotes/index.js';

/**
 * Process YouTube emote fragments according to the emote mode.
 *
 * @param {string} text - The raw message text (with space placeholders for emotes).
 * @param {Array<{type: string, text: string, imageUrl?: string, label?: string}>|null} emoteFragments
 *     Structured fragment array from yt-chat-proxy. null if no custom emotes present.
 * @param {string} emoteMode - Resolved emote mode: 'read' | 'skip' | 'describe'.
 * @param {string} channelEmoteMode - Channel-level default (used as describe fallback).
 * @returns {Promise<string>} Processed text with emotes handled per mode.
 */
export async function processYouTubeEmotes(text, emoteFragments, emoteMode, channelEmoteMode) {
    // No custom emote fragments — return text as-is (unicode emoji handled separately)
    if (!emoteFragments || emoteFragments.length === 0) {
        return text;
    }

    if (emoteMode === 'read') {
        return readEmoteFragments(emoteFragments);
    }

    if (emoteMode === 'skip') {
        return skipEmoteFragments(emoteFragments);
    }

    // emoteMode === 'describe'
    if (isGeminiAvailable()) {
        try {
            const described = await describeEmoteFragments(emoteFragments);
            if (described) return described;
        } catch (error) {
            logger.debug({ err: error }, 'YouTube emote description failed, falling back');
        }
    }

    // Fallback: use channel's emote mode setting (but not 'describe' to avoid infinite loop)
    const fallbackMode = channelEmoteMode === 'describe' ? 'read' : channelEmoteMode;
    if (fallbackMode === 'skip') {
        return skipEmoteFragments(emoteFragments);
    }
    return readEmoteFragments(emoteFragments); // 'read' fallback
}

/**
 * Read mode: replace emote fragments with their label text.
 * @param {Array} fragments
 * @returns {string}
 */
function readEmoteFragments(fragments) {
    const parts = [];
    for (const frag of fragments) {
        if (frag.type === 'text') {
            const trimmed = frag.text.trim();
            if (trimmed) parts.push(trimmed);
        } else if (frag.type === 'yt_emote') {
            // Use label (accessibility-first), falling back to shortcut text
            const label = frag.label || frag.text?.replace(/:/g, '') || '';
            if (label) parts.push(label);
        }
    }
    return parts.join(' ');
}

/**
 * Skip mode: drop emote fragments, keep only text.
 * @param {Array} fragments
 * @returns {string}
 */
function skipEmoteFragments(fragments) {
    return fragments
        .filter(f => f.type === 'text')
        .map(f => f.text.trim())
        .filter(Boolean)
        .join(' ');
}

/**
 * Describe mode: fetch emote images and describe via Gemini.
 * Groups consecutive identical emotes and generates parenthetical descriptions.
 * @param {Array} fragments
 * @returns {Promise<string | null>}
 */
async function describeEmoteFragments(fragments) {
    // Collect unique emotes
    const uniqueEmotes = new Map(); // imageUrl -> { label, count }
    const orderedFrags = [];

    for (const frag of fragments) {
        if (frag.type === 'yt_emote' && frag.imageUrl) {
            const existing = uniqueEmotes.get(frag.imageUrl);
            if (existing) {
                // Check if previous fragment was same emote for grouping
                const last = orderedFrags[orderedFrags.length - 1];
                if (last?.type === 'yt_emote' && last.imageUrl === frag.imageUrl) {
                    last.count = (last.count || 1) + 1;
                } else {
                    orderedFrags.push({ ...frag, count: 1 });
                }
            } else {
                uniqueEmotes.set(frag.imageUrl, { label: frag.label || '' });
                orderedFrags.push({ ...frag, count: 1 });
            }
        } else {
            orderedFrags.push(frag);
        }
    }

    // Describe all unique emotes in parallel
    const descriptionMap = new Map();
    const describePromises = [];

    for (const [imageUrl, { label }] of uniqueEmotes) {
        const cacheKey = urlToCacheKey(imageUrl);
        describePromises.push(
            describeEmoteFromUrl(imageUrl, cacheKey, label, 'youtube')
                .then(desc => {
                    if (desc) descriptionMap.set(imageUrl, desc);
                })
        );
    }

    await Promise.all(describePromises);

    if (descriptionMap.size === 0) {
        logger.info({ emoteCount: uniqueEmotes.size }, 'All YouTube emote descriptions failed — returning null');
        return null;
    }

    // Assemble output
    const outputParts = [];
    for (const frag of orderedFrags) {
        if (frag.type === 'yt_emote') {
            const desc = descriptionMap.get(frag.imageUrl);
            const count = frag.count || 1;
            if (desc) {
                outputParts.push(count > 1 ? `(${count} ${desc} emotes)` : `(${desc} emote)`);
            } else {
                // Fallback to label/name
                const label = frag.label || frag.text?.replace(/:/g, '') || '';
                if (label) {
                    outputParts.push(count > 1 ? `(${count} ${label})` : label);
                }
            }
        } else if (frag.type === 'text') {
            const text = frag.text.trim();
            if (text) outputParts.push(text);
        }
    }

    return outputParts.length > 0 ? outputParts.join(' ') : null;
}

/**
 * Convert a YouTube emote image URL into a valid Firestore document ID.
 * YouTube emote URLs contain slashes and special characters that are invalid
 * as Firestore document IDs, so we SHA-256 hash them with a 'yt-' prefix.
 * @param {string} url
 * @returns {string}
 */
function urlToCacheKey(url) {
    const hash = createHash('sha256').update(url).digest('hex').substring(0, 16);
    return `yt-${hash}`;
}
