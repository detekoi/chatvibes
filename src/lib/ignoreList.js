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
//     "<platform>:<accountId>"  ->  { label, source, by, at }
//
//   label   Display text for `!tts ignored` and the dashboard. Nothing matches
//           on it, and it goes stale when someone renames.
//   source  IGNORE_SOURCE_SELF or IGNORE_SOURCE_MODERATOR — who imposed the
//           entry, which is what decides who may lift it. A viewer may clear
//           their own opt-out; only a moderator may clear a moderator's mute.
//           Without this the two are indistinguishable, and the ban a mod
//           placed on an abuser is one request away from the abuser clearing it.
//   by      The acting account's key, in the same "<platform>:<id>" form. An
//           immutable ID rather than a name, so the audit trail survives a
//           rename. Equal to the entry's own key for a self opt-out.
//   at      ISO 8601 string, display only. Deliberately not a Firestore
//           serverTimestamp sentinel: this map is written by three separate
//           codebases, and a sentinel nested inside a map value is a sharp edge
//           none of them need for a field that is only ever printed.
//
// A value may also be a bare display-name string, the shape this map held before
// provenance existed. Those normalize to IGNORE_SOURCE_MODERATOR — unknown
// provenance is never self-clearable, so no mute predating this change can be
// shed by the account it was aimed at.
//
// Both supported platforms hand us an immutable ID on every inbound message:
//   - Twitch  `chatter_user_id` / `user_id` on the EventSub payload (numeric).
//   - YouTube `authorExternalChannelId`, which yt-chat-proxy forwards as
//     `channelId` (the 24-character "UC…" channel ID). Handles, display names
//     and legacy usernames all change; the channel ID never does and is never
//     recycled.

export const PLATFORM_TWITCH = 'twitch';
export const PLATFORM_YOUTUBE = 'youtube';

/** The viewer put themselves on the list, and may take themselves back off. */
export const IGNORE_SOURCE_SELF = 'self';
/** A moderator or the broadcaster imposed it; only they can lift it. */
export const IGNORE_SOURCE_MODERATOR = 'moderator';

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
 * Presence of the key is the whole test, so this stays correct whatever shape
 * the value takes — every hot-path caller that drops a message goes through
 * here and none of them had to change when provenance was added.
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
 * Read one stored value into the current entry shape.
 *
 * Anything that is not a plain object — a bare label string from before
 * provenance existed, but equally a null or an array from a hand-edited
 * document — is read as moderator-imposed. So is an object whose `source` is
 * missing or unrecognized. The default runs one way on purpose: guessing "self"
 * would hand an abuser the ability to lift their own mute, while guessing
 * "moderator" only costs a viewer one moderator action.
 *
 * @param {unknown} value Raw map value
 * @param {string} key The entry's key, used as the label of last resort
 * @returns {{ label: string, source: string, by: string|null, at: string|null }}
 */
export function normalizeIgnoreEntry(value, key) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        const label = typeof value === 'string' && value ? value : key;
        return { label, source: IGNORE_SOURCE_MODERATOR, by: null, at: null };
    }
    return {
        label: value.label || key,
        source: value.source === IGNORE_SOURCE_SELF ? IGNORE_SOURCE_SELF : IGNORE_SOURCE_MODERATOR,
        by: value.by || null,
        at: value.at || null,
    };
}

/**
 * The stored entry for one account, or null when it is not on the list.
 * Uses the same prototype-safe presence check as isIgnored, so an account whose
 * key spells "constructor" cannot inherit a match from Object.prototype.
 *
 * @param {object} ttsConfig Channel config from getTtsState
 * @param {string} platform PLATFORM_TWITCH or PLATFORM_YOUTUBE
 * @param {string|number} accountId Immutable platform account ID
 * @returns {{ key: string, platform: string, accountId: string, label: string,
 *            source: string, by: string|null, at: string|null }|null}
 */
export function getIgnoreEntry(ttsConfig, platform, accountId) {
    const key = ignoreKey(platform, accountId);
    if (!key) return null;
    const entries = ttsConfig?.ignoredUserIds || {};
    if (!Object.prototype.hasOwnProperty.call(entries, key)) return null;
    return { key, ...parseIgnoreKey(key), ...normalizeIgnoreEntry(entries[key], key) };
}

/**
 * Whether the account this entry belongs to may remove it themselves.
 * @param {{ source?: string }|null|undefined} entry From getIgnoreEntry
 * @returns {boolean}
 */
export function canSelfUnignore(entry) {
    return entry?.source === IGNORE_SOURCE_SELF;
}

/**
 * Build the value to store for one entry.
 *
 * Every field is written every time, never a partial object. Writes go through
 * Firestore's `{ merge: true }`, which deep-merges into the entry object as well
 * as into the map — so omitting `source` here would silently inherit whatever
 * the previous write left, and a moderator muting someone who had opted out
 * themselves would leave the entry marked `self` and still self-clearable.
 *
 * @param {{ label?: string, source?: string, by?: string|null }} fields
 * @returns {{ label: string, source: string, by: string|null, at: string }}
 */
export function buildIgnoreEntry({ label, source, by } = {}) {
    return {
        label: label || '',
        source: source === IGNORE_SOURCE_SELF ? IGNORE_SOURCE_SELF : IGNORE_SOURCE_MODERATOR,
        by: by || null,
        at: new Date().toISOString(),
    };
}

/**
 * The ignore list as a sorted array, for display.
 * @param {object} ttsConfig Channel config from getTtsState
 * @returns {Array<{ key: string, platform: string, accountId: string, label: string,
 *                   source: string, by: string|null, at: string|null }>}
 */
export function listIgnoredAccounts(ttsConfig) {
    return Object.entries(ttsConfig?.ignoredUserIds || {})
        .map(([key, value]) => ({ key, ...parseIgnoreKey(key), ...normalizeIgnoreEntry(value, key) }))
        .sort((a, b) => a.label.localeCompare(b.label));
}
