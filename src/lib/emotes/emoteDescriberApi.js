// src/lib/emotes/emoteDescriberApi.js
// Gemini Vision API integration for emote descriptions.
// Responsibilities: client init, single-emote describe, batch-emote describe.
import { GoogleGenAI } from '@google/genai';
import config from '../../config/index.js';
import logger from '../logger.js';
import { getCachedDescription, cacheDescription } from './emoteCache.js';
import { fetchEmoteImage, fetchAnimatedEmoteFrames } from './emoteImageFetcher.js';

const { geminiModel, timeoutMs, animatedTimeoutMs } = config.emote;

// System instruction applied to all emote description calls.
// Establishes accessibility framing and guards against common model failures.
const SYSTEM_INSTRUCTION = `You are an accessibility assistant that describes Twitch emotes for text-to-speech. Your goal is precise, natural-sounding visual descriptions.

Rules:
- Reply with ONLY the short description — no preamble, no quotes, no trailing punctuation.
- Do not output the emote's raw alphanumeric string verbatim (e.g. do not say "parfai14Parfait" or "LUL"). You may use meaningful English words embedded in the name (e.g. "parfait dessert" from "parfai14Parfait" is fine), but do not begin your reply with the full emote token itself.
- When describing pride flags, always name the specific flag rather than generic terms. Examples: "rainbow Pride flag", "bisexual Pride flag", "transgender Pride flag", "lesbian Pride flag", "pansexual Pride flag", "nonbinary Pride flag", "asexual Pride flag". These are important cultural identifiers and accurate naming is essential for accessibility.`;

let genAI = null;

/**
 * Initialize the Gemini client.
 * Call once during bot startup if GEMINI_API_KEY is available.
 * @param {string} apiKey
 * @returns {boolean}
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
 * Check if the Gemini client is ready for use.
 * @returns {boolean}
 */
export function isGeminiAvailable() {
    return genAI !== null;
}

/**
 * Build a context-aware emote prompt prefix.
 * @param {string} emoteName
 * @param {string | null} ownerName
 * @returns {string}
 */
function buildEmoteContext(emoteName, ownerName) {
    if (ownerName) {
        return `Twitch emote "${emoteName}" from ${ownerName}'s channel`;
    }
    return `Twitch emote "${emoteName}"`;
}

/**
 * Describe a single emote using Gemini vision.
 * For animated emotes, extracts multiple frames via sharp and sends them as a sequence.
 * @param {string} emoteId
 * @param {string} emoteName
 * @param {string | null} [ownerName]
 * @param {boolean} [isAnimated=false]
 * @param {string} [ownerId]
 * @returns {Promise<string | null>}
 */
export async function describeSingleEmote(emoteId, emoteName, ownerName = null, isAnimated = false, ownerId = null) {
    const cached = await getCachedDescription(emoteId);
    if (cached) return cached;

    if (!genAI) return null;

    let imageParts = null;
    let animatedSuccess = false;

    if (isAnimated) {
        const frames = await fetchAnimatedEmoteFrames(emoteId);
        if (frames && frames.length > 1) {
            imageParts = frames.map(frame => ({
                inlineData: { mimeType: frame.mimeType, data: frame.data.toString('base64') },
            }));
            animatedSuccess = true;
        }
    }

    if (!imageParts) {
        const imageData = await fetchEmoteImage(emoteId);
        if (!imageData) {
            logger.info({ emoteId, emoteName }, 'Emote image fetch failed — cannot describe');
            return null;
        }
        imageParts = [{
            inlineData: { mimeType: imageData.mimeType, data: imageData.data.toString('base64') },
        }];
    }

    try {
        const emoteContext = buildEmoteContext(emoteName, ownerName);
        const prompt = animatedSuccess
            ? `These are ${imageParts.length} sequential frames from an animated ${emoteContext}. Describe what happens across the animation in 2-6 words for text-to-speech. Use the emote name and channel name as clues to identify the subject — but do not echo the raw emote token verbatim in your reply (individual meaningful words from the name are fine). Focus on the action or transformation depicted. Be concise. No word "emote".`
            : `Describe this ${emoteContext} in 2-6 words for text-to-speech. Use the emote name and channel name as clues to identify the subject — but do not echo the raw emote token verbatim in your reply (individual meaningful words from the name are fine). Focus on what it visually depicts. Be concise. No word "emote".`;

        const contents = [...imageParts, { text: prompt }];
        const effectiveTimeout = animatedSuccess ? animatedTimeoutMs : timeoutMs;

        const response = await Promise.race([
            genAI.models.generateContent({
                model: geminiModel,
                systemInstruction: SYSTEM_INSTRUCTION,
                contents,
                config: {
                    responseMimeType: 'application/json',
                    responseJsonSchema: {
                        type: 'object',
                        properties: {
                            description: { type: 'string', description: 'A 2-6 word visual description of the emote, suitable for text-to-speech.' },
                        },
                        required: ['description'],
                    },
                },
            }),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Gemini timeout')), effectiveTimeout)
            ),
        ]);

        const parsed = JSON.parse(response.text);
        const description = parsed?.description?.trim().replace(/[.!?,;:]+$/g, '');
        if (description) {
            cacheDescription(emoteId, description, emoteName, ownerId);
            logger.debug({ emoteId, emoteName, ownerName, isAnimated, animatedSuccess, description }, 'Emote described by Gemini');
            return description;
        }
        return null;
    } catch (error) {
        logger.info({ err: error.message, emoteId, emoteName, isAnimated }, 'Gemini emote description failed');
        return null;
    }
}

