// src/lib/rewardResolver.js
// Turn the reward name a moderator typed into one reward from the channel's list.
//
// Deterministic first, model second. The exact title, then a unique partial
// match (the typed words all appear in one title), settle nearly every case
// with no round-trip and no chance of surprise. Only when that finds nothing,
// or more than one, is the optional `llmPick` consulted — for typos,
// paraphrases and "the loud horn one". It is restricted to the candidates when
// there are some, and it may only *narrow*: a pick that is not in the pool, or
// that the model is not confident in, is discarded and the deterministic
// answer stands. So the model can never mute a reward the words could not
// have meant.

/**
 * Lowercase, strip surrounding quotes, collapse whitespace.
 * @param {string} s
 * @returns {string}
 */
export function normalizeTitle(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
        .trim();
}

/**
 * @typedef {{ id: string, title: string, prompt?: string }} RewardLike
 * @typedef {{ status: 'match', reward: RewardLike, via: 'exact'|'partial'|'llm' }
 *   | { status: 'ambiguous', candidates: RewardLike[] }
 *   | { status: 'none', candidates: [] }} Resolution
 */

/**
 * @param {string} query What the moderator typed.
 * @param {RewardLike[]} rewards
 * @returns {Resolution}
 */
export function matchRewardsDeterministically(query, rewards) {
    const q = normalizeTitle(query);
    if (!q || !Array.isArray(rewards) || rewards.length === 0) {
        return { status: 'none', candidates: [] };
    }

    const exact = rewards.filter(r => normalizeTitle(r.title) === q);
    if (exact.length === 1) return { status: 'match', reward: exact[0], via: 'exact' };
    if (exact.length > 1) return { status: 'ambiguous', candidates: exact };

    // Partial: the whole query inside the title, or every typed word inside it.
    // Word-level so "horn air" still finds "Air Horn".
    const tokens = q.split(' ');
    const partial = rewards.filter(r => {
        const t = normalizeTitle(r.title);
        return t.includes(q) || tokens.every(tok => t.includes(tok));
    });
    if (partial.length === 1) return { status: 'match', reward: partial[0], via: 'partial' };
    if (partial.length > 1) return { status: 'ambiguous', candidates: partial };

    return { status: 'none', candidates: [] };
}

/**
 * @param {string} query
 * @param {RewardLike[]} rewards
 * @param {{ llmPick?: (query: string, pool: RewardLike[]) => Promise<{ rewardId: string|null, confident: boolean }|null> }} [options]
 * @returns {Promise<Resolution>}
 */
export async function resolveReward(query, rewards, { llmPick } = {}) {
    const deterministic = matchRewardsDeterministically(query, rewards);
    if (deterministic.status === 'match') return deterministic;
    if (typeof llmPick !== 'function' || !Array.isArray(rewards) || rewards.length === 0) {
        return deterministic;
    }

    const pool = deterministic.status === 'ambiguous' ? deterministic.candidates : rewards;
    let pick = null;
    try {
        pick = await llmPick(query, pool);
    } catch {
        pick = null;
    }
    if (pick?.confident && pick.rewardId) {
        const reward = pool.find(r => r.id === pick.rewardId);
        if (reward) return { status: 'match', reward, via: 'llm' };
    }
    return deterministic;
}
