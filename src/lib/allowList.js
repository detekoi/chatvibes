// src/lib/allowList.js
// In-memory cache populated from Firestore managedChannels collection.
// Firestore is the single source of truth for which channels are allowed.

// Set of allowed broadcaster IDs (twitchUserId from managedChannels where isActive=true)
const allowedBroadcasterIds = new Set();

// Channel login name (lowercase) → Twitch User ID mapping for transparent lookups
const channelNameToIdMap = new Map();

// Twitch User ID → Channel login name (lowercase) reverse mapping
const channelIdToNameMap = new Map();

/**
 * Returns true if the broadcaster is permitted to use the bot.
 * Accepts either a Twitch User ID (numeric string) or a channel login name.
 * If no channels have been loaded yet, allows all (startup grace period).
 *
 * The allowed set is populated from Firestore managedChannels by channelManager.
 */
export function isChannelAllowed(identifier) {
  if (!identifier) return false;

  // Startup grace: if no channels loaded yet, allow all
  if (allowedBroadcasterIds.size === 0) return true;

  const normalized = String(identifier).trim();

  // Direct match against broadcaster IDs
  if (allowedBroadcasterIds.has(normalized)) return true;

  // Fallback: resolve login name to broadcaster ID via cache
  const lower = normalized.toLowerCase();
  const mappedId = channelNameToIdMap.get(lower);
  if (mappedId && allowedBroadcasterIds.has(mappedId)) return true;

  return false;
}

/**
 * Gets the Twitch User ID for a given channel login name from the cache.
 * Returns undefined if the channel is not known.
 * @param {string} channelName
 * @returns {string|undefined}
 */
export function getChannelIdFromName(channelName) {
  if (!channelName) return undefined;
  return channelNameToIdMap.get(String(channelName).trim().toLowerCase());
}

/**
 * Gets the channel login name for a given Twitch User ID from the cache.
 * Returns undefined if the ID is not known.
 * @param {string} twitchUserId
 * @returns {string|undefined}
 */
export function getChannelNameFromId(twitchUserId) {
  if (!twitchUserId) return undefined;
  return channelIdToNameMap.get(String(twitchUserId));
}

/**
 * Bulk-update the allowed set from Firestore managedChannels data.
 * Called by channelManager after loading active channels.
 * @param {Array<{name: string, twitchUserId: string|null}>} channels
 */
export function updateAllowedChannels(channels) {
  allowedBroadcasterIds.clear();
  channelIdToNameMap.clear();
  for (const ch of channels) {
    if (ch.twitchUserId) {
      const id = String(ch.twitchUserId);
      allowedBroadcasterIds.add(id);
      channelNameToIdMap.set(ch.name.toLowerCase(), id);
      channelIdToNameMap.set(id, ch.name.toLowerCase());
    }
  }
}

/**
 * Register a single channel login name → Twitch User ID mapping.
 * Used by channelManager's real-time listener when channels are added/modified.
 */
export function addAllowedChannel(channelName, twitchUserId) {
  if (channelName && twitchUserId) {
    const id = String(twitchUserId);
    allowedBroadcasterIds.add(id);
    channelNameToIdMap.set(channelName.toLowerCase(), id);
    channelIdToNameMap.set(id, channelName.toLowerCase());
  }
}

/**
 * Remove a channel from the allowed set.
 * Used when a channel becomes inactive via real-time listener.
 */
export function removeAllowedChannel(channelName, twitchUserId) {
  if (twitchUserId) {
    allowedBroadcasterIds.delete(String(twitchUserId));
    channelIdToNameMap.delete(String(twitchUserId));
  }
  if (channelName) {
    channelNameToIdMap.delete(channelName.toLowerCase());
  }
}
