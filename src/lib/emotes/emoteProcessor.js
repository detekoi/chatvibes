// src/lib/emotes/emoteProcessor.js
// Orchestrator: takes Twitch chat fragments, checks cache, calls Gemini, rebuilds the TTS string.
import logger from '../logger.js';
import { describeSingleEmote, describeBatchEmotes, isGeminiAvailable } from './emoteDescriberApi.js';
import { getUsersById } from '../../components/twitch/helixClient.js';

// In-memory cache: ownerId -> { displayName, cachedAt }
const ownerNameCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve emote owner IDs to display names via Twitch Helix API.
 * Batch-fetches uncached IDs and populates ownerNameCache.
 * Global emotes (owner_id "0") are silently mapped to null.
 * @param {Array<{type: string, emote?: {id: string, owner_id?: string}}>} fragments
 * @returns {Promise<void>}
 */
async function resolveEmoteOwnerNames(fragments) {
    const uncachedIds = new Set();
    for (const frag of fragments) {
        if (frag.type === 'emote' && frag.emote?.owner_id) {
            const ownerId = frag.emote.owner_id;
            if (ownerId === '0') {
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
        // Cache null for any IDs not returned (deleted accounts, etc.)
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
 * Look up the cached display name for an emote owner.
 * @param {string} ownerId
 * @returns {string | null}
 */
function getOwnerDisplayName(ownerId) {
    if (!ownerId || ownerId === '0') return null;
    return ownerNameCache.get(ownerId)?.displayName || null;
}

// ---------------------------------------------------------------------------
// groupFragments — pure helper, replaces the while-lookahead pattern
// ---------------------------------------------------------------------------

/**
 * Collapse consecutive runs of the same emote (ignoring whitespace-only fragments between them).
 * Text/mention fragments are kept in place.
 * Each entry from the original fragments array is returned augmented with a `count` property.
 *
 * @param {Array<{type: string, text: string, emote?: {id: string}}>} fragments
 * @returns {Array<{type: string, text: string, emote?: object, count: number}>}
 */
export function groupFragments(fragments) {
    const grouped = [];
    for (const frag of fragments) {
        // Skip whitespace-only text fragments between emotes (they are handled by join)
        if (frag.type === 'text' && !frag.text.trim()) continue;

        const last = grouped[grouped.length - 1];
        if (frag.type === 'emote' && last?.type === 'emote' && last.emote?.id === frag.emote?.id) {
            last.count = (last.count || 1) + 1;
        } else {
            grouped.push({ ...frag, count: 1 });
        }
    }
    return grouped;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Describe only the emote fragments in a message, returning a parenthetical summary.
 * Repeated identical emotes are counted: "(3 laughing emotes)".
 * This is used for messages that are emote-only or near-emote-only.
 *
 * @param {Array<{type: string, text: string, emote?: {id: string}}>} fragments
 * @returns {Promise<string | null>}
 */
export async function describeEmoteFragments(fragments) {
    if (!isGeminiAvailable() || !fragments?.length) return null;

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

    await resolveEmoteOwnerNames(emoteFragments);

    const uniqueEmotes = Array.from(emoteCounts.entries());
    const descriptions = await Promise.all(
        uniqueEmotes.map(([emoteId, { name, ownerId, isAnimated }]) =>
            describeSingleEmote(emoteId, name, getOwnerDisplayName(ownerId), isAnimated)
        )
    );

    const parts = [];
    for (let i = 0; i < uniqueEmotes.length; i++) {
        const [, { count }] = uniqueEmotes[i];
        const desc = descriptions[i];
        if (!desc) continue;
        parts.push(count > 1 ? `(${count} ${desc} emotes)` : `(${desc} emote)`);
    }

    if (parts.length === 0) {
        logger.info({ emoteCount: uniqueEmotes.length, emoteNames: uniqueEmotes.map(([, { name }]) => name) }, 'All emote descriptions failed — returning null');
        return null;
    }

    return parts.join(' ');
}

/**
 * Process a full message by replacing emote fragments with AI descriptions inline.
 * Consecutive repeated emotes are collapsed via groupFragments().
 * Falls back to the raw emote name if description fails.
 *
 * @param {Array<{type: string, text: string, emote?: {id: string}}>} fragments
 * @returns {Promise<string | null>}
 */
export async function processMessageWithEmoteDescriptions(fragments) {
    if (!fragments?.length) return null;

    const emoteFragments = fragments.filter(f => f.type === 'emote' && f.emote?.id);
    if (emoteFragments.length === 0) return null;

    // Start owner name resolution early (usually already cached)
    const ownerNamesPromise = resolveEmoteOwnerNames(emoteFragments);

    // Collect unique emote IDs
    const uniqueEmoteIds = new Map(); // emoteId -> { name, ownerId, isAnimated }
    for (const frag of emoteFragments) {
        if (!uniqueEmoteIds.has(frag.emote.id)) {
            const isAnimated = Array.isArray(frag.emote.format) && frag.emote.format.includes('animated');
            uniqueEmoteIds.set(frag.emote.id, { name: frag.text, ownerId: frag.emote.owner_id, isAnimated });
        }
    }

    await ownerNamesPromise;

    // [emoteId, emoteName, ownerName, isAnimated, ownerId] tuples
    const emoteEntries = Array.from(uniqueEmoteIds.entries()).map(
        ([id, { name, ownerId, isAnimated }]) => [id, name, getOwnerDisplayName(ownerId), isAnimated, ownerId]
    );

    // Single emote: direct call is faster than batch overhead
    let descriptionMap;
    if (emoteEntries.length === 1) {
        descriptionMap = new Map();
        const desc = await describeSingleEmote(...emoteEntries[0]);
        if (desc) descriptionMap.set(emoteEntries[0][0], desc);
    } else {
        descriptionMap = await describeBatchEmotes(emoteEntries);
    }

    if (descriptionMap.size === 0) {
        logger.info({ emoteCount: uniqueEmoteIds.size, emoteNames: Array.from(uniqueEmoteIds.values()) }, 'All emote descriptions failed — returning null');
        return null;
    }

    // Walk the grouped fragments, assembling the output string
    const grouped = groupFragments(fragments);
    const outputParts = [];

    for (const frag of grouped) {
        if (frag.type === 'emote' && frag.emote?.id) {
            const desc = descriptionMap.get(frag.emote.id);
            if (desc) {
                outputParts.push(frag.count > 1 ? `(${frag.count} ${desc} emotes)` : `(${desc} emote)`);
            } else {
                // Description failed — fall back to raw emote name
                outputParts.push(frag.count > 1 ? `(${frag.count} ${frag.text})` : frag.text);
            }
        } else {
            const text = frag.text.trim();
            if (text) outputParts.push(text);
        }
    }

    if (outputParts.length === 0) return null;

    return outputParts.join(' ');
}

// Exported for testing
export { ownerNameCache as _ownerNameCache };
