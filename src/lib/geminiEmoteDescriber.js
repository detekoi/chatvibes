// src/lib/geminiEmoteDescriber.js
// Uses Google Gemini Flash Lite to describe Twitch emotes visually for TTS accessibility
import { GoogleGenAI } from '@google/genai';
import { Firestore } from '@google-cloud/firestore';
import sharp from 'sharp';
import logger from './logger.js';
import { getUsersById } from '../components/twitch/helixClient.js';

const GEMINI_MODEL = 'gemini-3.1-flash-lite-preview';

// System instruction applied to all emote description calls.
// Establishes accessibility framing and guards against common model failures.
const SYSTEM_INSTRUCTION = `You are an accessibility assistant that describes Twitch emotes for text-to-speech. Your goal is precise, natural-sounding visual descriptions.

Rules:
- Reply with ONLY the short description — no preamble, no quotes, no trailing punctuation.
- Do not output the emote's raw alphanumeric string verbatim (e.g. do not say "parfai14Parfait" or "LUL"). You may use meaningful English words embedded in the name (e.g. "parfait dessert" from "parfai14Parfait" is fine), but do not begin your reply with the full emote token itself.
- When describing pride flags, always name the specific flag rather than generic terms. Examples: "rainbow Pride flag", "bisexual Pride flag", "transgender Pride flag", "lesbian Pride flag", "pansexual Pride flag", "nonbinary Pride flag", "asexual Pride flag". These are important cultural identifiers and accurate naming is essential for accessibility.`;
const EMOTE_CDN_URL = 'https://static-cdn.jtvnw.net/emoticons/v2';
const EMOTE_IMAGE_FORMAT = 'static/dark/3.0';
const ANIMATED_EMOTE_IMAGE_FORMAT = 'animated/dark/3.0';
const MAX_GIF_FRAMES = 3; // Number of evenly-spaced frames to sample from animated GIFs
const GEMINI_TIMEOUT_MS = 8000;
const ANIMATED_GEMINI_TIMEOUT_MS = 12000; // Animated emotes need more time for multi-image inference

// In-memory cache (L1): emoteId -> { description, cachedAt }
const descriptionCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Firestore persistent cache (L2): emoteDescriptions collection
const EMOTE_DESCRIPTIONS_COLLECTION = 'emoteDescriptions';
let emoteDescriptionsDb = null;

// In-memory cache: ownerId -> { displayName, cachedAt }
const ownerNameCache = new Map();

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
 * Initialize the Firestore client for persistent emote description storage.
 * Call once during bot startup.
 */