/**
 * Describe multiple emotes in a single Gemini vision call.
 * Animated and static emotes are sent in separate parallel calls with dedicated prompts.
 * @param {Array<[string, string, string|null, boolean, string|null]>} emoteEntries - [emoteId, emoteName, ownerName, isAnimated, ownerId]
 * @returns {Promise<Map<string, string>>} Map of emoteId -> description
 */
export async function describeBatchEmotes(emoteEntries) {
    const results = new Map();
    if (!genAI || emoteEntries.length === 0) return results;

    // Separate cached vs uncached
    const uncached = [];
    for (const [emoteId, emoteName, ownerName, isAnimated, ownerId] of emoteEntries) {
        const cached = await getCachedDescription(emoteId);
        if (cached) {
            results.set(emoteId, cached);
        } else {
            uncached.push([emoteId, emoteName, ownerName, isAnimated, ownerId]);
        }
    }

    if (uncached.length === 0) return results;

    // Fetch all images in parallel
    const images = await Promise.all(
        uncached.map(async ([emoteId, , , isAnimated]) => {
            if (isAnimated) {
                const frames = await fetchAnimatedEmoteFrames(emoteId);
                if (frames && frames.length > 1) return { frames, isAnimated: true };
            }
            const staticImg = await fetchEmoteImage(emoteId);
            return staticImg ? { frames: [staticImg], isAnimated: false } : null;
        })
    );

    // Filter to emotes with successful image fetches
    const withImages = [];
    for (let i = 0; i < uncached.length; i++) {
        if (images[i]) {
            withImages.push({
                emoteId: uncached[i][0],
                emoteName: uncached[i][1],
                ownerName: uncached[i][2],
                imageFrames: images[i].frames,
                isAnimated: images[i].isAnimated,
                ownerId: uncached[i][4],
            });
        } else {
            logger.info({ emoteId: uncached[i][0], emoteName: uncached[i][1] }, 'Emote image fetch failed — cannot describe');
        }
    }

    if (withImages.length === 0) return results;

    const staticEmotes = withImages.filter(e => !e.isAnimated);
    const animatedEmotes = withImages.filter(e => e.isAnimated);

    /**
     * Send a single Gemini batch call for a group of emotes.
     * @param {Array} group
     * @param {string} promptText
     * @param {number} baseTimeoutMs
     */
    const describeBatch = async (group, promptText, baseTimeoutMs) => {
        if (group.length === 0) return;

        const contentParts = [];
        for (const emote of group) {
            for (const frame of emote.imageFrames) {
                contentParts.push({
                    inlineData: { mimeType: frame.mimeType, data: frame.data.toString('base64') },
                });
            }
        }

        const emoteList = group.map((e, i) => {
            const context = buildEmoteContext(e.emoteName, e.ownerName);
            const frameHint = e.isAnimated ? ` (${e.imageFrames.length} sequential frames shown)` : '';
            return `${i} — ${context}${frameHint}`;
        }).join('\n');
        contentParts.push({ text: `${promptText}\n${emoteList}` });

        try {
            const batchTimeout = Math.max(baseTimeoutMs, group.length * 2000 + 5000);
            const response = await Promise.race([
                genAI.models.generateContent({
                    model: geminiModel,
                    systemInstruction: SYSTEM_INSTRUCTION,
                    contents: contentParts,
                    config: {
                        responseMimeType: 'application/json',
                        responseJsonSchema: {
                            type: 'object',
                            properties: {
                                emotes: {
                                    type: 'array',
                                    description: 'One entry per emote in the same order as the input list.',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            index: { type: 'integer', description: 'Zero-based index matching the emote list.' },
                                            description: { type: 'string', description: 'A 2-6 word visual description of the emote, suitable for text-to-speech.' },
                                        },
                                        required: ['index', 'description'],
                                    },
                                },
                            },
                            required: ['emotes'],
                        },
                    },
                }),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Gemini batch timeout')), batchTimeout)
                ),
            ]);

            const parsed = JSON.parse(response.text);
            if (Array.isArray(parsed?.emotes)) {
                for (const entry of parsed.emotes) {
                    const idx = entry?.index;
                    const desc = entry?.description?.trim().replace(/[.!?,;:]+$/g, '');
                    if (typeof idx === 'number' && idx >= 0 && idx < group.length && desc) {
                        const emoteId = group[idx].emoteId;
                        cacheDescription(emoteId, desc, group[idx].emoteName, group[idx].ownerId);
                        results.set(emoteId, desc);
                    }
                }
            }
        } catch (error) {
            logger.info({ err: error.message, emoteCount: group.length }, 'Batch Gemini emote description failed');
        }
    };

    const staticPrompt = 'Describe each Twitch emote below in 2-6 words for text-to-speech. Use the emote name and channel name as clues to identify the subject — but do not echo the raw emote token verbatim in your reply (individual meaningful words from the name are fine). Focus on what it visually depicts. Be concise. No word "emote".';
    const animatedPrompt = 'Each emote below is animated — you are seeing sequential frames from its animation. Describe what happens across each animation in 2-6 words for text-to-speech. Use the emote name and channel name as clues to identify the subject — but do not echo the raw emote token verbatim in your reply (individual meaningful words from the name are fine). Focus on the action or transformation depicted. Be concise. No word "emote".';

    await Promise.all([
        describeBatch(staticEmotes, staticPrompt, timeoutMs),
        describeBatch(animatedEmotes, animatedPrompt, animatedTimeoutMs),
    ]);

    logger.debug({ static: staticEmotes.length, animated: animatedEmotes.length, described: results.size - (emoteEntries.length - uncached.length) }, 'Batch emote description complete');

    return results;
}
