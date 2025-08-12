// src/lib/allowList.js
import config from '../config/index.js';
import { getSecretValue } from './secretManager.js';

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