export function initEmoteDescriptionStore() {
    try {
        emoteDescriptionsDb = new Firestore();
        logger.info('Emote description Firestore store initialized');
        return true;
    } catch (error) {
        logger.error({ err: error }, 'Failed to initialize emote description Firestore store');
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
 * Get the animated emote GIF URL from a Twitch emote ID.
 * @param {string} emoteId 
 * @returns {string}
 */
export function getAnimatedEmoteUrl(emoteId) {
    return `${EMOTE_CDN_URL}/${emoteId}/${ANIMATED_EMOTE_IMAGE_FORMAT}`;
}

/**
 * Fetch an emote image as bytes (static PNG).
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
 * Fetch an animated emote GIF and extract evenly-spaced frames as PNG buffers using sharp.
 * Sharp uses native libvips for fast GIF decoding with automatic frame coalescing.
 * @param {string} emoteId
 * @returns {Promise<Array<{data: Buffer, mimeType: string}> | null>}
 */
async function fetchAnimatedEmoteFrames(emoteId) {
    const pipelineStart = Date.now();
    try {
        const url = getAnimatedEmoteUrl(emoteId);
        const response = await fetch(url);
        if (!response.ok) {
            logger.debug({ emoteId, status: response.status }, 'Failed to fetch animated emote GIF');
            return null;
        }
        const arrayBuffer = await response.arrayBuffer();
        const gifBuffer = Buffer.from(arrayBuffer);
        const fetchMs = Date.now() - pipelineStart;

        // Load GIF metadata to determine frame count
        const extractStart = Date.now();
        const metadata = await sharp(gifBuffer, { animated: true }).metadata();
        const { pages } = metadata;

        if (!pages || pages <= 1) {
            // Not animated or single frame — return as static PNG
            const data = await sharp(gifBuffer).png().toBuffer();
            logger.info({ emoteId, fetchMs, extractMs: Date.now() - extractStart, totalMs: Date.now() - pipelineStart, pages: pages || 1 }, 'Animated emote single frame extracted');
            return [{ data, mimeType: 'image/png' }];
        }

        // Compute evenly-spaced frame indices (first, middle, last)
        const sampleCount = Math.min(MAX_GIF_FRAMES, pages);
        const selectedIndices = [];
        for (let i = 0; i < sampleCount; i++) {
            selectedIndices.push(Math.floor(i * (pages - 1) / Math.max(sampleCount - 1, 1)));
        }

        // Extract each selected frame using sharp's page option (selects a single GIF page directly)
        const frameBuffers = await Promise.all(
            selectedIndices.map(async (frameIdx) => {
                const data = await sharp(gifBuffer, { page: frameIdx })
                    .png()
                    .toBuffer();
                return { data, mimeType: 'image/png' };
            })
        );

        const extractMs = Date.now() - extractStart;
        const totalMs = Date.now() - pipelineStart;
        logger.info({ emoteId, fetchMs, extractMs, totalMs, totalFrames: pages, sampledFrames: frameBuffers.length, frameIndices: selectedIndices }, 'Animated emote frames extracted');
        return frameBuffers;
    } catch (error) {
        logger.info({ err: error.message, emoteId, pipelineMs: Date.now() - pipelineStart }, 'Error extracting animated emote frames');
        return null;
    }
}

/**
 * Get a cached description for an emote, or null if not cached/expired.
 * Checks L1 (in-memory) first, then L2 (Firestore).
 * @param {string} emoteId
 * @returns {Promise<string | null>}
 */
async function getCachedDescription(emoteId) {
    // L1: in-memory cache
    const cached = descriptionCache.get(emoteId);
    if (cached && (Date.now() - cached.cachedAt) < CACHE_TTL_MS) {
        return cached.description;
    }
    if (cached) {
        descriptionCache.delete(emoteId);
    }

    // L2: Firestore persistent cache
    if (emoteDescriptionsDb) {
        try {
            const doc = await emoteDescriptionsDb
                .collection(EMOTE_DESCRIPTIONS_COLLECTION)
                .doc(emoteId)
                .get();
            if (doc.exists) {
                const data = doc.data();
                if (data.description) {
                    // Populate L1 from L2 hit, preserving manuallySet flag
                    descriptionCache.set(emoteId, { description: data.description, cachedAt: Date.now(), manuallySet: data.manuallySet || false });
                    logger.debug({ emoteId, emoteName: data.emoteName, manuallySet: data.manuallySet || false }, 'Emote description loaded from Firestore cache');
                    return data.description;
                }
            }
        } catch (error) {
            logger.warn({ err: error.message, emoteId }, 'Firestore emote description lookup failed, falling through to Gemini');
        }
    }

    return null;
}

/**
 * Cache an emote description in both L1 (in-memory) and L2 (Firestore).
 * Firestore write is fire-and-forget to avoid blocking TTS.
 * @param {string} emoteId
 * @param {string} description
 * @param {string} [emoteName] - The text name of the emote for metadata
 * @param {string} [ownerId] - The Twitch user ID of the emote owner ("0" for global emotes)
 */
function cacheDescription(emoteId, description, emoteName, ownerId) {
    // L1: in-memory (only update if not manually set)
    const existing = descriptionCache.get(emoteId);
    if (existing?.manuallySet) {
        // Manual description takes precedence — skip AI overwrite
        logger.debug({ emoteId, emoteName }, 'Skipping AI cache write — manual description in place');
        return;
    }
    descriptionCache.set(emoteId, { description, cachedAt: Date.now(), manuallySet: false });

    // L2: Firestore (fire-and-forget)
    // Note: payload intentionally omits `manuallySet` so that merge:true preserves any
    // existing manuallySet:true flag in Firestore (set via `!tts emote set`).
    // The L1 guard above already handles the hot-cache case.
    if (emoteDescriptionsDb) {
        const data = { description, emoteName: emoteName || null, updatedAt: Firestore.FieldValue.serverTimestamp() };
        if (ownerId !== undefined) data.ownerId = ownerId;
        emoteDescriptionsDb
            .collection(EMOTE_DESCRIPTIONS_COLLECTION)
            .doc(emoteId)
            .set(data, { merge: true })
            .catch(error => logger.warn({ err: error.message, emoteId }, 'Firestore emote description write failed'));
    }
}

/**
 * Invalidate (delete) a cached emote description from both L1 and L2.
 * Used by the regeneration command.
 * @param {string} emoteId
 * @returns {Promise<boolean>} true if Firestore deletion succeeded
 */
export async function invalidateEmoteDescription(emoteId) {
    // L1: in-memory
    descriptionCache.delete(emoteId);

    // L2: Firestore
    if (emoteDescriptionsDb) {
        try {
            await emoteDescriptionsDb
                .collection(EMOTE_DESCRIPTIONS_COLLECTION)
                .doc(emoteId)
                .delete();
            logger.info({ emoteId }, 'Emote description invalidated from Firestore');
            return true;
        } catch (error) {
            logger.error({ err: error.message, emoteId }, 'Failed to invalidate emote description from Firestore');
            return false;
        }
    }
    return true;
}

/**
 * Manually set an emote description in both L1 and L2 caches.
 * Used by the `!tts emote set` command.
 * @param {string} emoteId
 * @param {string} emoteName
 * @param {string} description
 * @param {string} [ownerId] - The Twitch user ID of the emote owner
 * @returns {Promise<boolean>} true if Firestore write succeeded
 */
export async function setEmoteDescription(emoteId, emoteName, description, ownerId) {
    // L1: in-memory — mark as manually set so AI won't overwrite
    descriptionCache.set(emoteId, { description, cachedAt: Date.now(), manuallySet: true });

    // L2: Firestore
    if (emoteDescriptionsDb) {
        try {
            const data = { description, emoteName, manuallySet: true, updatedAt: Firestore.FieldValue.serverTimestamp() };
            if (ownerId !== undefined) data.ownerId = ownerId;
            await emoteDescriptionsDb
                .collection(EMOTE_DESCRIPTIONS_COLLECTION)
                .doc(emoteId)
                .set(data, { merge: true });
            logger.info({ emoteId, emoteName, description }, 'Emote description manually set in Firestore');
            return true;
        } catch (error) {
            logger.error({ err: error.message, emoteId }, 'Failed to set emote description in Firestore');
            return false;
        }
    }
    return true;
}

/**
 * Get a stored emote description from Firestore by emote ID.
 * @param {string} emoteId
 * @returns {Promise<{description: string, emoteName: string, updatedAt: Date} | null>}
 */
export async function getStoredEmoteDescription(emoteId) {
    if (!emoteDescriptionsDb) return null;
    try {
        const doc = await emoteDescriptionsDb
            .collection(EMOTE_DESCRIPTIONS_COLLECTION)
            .doc(emoteId)
            .get();
        if (doc.exists) {
            const data = doc.data();
            return {
                description: data.description,
                emoteName: data.emoteName || null,
                updatedAt: data.updatedAt?.toDate() || null,
            };
        }
        return null;
    } catch (error) {
        logger.debug({ err: error.message, emoteId }, 'Failed to read emote description from Firestore');
        return null;
    }
}

/**
 * Find emote descriptions by emote name (case-insensitive search).
 * Returns all matching documents.
 * @param {string} emoteName
 * @returns {Promise<Array<{emoteId: string, description: string, emoteName: string}>>}
 */
export async function findEmoteDescriptionsByName(emoteName) {
    if (!emoteDescriptionsDb) return [];
    try {
        const snapshot = await emoteDescriptionsDb
            .collection(EMOTE_DESCRIPTIONS_COLLECTION)
            .where('emoteName', '==', emoteName)
            .get();
        const results = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            results.push({
                emoteId: doc.id,
                description: data.description,
                emoteName: data.emoteName,
                ownerId: data.ownerId || null,
            });
        });
        return results;
    } catch (error) {
        logger.debug({ err: error.message, emoteName }, 'Firestore emote name search failed');
        return [];
    }
}

