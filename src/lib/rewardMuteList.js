// src/lib/rewardMuteList.js
// Per-channel list of channel point rewards whose redemptions are NOT announced.
//
// A soundboard reward plays its own audio, so announcing "<user> redeemed
// Air Horn" on top of it is noise. This list is the exclusion set for the
// redemption announcement feature: every reward is announced unless its ID is
// here. It is an exclusion list rather than an allow list so a channel that
// never touches it, and every channel that predates it, hears no change.
//
// Format, on the channel config document:
//
//   mutedRewardIds: {
//     "<rewardId>": { title: "Air Horn", by: "twitch:99", at: "2026-09-01T…" }
//   }
//
// The key is Twitch's reward ID, which survives a rename; the title is stored
// for display only (the dashboard and `!tts redeems` print it) and goes stale
// if the streamer renames the reward. Nothing matches on it.
//
// The dashboard writes the same shape from chatvibes-web-ui
// (functions/src/services/mutedRewards.ts). Change both together.

/**
 * @param {object} ttsConfig Channel config.
 * @param {string} rewardId Twitch custom reward ID.
 * @returns {boolean} true when redemptions of this reward must not be announced.
 */
export function isRewardMuted(ttsConfig, rewardId) {
    if (!rewardId) return false;
    const map = ttsConfig?.mutedRewardIds;
    if (!map || typeof map !== 'object') return false;
    return Object.prototype.hasOwnProperty.call(map, rewardId);
}

/**
 * Read one stored value back into the full record shape. A bare string is
 * tolerated as a title so a hand-edited document still reads.
 * @param {unknown} value
 * @param {string} rewardId
 * @returns {{ title: string, by: string|null, at: string|null }}
 */
export function normalizeMutedRewardEntry(value, rewardId) {
    if (typeof value === 'string') {
        return { title: value.trim() || rewardId, by: null, at: null };
    }
    if (value && typeof value === 'object') {
        const title = typeof value.title === 'string' && value.title.trim() ? value.title.trim() : rewardId;
        return {
            title,
            by: typeof value.by === 'string' ? value.by : null,
            at: typeof value.at === 'string' ? value.at : null,
        };
    }
    return { title: rewardId, by: null, at: null };
}

/**
 * Build the value to store. Every field is written on every write, because
 * set({ merge: true }) deep-merges into the entry and a partial write would
 * inherit the previous record's fields.
 * @param {{ title: string, by?: string|null }} params
 * @returns {{ title: string, by: string|null, at: string }}
 */
export function buildMutedRewardEntry({ title, by } = {}) {
    return {
        title: String(title || '').trim(),
        by: typeof by === 'string' && by ? by : null,
        at: new Date().toISOString(),
    };
}

/**
 * Every muted reward, sorted by title for display.
 * @param {object} ttsConfig
 * @returns {Array<{ rewardId: string, title: string, by: string|null, at: string|null }>}
 */
export function listMutedRewards(ttsConfig) {
    const map = ttsConfig?.mutedRewardIds;
    if (!map || typeof map !== 'object') return [];
    return Object.entries(map)
        .map(([rewardId, value]) => ({ rewardId, ...normalizeMutedRewardEntry(value, rewardId) }))
        .sort((a, b) => a.title.localeCompare(b.title));
}
