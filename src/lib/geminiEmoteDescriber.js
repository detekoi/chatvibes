// src/lib/geminiEmoteDescriber.js
// Uses Google Gemini Flash Lite to describe Twitch emotes visually for TTS accessibility
import { GoogleGenAI } from '@google/genai';
import logger from './logger.js';

const GEMINI_MODEL = 'gemini-2.5-flash-lite';
const EMOTE_CDN_URL = 'https://static-cdn.jtvnw.net/emoticons/v2';
const EMOTE_IMAGE_FORMAT = 'default/dark/3.0'; // 3x resolution for better AI recognition
const GEMINI_TIMEOUT_MS = 3000;

// In-memory cache: emoteId -> { description, cachedAt }
const descriptionCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

let genAI = null;

/**
 * Initialize the Gemini client. 
 * Call once during bot startup if GEMINI_API_KEY is available.
 */
export function initGeminiClient(apiKey) {
    if (!apiKey) {
        logger.warn('GEMINI_API_KEY not set — emote description feature disabled');
        return false;
    }
    try {
        genAI = new GoogleGenAI({ apiKey });
        logger.info('Gemini client initialized for emote description');
        return true;
    } catch (error) {
        logger.error({ err: error }, 'Failed to initialize Gemini client');
        return false;
    }
}

/**
 * Check if the Gemini client is available for use.
 */
export function isGeminiAvailable() {
    return genAI !== null;
}

/**
 * Get the emote image URL from a Twitch emote ID.
 * @param {string} emoteId 
 * @returns {string}
 */
export function getEmoteImageUrl(emoteId) {
    return `${EMOTE_CDN_URL}/${emoteId}/${EMOTE_IMAGE_FORMAT}`;
}

/**
 * Fetch an emote image as bytes.
 * @param {string} emoteId
 * @returns {Promise<{data: Buffer, mimeType: string} | null>}
 */
async function fetchEmoteImage(emoteId) {
    try {
        const url = getEmoteImageUrl(emoteId);
        const response = await fetch(url);
        if (!response.ok) {
            logger.debug({ emoteId, status: response.status }, 'Failed to fetch emote image');
            return null;
        }
        const arrayBuffer = await response.arrayBuffer();
        const contentType = response.headers.get('content-type') || 'image/png';
        return {
            data: Buffer.from(arrayBuffer),
            mimeType: contentType,
        };
    } catch (error) {
        logger.debug({ err: error, emoteId }, 'Error fetching emote image');
        return null;
    }
}

/**
 * Get a cached description for an emote, or null if not cached/expired.
 * @param {string} emoteId
 * @returns {string | null}
 */
function getCachedDescription(emoteId) {
    const cached = descriptionCache.get(emoteId);
    if (cached && (Date.now() - cached.cachedAt) < CACHE_TTL_MS) {
        return cached.description;
    }
    if (cached) {
        descriptionCache.delete(emoteId);
    }
    return null;
}

/**
 * Cache a description for an emote.
 * @param {string} emoteId 
 * @param {string} description 
 */
function cacheDescription(emoteId, description) {
    descriptionCache.set(emoteId, { description, cachedAt: Date.now() });
}

/**
 * Describe a single emote using Gemini vision.
 * @param {string} emoteId 
 * @param {string} emoteName - The text name of the emote (e.g. "LUL")
 * @returns {Promise<string | null>}
 */