/**
 * Resolve emote owner IDs to display names.
 * Batch-fetches uncached owner IDs from the Twitch Helix API and populates the cache.
 * Global emotes (owner_id "0") are hardcoded to "Twitch".
 * @param {Array<{type: string, emote?: {id: string, owner_id?: string}}>} fragments
 * @returns {Promise<void>}
 */
async function resolveEmoteOwnerNames(fragments) {
    const uncachedIds = new Set();
    for (const frag of fragments) {
        if (frag.type === 'emote' && frag.emote?.owner_id) {
            const ownerId = frag.emote.owner_id;
            if (ownerId === '0') {
                // Global emotes — hardcode
                ownerNameCache.set('0', { displayName: null, cachedAt: Date.now() });
            } else if (!ownerNameCache.has(ownerId) || (Date.now() - ownerNameCache.get(ownerId).cachedAt) >= CACHE_TTL_MS) {
                uncachedIds.add(ownerId);
            }
        }
    }

    if (uncachedIds.size === 0) return;

    try {
        const users = await getUsersById(Array.from(uncachedIds));
        for (const user of users) {
            ownerNameCache.set(user.id, { displayName: user.display_name, cachedAt: Date.now() });
        }
        // Cache null for any IDs that weren't returned (deleted accounts, etc.)
        for (const id of uncachedIds) {
            if (!ownerNameCache.has(id)) {
                ownerNameCache.set(id, { displayName: null, cachedAt: Date.now() });
            }
        }
        logger.debug({ resolved: users.length, requested: uncachedIds.size }, 'Emote owner names resolved');
    } catch (error) {
        logger.info({ err: error.message, ownerIds: Array.from(uncachedIds) }, 'Failed to resolve emote owner names');
    }
}

