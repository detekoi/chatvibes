// src/lib/ignoreList.js
//
// The TTS ignore list, keyed by immutable platform account IDs.
//
// It used to hold lowercased login names, which a viewer could shed by renaming
// their account — Twitch allows a login change every 60 days, and the stored
// string then matched nothing. The reverse was worse: Twitch releases abandoned
// logins back into the pool after about six months, so a stranger who claimed a
// name that was still on a list got silently muted with no way to find out why.
//
// Entries are stored on the channel config as `ignoredUserIds`, a map of
//
//     "<platform>:<accountId>"  ->  "<display label>"
//
// The label exists only so `!tts ignored` and the dashboard have something
// readable to print; nothing matches on it. It is refreshed opportunistically
// whenever we see that account speak under a new name.
//
// Both supported platforms hand us an immutable ID on every inbound message:
//   - Twitch  `chatter_user_id` / `user_id` on the EventSub payload (numeric).
//   - YouTube `authorExternalChannelId`, which yt-chat-proxy forwards as
//     `channelId` (the 24-character "UC…" channel ID). Handles, display names
//     and legacy usernames all change; the channel ID never does and is never
//     recycled.

export const PLATFORM_TWITCH = 'twitch';
export const PLATFORM_YOUTUBE = 'youtube';

/**
 * Build the map key for one account.
 * @param {string} platform PLATFORM_TWITCH or PLATFORM_YOUTUBE
 * @param {string|number} accountId Immutable platform account ID
 * @returns {string|null} Key, or null when the ID is missing
 */
export function ignoreKey(platform, accountId) {
    if (!platform || accountId === undefined || accountId === null) return null;
    const id = String(accountId).trim();
    return id ? `${platform}:${id}` : null;
}

/**
 * Whether an account is on the channel's ignore list.
 *
 * A missing ID means "not ignored" rather than an error: anonymous gifters and
 * anonymous cheerers legitimately arrive without one, and the old login-based
 * checks treated them the same way.
 *
 * @param {object} ttsConfig Channel config from getTtsState
 * @param {string} platform PLATFORM_TWITCH or PLATFORM_YOUTUBE
 * @param {string|number} accountId Immutable platform account ID
 * @returns {boolean}
 */
export function isIgnored(ttsConfig, platform, accountId) {
    const key = ignoreKey(platform, accountId);
    if (!key) return false;
    return Object.prototype.hasOwnProperty.call(ttsConfig?.ignoredUserIds || {}, key);
}

/** Convenience wrapper for the Twitch handlers, which are the majority caller. */
export function isTwitchUserIgnored(ttsConfig, userId) {
    return isIgnored(ttsConfig, PLATFORM_TWITCH, userId);
}

/** Convenience wrapper for the YouTube chat client. */
export function isYouTubeUserIgnored(ttsConfig, channelId) {
    return isIgnored(ttsConfig, PLATFORM_YOUTUBE, channelId);
}

/**
 * Split a stored key back into its parts. A key with no separator is treated as
 * Twitch so a hand-edited Firestore document degrades predictably.
 * @param {string} key
 * @returns {{ platform: string, accountId: string }}
 */
export function parseIgnoreKey(key) {
    const separator = String(key).indexOf(':');
    if (separator === -1) return { platform: PLATFORM_TWITCH, accountId: String(key) };
    return {
        platform: String(key).slice(0, separator),
        accountId: String(key).slice(separator + 1),
    };
}

/**
 * The ignore list as a sorted array, for display.
 * @param {object} ttsConfig Channel config from getTtsState
 * @returns {Array<{ key: string, platform: string, accountId: string, label: string }>}
 */
export function listIgnoredAccounts(ttsConfig) {
    return Object.entries(ttsConfig?.ignoredUserIds || {})
        .map(([key, label]) => ({ key, ...parseIgnoreKey(key), label: label || key }))
        .sort((a, b) => a.label.localeCompare(b.label));
}