async function describeSingleEmote(emoteId, emoteName) {
    // Check cache first
    const cached = getCachedDescription(emoteId);
    if (cached) return cached;

    if (!genAI) return null;

    const imageData = await fetchEmoteImage(emoteId);
    if (!imageData) return null;

    try {
        const prompt = `Describe this Twitch emote named "${emoteName}" in 2-6 words for text-to-speech. Focus on what it depicts (emotion, action, character). Be concise and natural-sounding. Reply with ONLY the short description, no quotes or extra text.`;

        const response = await Promise.race([
            genAI.models.generateContent({
                model: GEMINI_MODEL,
                contents: [
                    {
                        inlineData: {
                            mimeType: imageData.mimeType,
                            data: imageData.data.toString('base64'),
                        },
                    },
                    { text: prompt },
                ],
            }),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Gemini timeout')), GEMINI_TIMEOUT_MS)
            ),
        ]);

        const description = response.text?.trim();
        if (description) {
            cacheDescription(emoteId, description);
            logger.debug({ emoteId, emoteName, description }, 'Emote described by Gemini');
            return description;
        }
        return null;
    } catch (error) {
        logger.debug({ err: error, emoteId, emoteName }, 'Gemini emote description failed');
        return null;
    }
}

/**
 * Process emote fragments from an EventSub message and generate
 * natural-language descriptions for TTS.
 * 
 * Deduplicates repeated emotes and groups them naturally:
 * - Single unique emote: "emote of laughing person"
 * - Multiple different emotes: "emote of laughing person, emote of clapping"
 * - Repeated same emote: "3 emotes of laughing person"
 * 
 * @param {Array<{type: string, text: string, emote?: {id: string}}>} fragments - EventSub message fragments
 * @returns {Promise<string | null>} Description text, or null on failure
 */
export async function describeEmoteFragments(fragments) {
    if (!genAI || !fragments?.length) return null;

    // Extract only emote fragments
    const emoteFragments = fragments.filter(f => f.type === 'emote' && f.emote?.id);
    if (emoteFragments.length === 0) return null;

    // Count occurrences of each unique emote
    const emoteCounts = new Map(); // emoteId -> { name, count }
    for (const frag of emoteFragments) {
        const id = frag.emote.id;
        const existing = emoteCounts.get(id);
        if (existing) {
            existing.count++;
        } else {
            emoteCounts.set(id, { name: frag.text, count: 1 });
        }
    }

    // Describe each unique emote (in parallel, with caching)
    const uniqueEmotes = Array.from(emoteCounts.entries());
    const descriptionPromises = uniqueEmotes.map(([emoteId, { name }]) =>
        describeSingleEmote(emoteId, name)
    );

    const descriptions = await Promise.all(descriptionPromises);

    // Build the final text
    const parts = [];
    for (let i = 0; i < uniqueEmotes.length; i++) {
        const [, { name, count }] = uniqueEmotes[i];
        const desc = descriptions[i];

        if (!desc) {
            // If we couldn't describe this emote, skip it
            continue;
        }

        if (count > 1) {
            parts.push(`${count} emotes of ${desc}`);
        } else {
            parts.push(`emote of ${desc}`);
        }
    }

    if (parts.length === 0) return null;

    return parts.join(', ');
}

/**
 * Process a message by replacing emote fragments with AI descriptions.
 * Reconstructs the message with text fragments kept and emote fragments
 * replaced by a single description block.
 * 
 * @param {Array<{type: string, text: string, emote?: {id: string}}>} fragments
 * @returns {Promise<string | null>} The reconstructed message, or null on failure
 */
export async function processMessageWithEmoteDescriptions(fragments) {
    if (!fragments?.length) return null;

    const emoteFragments = fragments.filter(f => f.type === 'emote' && f.emote?.id);
    if (emoteFragments.length === 0) return null;

    // Get descriptions for the emotes
    const emoteDescription = await describeEmoteFragments(fragments);
    if (!emoteDescription) return null;

    // Reconstruct: keep text and mention fragments, replace emote block
    const textParts = fragments
        .filter(f => f.type === 'text' || f.type === 'mention')
        .map(f => f.text);

    const textContent = textParts.join('').trim();

    if (textContent) {
        return `${textContent} (${emoteDescription})`;
    } else {
        // Message is purely emotes
        return emoteDescription;
    }
}

// For testing
export { descriptionCache as _descriptionCache };
