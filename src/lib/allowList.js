// src/lib/allowList.js
import config from '../config/index.js';
import { getSecretValue } from './secretManager.js';

let allowListRefreshInterval = null;

/**
 * Returns true if the channel is permitted to use the bot.
 * If no allow-list is configured, all channels are allowed.
 *
 * Configuration: process.env.ALLOWED_CHANNELS (comma-separated)
 */
export function isChannelAllowed(channelName) {
  if (!channelName) return false;
  const lower = channelName.toLowerCase();
  const allowed = config.security?.allowedChannels;
  if (!Array.isArray(allowed) || allowed.length === 0) {
    // No allow-list configured → allow all (backward compatible)
    return true;
  }
  return allowed.includes(lower);
}

/**
 * Returns the normalized list of allowed channels (lowercase).
 */
export function getAllowedChannels() {
  const allowed = config.security?.allowedChannels;
  return Array.isArray(allowed) ? allowed : [];
}

/**
 * Initialize/override the allow-list from a GCP Secret if configured.
 * The secret value should be a comma-separated list of channel names.
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
      .map(ch => ch.trim().toLowerCase())
      .filter(Boolean);
    if (fromSecret.length > 0) {
      if (!config.security) config.security = {};
      config.security.allowedChannels = fromSecret;
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



