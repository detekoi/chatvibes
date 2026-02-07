// src/lib/geminiEmoteDescriber.js
// Uses Google Gemini Flash Lite to describe Twitch emotes visually for TTS accessibility
import { GoogleGenAI } from '@google/genai';
import logger from './logger.js';

const GEMINI_MODEL = 'gemini-2.5-flash-lite';
const EMOTE_CDN_URL = 'https://static-cdn.jtvnw.net/emoticons/v2';
const EMOTE_IMAGE_FORMAT = 'static/dark/3.0'; // 'static' forces PNG even for animated emotes (Gemini rejects GIFs)
const GEMINI_TIMEOUT_MS = 8000;
const GEMINI_CONCURRENCY = 3; // Max parallel Gemini calls to avoid rate limits
const MAX_UNIQUE_EMOTES = 8; // Cap on unique emotes to describe per message

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
        // Ensure we never send GIF to Gemini (shouldn't happen with 'static' theme, but safety check)
        const safeMimeType = contentType.includes('gif') ? 'image/png' : contentType;
        return {
            data: Buffer.from(arrayBuffer),
            mimeType: safeMimeType,
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
    if (!imageData) {
        logger.info({ emoteId, emoteName }, 'Emote image fetch failed — cannot describe');
        return null;
    }

    try {
        const prompt = `Describe this Twitch emote named "${emoteName}" in 2-6 words for text-to-speech. Focus on what it depicts (emotion, action, character). Be concise and natural-sounding. Do NOT include the word "emote" in your response. Reply with ONLY the short description, no quotes or extra text.`;

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
        logger.info({ err: error.message, emoteId, emoteName }, 'Gemini emote description failed');
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

    if (parts.length === 0) {
        logger.info({ emoteCount: uniqueEmotes.length, emoteNames: uniqueEmotes.map(([, { name }]) => name) }, 'All emote descriptions failed — returning null');
        return null;
    }

    return parts.join(', ');
}

/**
 * Process a message by replacing emote fragments with AI descriptions inline.
 * Walks through fragments in order, keeping emotes at their original position.
 * Consecutive repeated emotes are collapsed (e.g., "3 laughing emotes").
 * 
 * @param {Array<{type: string, text: string, emote?: {id: string}}>} fragments
 * @returns {Promise<string | null>} The reconstructed message, or null on failure
 */
export async function processMessageWithEmoteDescriptions(fragments) {
    if (!fragments?.length) return null;

    const emoteFragments = fragments.filter(f => f.type === 'emote' && f.emote?.id);
    if (emoteFragments.length === 0) return null;

    // Collect unique emote IDs and describe them all in parallel
    const uniqueEmoteIds = new Map(); // emoteId -> emoteName
    for (const frag of emoteFragments) {
        if (!uniqueEmoteIds.has(frag.emote.id)) {
            uniqueEmoteIds.set(frag.emote.id, frag.text);
        }
    }

    const emoteEntries = Array.from(uniqueEmoteIds.entries()).slice(0, MAX_UNIQUE_EMOTES);

    // Process in batches to avoid overwhelming Gemini API
    const descriptions = new Array(emoteEntries.length).fill(null);
    for (let batch = 0; batch < emoteEntries.length; batch += GEMINI_CONCURRENCY) {
        const batchEntries = emoteEntries.slice(batch, batch + GEMINI_CONCURRENCY);
        const batchResults = await Promise.all(
            batchEntries.map(([emoteId, name]) => describeSingleEmote(emoteId, name))
        );
        for (let j = 0; j < batchResults.length; j++) {
            descriptions[batch + j] = batchResults[j];
        }
    }

    // Build emoteId -> description map
    const descriptionMap = new Map();
    for (let i = 0; i < emoteEntries.length; i++) {
        if (descriptions[i]) {
            descriptionMap.set(emoteEntries[i][0], descriptions[i]);
        }
    }

    if (descriptionMap.size === 0) {
        logger.info({ emoteCount: uniqueEmoteIds.size, emoteNames: Array.from(uniqueEmoteIds.values()) }, 'All emote descriptions failed — returning null');
        return null;
    }

    // Walk fragments in order, collapsing consecutive runs of the same emote
    const outputParts = [];
    let i = 0;
    while (i < fragments.length) {
        const frag = fragments[i];

        if (frag.type === 'emote' && frag.emote?.id) {
            const emoteId = frag.emote.id;
            const desc = descriptionMap.get(emoteId);

            if (desc) {
                // Count consecutive runs of the same emote, skipping whitespace-only fragments between them
                let count = 1;
                let lookahead = i + 1;
                while (lookahead < fragments.length) {
                    const next = fragments[lookahead];
                    // Skip whitespace-only text fragments between emotes
                    if (next.type === 'text' && !next.text.trim()) {
                        lookahead++;
                        continue;
                    }
                    // Check if the next non-whitespace fragment is the same emote
                    if (next.type === 'emote' && next.emote?.id === emoteId) {
                        count++;
                        lookahead++;
                        continue;
                    }
                    break;
                }

                if (count > 1) {
                    outputParts.push(`${count} emotes of ${desc}`);
                } else {
                    outputParts.push(`emote of ${desc}`);
                }
                i = lookahead;
            } else {
                // Description failed — skip this emote
                i++;
            }
        } else {
            // Text or mention fragment — keep as-is
            const text = frag.text.trim();
            if (text) {
                outputParts.push(text);
            }
            i++;
        }
    }

    if (outputParts.length === 0) return null;

    return outputParts.join(', ');
}

// For testing
export { descriptionCache as _descriptionCache };