/**
 * Get the cached display name for an emote owner, or null if unknown.
 * @param {string} ownerId
 * @returns {string | null}
 */
function getOwnerDisplayName(ownerId) {
    if (!ownerId || ownerId === '0') return null;
    const cached = ownerNameCache.get(ownerId);
    return cached?.displayName || null;
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
 * For animated emotes, extracts multiple frames using sharp and sends them as a sequence.
 * @param {string} emoteId 
 * @param {string} emoteName - The text name of the emote (e.g. "LUL")
 * @param {string | null} [ownerName] - The display name of the channel that owns the emote
 * @param {boolean} [isAnimated=false] - Whether the emote is an animated GIF
 * @param {string} [ownerId] - The Twitch user ID of the emote owner
 * @returns {Promise<string | null>}
 */
async function describeSingleEmote(emoteId, emoteName, ownerName = null, isAnimated = false, ownerId = null) {
    // Check cache first (L1 in-memory, then L2 Firestore)
    const cached = await getCachedDescription(emoteId);
    if (cached) return cached;

    if (!genAI) return null;

    // For animated emotes, try frame extraction first
    let imageParts = null;
    let animatedSuccess = false;

    if (isAnimated) {
        const frames = await fetchAnimatedEmoteFrames(emoteId);
        if (frames && frames.length > 1) {
            imageParts = frames.map(frame => ({
                inlineData: {
                    mimeType: frame.mimeType,
                    data: frame.data.toString('base64'),
                },
            }));
            animatedSuccess = true;
        }
        // If frame extraction fails or returns single frame, fall through to static PNG
    }

    // Fallback to static PNG for non-animated or if frame extraction failed
    if (!imageParts) {
        const imageData = await fetchEmoteImage(emoteId);
        if (!imageData) {
            logger.info({ emoteId, emoteName }, 'Emote image fetch failed — cannot describe');
            return null;
        }
        imageParts = [{
            inlineData: {
                mimeType: imageData.mimeType,
                data: imageData.data.toString('base64'),
            },
        }];
    }

    try {
        const emoteContext = buildEmoteContext(emoteName, ownerName);
        const prompt = animatedSuccess
            ? `These are ${imageParts.length} sequential frames from an animated ${emoteContext}. Describe what happens across the animation in 2-6 words for text-to-speech. Use the emote name and channel name as clues to identify the subject — but do not echo the raw emote token verbatim in your reply (individual meaningful words from the name are fine). Focus on the action or transformation depicted. Be concise. No word "emote".`
            : `Describe this ${emoteContext} in 2-6 words for text-to-speech. Use the emote name and channel name as clues to identify the subject — but do not echo the raw emote token verbatim in your reply (individual meaningful words from the name are fine). Focus on what it visually depicts. Be concise. No word "emote".`;

        const contents = [...imageParts, { text: prompt }];

        const response = await Promise.race([
            genAI.models.generateContent({
                model: GEMINI_MODEL,
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
                setTimeout(() => reject(new Error('Gemini timeout')), animatedSuccess ? ANIMATED_GEMINI_TIMEOUT_MS : GEMINI_TIMEOUT_MS)
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
 * Sends all images together with a numbered prompt for efficient batch processing.
 * Animated emotes have their frames extracted via sharp and sent as a sequence per emote.
 * @param {Array<[string, string, string|null, boolean, string|null]>} emoteEntries - Array of [emoteId, emoteName, ownerName, isAnimated, ownerId] tuples
 * @returns {Promise<Map<string, string>>} Map of emoteId -> description
 */
async function describeBatchEmotes(emoteEntries) {
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

    // Fetch all images in parallel — animated emotes get frames via sharp, static get single PNG
    const imagePromises = uncached.map(async ([emoteId, , , isAnimated,]) => {
        if (isAnimated) {
            const frames = await fetchAnimatedEmoteFrames(emoteId);
            if (frames && frames.length > 1) return { frames, isAnimated: true };
            // Fall back to static PNG if frame extraction fails or returns single frame
        }
        const staticImg = await fetchEmoteImage(emoteId);
        return staticImg ? { frames: [staticImg], isAnimated: false } : null;
    });
    const images = await Promise.all(imagePromises);

    // Filter to only emotes with successful image fetches
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

    // Split into animated and static groups for separate, focused prompts
    const staticEmotes = withImages.filter(e => !e.isAnimated);
    const animatedEmotes = withImages.filter(e => e.isAnimated);

    /**
     * Send a batch Gemini call for a group of emotes with a dedicated prompt.
     * @param {Array} group - Emotes to describe
     * @param {string} promptText - The prompt tailored to this group type
     * @param {number} timeoutMs - Timeout for this batch
     */
    const describeBatch = async (group, promptText, timeoutMs) => {
        if (group.length === 0) return;

        const contentParts = [];
        for (const emote of group) {
            for (const frame of emote.imageFrames) {
                contentParts.push({
                    inlineData: {
                        mimeType: frame.mimeType,
                        data: frame.data.toString('base64'),
                    },
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
            const batchTimeout = Math.max(timeoutMs, group.length * 2000 + 5000);
            const response = await Promise.race([
                genAI.models.generateContent({
                    model: GEMINI_MODEL,
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

    // Send separate calls in parallel with dedicated prompts
    const staticPrompt = 'Describe each Twitch emote below in 2-6 words for text-to-speech. Use the emote name and channel name as clues to identify the subject — but do not echo the raw emote token verbatim in your reply (individual meaningful words from the name are fine). Focus on what it visually depicts. Be concise. No word "emote".';
    const animatedPrompt = 'Each emote below is animated — you are seeing sequential frames from its animation. Describe what happens across each animation in 2-6 words for text-to-speech. Use the emote name and channel name as clues to identify the subject — but do not echo the raw emote token verbatim in your reply (individual meaningful words from the name are fine). Focus on the action or transformation depicted. Be concise. No word "emote".';

    await Promise.all([
        describeBatch(staticEmotes, staticPrompt, GEMINI_TIMEOUT_MS),
        describeBatch(animatedEmotes, animatedPrompt, ANIMATED_GEMINI_TIMEOUT_MS),
    ]);

    logger.debug({ static: staticEmotes.length, animated: animatedEmotes.length, described: results.size - (emoteEntries.length - uncached.length) }, 'Batch emote description complete');

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
    const emoteCounts = new Map(); // emoteId -> { name, count, ownerId, isAnimated }
    for (const frag of emoteFragments) {
        const id = frag.emote.id;
        const existing = emoteCounts.get(id);
        if (existing) {
            existing.count++;
        } else {
            const isAnimated = Array.isArray(frag.emote.format) && frag.emote.format.includes('animated');
            emoteCounts.set(id, { name: frag.text, count: 1, ownerId: frag.emote.owner_id, isAnimated });
        }
    }

    // Resolve owner names in parallel with emote description
    // Start the Helix call early; describeSingleEmote will read from the ownerNameCache
    const ownerNamesPromise = resolveEmoteOwnerNames(emoteFragments);

    // Describe each unique emote (in parallel, with caching)
    const uniqueEmotes = Array.from(emoteCounts.entries());
    // Wait for owner names before building prompts (they're usually cached after first call)
    await ownerNamesPromise;
    const descriptionPromises = uniqueEmotes.map(([emoteId, { name, ownerId, isAnimated }]) =>
        describeSingleEmote(emoteId, name, getOwnerDisplayName(ownerId), isAnimated)
    );

    const descriptions = await Promise.all(descriptionPromises);

    // Build the final text
    const parts = [];
    for (let i = 0; i < uniqueEmotes.length; i++) {
        const [, { count }] = uniqueEmotes[i];
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

    // Start owner name resolution in parallel with deduplication work
    const ownerNamesPromise = resolveEmoteOwnerNames(emoteFragments);

    // Collect unique emote IDs and describe them all in parallel
    const uniqueEmoteIds = new Map(); // emoteId -> { name, ownerId, isAnimated }
    for (const frag of emoteFragments) {
        if (!uniqueEmoteIds.has(frag.emote.id)) {
            const isAnimated = Array.isArray(frag.emote.format) && frag.emote.format.includes('animated');
            uniqueEmoteIds.set(frag.emote.id, { name: frag.text, ownerId: frag.emote.owner_id, isAnimated });
        }
    }

    // Wait for owner names before building prompts
    await ownerNamesPromise;

    // [emoteId, emoteName, ownerName, isAnimated, ownerId] tuples
    const emoteEntries = Array.from(uniqueEmoteIds.entries()).map(
        ([id, { name, ownerId, isAnimated }]) => [id, name, getOwnerDisplayName(ownerId), isAnimated, ownerId]
    );

    // Use batch multi-image call for efficiency (1 API call for all emotes)
    let descriptionMap;
    if (emoteEntries.length === 1) {
        // Single emote — direct call is faster
        descriptionMap = new Map();
        const desc = await describeSingleEmote(emoteEntries[0][0], emoteEntries[0][1], emoteEntries[0][2], emoteEntries[0][3], emoteEntries[0][4]);
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
export { descriptionCache as _descriptionCache, ownerNameCache as _ownerNameCache };
