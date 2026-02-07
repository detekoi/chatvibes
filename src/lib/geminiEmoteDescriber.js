// src/lib/geminiEmoteDescriber.js
// Uses Google Gemini Flash Lite to describe Twitch emotes visually for TTS accessibility
import { GoogleGenAI } from '@google/genai';
import logger from './logger.js';

const GEMINI_MODEL = 'gemini-2.5-flash-lite';
const EMOTE_CDN_URL = 'https://static-cdn.jtvnw.net/emoticons/v2';
const EMOTE_IMAGE_FORMAT = 'static/dark/3.0'; // 'static' forces PNG even for animated emotes (Gemini rejects GIFs)
const GEMINI_TIMEOUT_MS = 8000;

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
 * Describe multiple emotes in a single Gemini vision call.
 * Sends all images together with a numbered prompt for efficient batch processing.
 * @param {Array<[string, string]>} emoteEntries - Array of [emoteId, emoteName] pairs
 * @returns {Promise<Map<string, string>>} Map of emoteId -> description
 */
async function describeBatchEmotes(emoteEntries) {
    const results = new Map();
    if (!genAI || emoteEntries.length === 0) return results;

    // Separate cached vs uncached 
    const uncached = [];
    for (const [emoteId, emoteName] of emoteEntries) {
        const cached = getCachedDescription(emoteId);
        if (cached) {
            results.set(emoteId, cached);
        } else {
            uncached.push([emoteId, emoteName]);
        }
    }

    if (uncached.length === 0) return results;

    // Fetch all images in parallel
    const imagePromises = uncached.map(([emoteId]) => fetchEmoteImage(emoteId));
    const images = await Promise.all(imagePromises);

    // Filter to only emotes with successful image fetches
    const withImages = [];
    for (let i = 0; i < uncached.length; i++) {
        if (images[i]) {
            withImages.push({ emoteId: uncached[i][0], emoteName: uncached[i][1], imageData: images[i] });
        } else {
            logger.info({ emoteId: uncached[i][0], emoteName: uncached[i][1] }, 'Emote image fetch failed — cannot describe');
        }
    }

    if (withImages.length === 0) return results;

    // Build multi-image prompt
    const contentParts = [];
    for (let i = 0; i < withImages.length; i++) {
        contentParts.push({
            inlineData: {
                mimeType: withImages[i].imageData.mimeType,
                data: withImages[i].imageData.data.toString('base64'),
            },
        });
    }

    const emoteList = withImages.map((e, i) => `${i + 1}. "${e.emoteName}"`).join('\n');
    contentParts.push({
        text: `Describe each Twitch emote in 2-6 words for text-to-speech. Focus on what it depicts. Be concise. Do NOT include the word "emote". Reply with ONLY numbered descriptions, one per line:\n${emoteList}`,
    });

    try {
        const batchTimeout = Math.max(GEMINI_TIMEOUT_MS, withImages.length * 2000 + 5000);
        const response = await Promise.race([
            genAI.models.generateContent({
                model: GEMINI_MODEL,
                contents: contentParts,
            }),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Gemini batch timeout')), batchTimeout)
            ),
        ]);

        const text = response.text?.trim();
        if (text) {
            // Parse numbered responses: "1. description\n2. description\n..."
            const lines = text.split('\n').map(l => l.trim()).filter(l => l);
            for (const line of lines) {
                const match = line.match(/^(\d+)\.\s*(.+)/);
                if (match) {
                    const idx = parseInt(match[1], 10) - 1;
                    const desc = match[2].replace(/^["']|["']$/g, '').trim();
                    if (idx >= 0 && idx < withImages.length && desc) {
                        const emoteId = withImages[idx].emoteId;
                        cacheDescription(emoteId, desc);
                        results.set(emoteId, desc);
                    }
                }
            }
            logger.debug({ requested: withImages.length, described: results.size - (emoteEntries.length - uncached.length) }, 'Batch emote description complete');
        }
    } catch (error) {
        logger.info({ err: error.message, emoteCount: withImages.length }, 'Batch Gemini emote description failed');
    }

    return results;
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
            parts.push(`${count} ${desc} emotes`);
        } else {
            parts.push(`${desc} emote`);
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

    const emoteEntries = Array.from(uniqueEmoteIds.entries());

    // Use batch multi-image call for efficiency (1 API call for all emotes)
    let descriptionMap;
    if (emoteEntries.length === 1) {
        // Single emote — direct call is faster
        descriptionMap = new Map();
        const desc = await describeSingleEmote(emoteEntries[0][0], emoteEntries[0][1]);
        if (desc) descriptionMap.set(emoteEntries[0][0], desc);
    } else {
        // 2+ emotes — send all images in a single Gemini call
        descriptionMap = await describeBatchEmotes(emoteEntries);
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
                    outputParts.push(`${count} ${desc} emotes`);
                } else {
                    outputParts.push(`${desc} emote`);
                }
                i = lookahead;
            } else {
                // Description failed — fall back to reading the emote name
                // Still collapse consecutive runs of the same emote
                let count = 1;
                let lookahead = i + 1;
                while (lookahead < fragments.length) {
                    const next = fragments[lookahead];
                    if (next.type === 'text' && !next.text.trim()) {
                        lookahead++;
                        continue;
                    }
                    if (next.type === 'emote' && next.emote?.id === emoteId) {
                        count++;
                        lookahead++;
                        continue;
                    }
                    break;
                }

                if (count > 1) {
                    outputParts.push(`${count} ${frag.text}`);
                } else {
                    outputParts.push(frag.text);
                }
                i = lookahead;
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
