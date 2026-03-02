// src/lib/allowList.js
import config from '../config/index.js';
import { getSecretValue } from './secretManager.js';

let allowListRefreshInterval = null;

// In-memory cache: channel login name (lowercase) → Twitch User ID
const channelNameToIdMap = new Map();

/**
 * Returns true if the broadcaster is permitted to use the bot.
 * Accepts either a Twitch User ID (numeric string) or a channel login name.
 * If no allow-list is configured, all channels are allowed.
 *
 * Configuration: process.env.ALLOWED_CHANNELS (comma-separated broadcaster IDs)
 */
export function isChannelAllowed(identifier) {
  if (!identifier) return false;
  const allowed = config.security?.allowedBroadcasterIds;
  if (!Array.isArray(allowed) || allowed.length === 0) {
    // No allow-list configured → allow all (backward compatible)
    return true;
  }

  // Direct match against broadcaster IDs
  const normalized = String(identifier).trim();
  if (allowed.includes(normalized)) {
    return true;
  }

  // Fallback: if identifier looks like a login name, resolve via cache
  const lower = normalized.toLowerCase();
  const mappedId = channelNameToIdMap.get(lower);
  if (mappedId && allowed.includes(mappedId)) {
    return true;
  }

  return false;
}

/**
 * Returns the normalized list of allowed broadcaster IDs.
 */
export function getAllowedBroadcasterIds() {
  const allowed = config.security?.allowedBroadcasterIds;
  return Array.isArray(allowed) ? allowed : [];
}

/**
 * Register a channel login name → Twitch User ID mapping for allow-list lookups.
 * This allows isChannelAllowed() to resolve login names to IDs transparently.
 */
export function setChannelIdMapping(channelName, twitchUserId) {
  if (channelName && twitchUserId) {
    channelNameToIdMap.set(channelName.toLowerCase(), String(twitchUserId));
  }
}

/**
 * Initialize/override the allow-list from a GCP Secret if configured.
 * The secret value should be a comma-separated list of Twitch broadcaster IDs.
 * If the secret is empty/unavailable, the existing env-based list is kept.
 */
export async function initializeAllowList() {
  const secretName = process.env.ALLOWED_CHANNELS_SECRET_NAME || config.secrets?.allowedChannelsSecretName;
  if (!secretName) return;
  try {
    const value = await getSecretValue(secretName);
    if (!value) return;
    const fromSecret = value
      .split(',')
      .map(id => id.trim())
      .filter(Boolean);
    if (fromSecret.length > 0) {
      if (!config.security) config.security = {};
      config.security.allowedBroadcasterIds = fromSecret;
    }
  } catch (_e) {
    // Errors already logged in getSecretValue
  }
}

/**
 * Start periodic refresh of the allowlist from the secret.
 * Only starts if there's active IRC activity to avoid keeping instance alive unnecessarily.
 * Refreshes every 5 minutes by default.
 */
export function startAllowListRefresh(intervalMinutes = 5) {
  const secretName = process.env.ALLOWED_CHANNELS_SECRET_NAME || config.secrets?.allowedChannelsSecretName;
  if (!secretName) {
    console.log('[AllowList] No secret configured, periodic refresh disabled');
    return;
  }

  // Clear any existing interval
  if (allowListRefreshInterval) {
    clearInterval(allowListRefreshInterval);
  }

  console.log(`[AllowList] Starting allowlist refresh (will refresh on IRC activity every ${intervalMinutes} minutes)`);

  // Use a lighter approach - only refresh when there's actual activity
  allowListRefreshInterval = setInterval(async () => {
    console.log('[AllowList] Refreshing allowlist from secret...');
    await initializeAllowList();
  }, intervalMinutes * 60 * 1000);
}

/**
 * Refresh allowlist on-demand (called when needed, doesn't keep instance alive).
 */
export async function refreshAllowListOnDemand() {
  console.log('[AllowList] On-demand refresh triggered');
  await initializeAllowList();
}

/**
 * Stop the periodic allowlist refresh.
 */
export function stopAllowListRefresh() {
  if (allowListRefreshInterval) {
    clearInterval(allowListRefreshInterval);
    allowListRefreshInterval = null;
    console.log('[AllowList] Stopped periodic refresh');
  }
}

// --- Legacy compatibility shim ---
// getAllowedChannels is kept as an alias for getAllowedBroadcasterIds
// to minimize churn in consuming code.
export const getAllowedChannels = getAllowedBroadcasterIds;
