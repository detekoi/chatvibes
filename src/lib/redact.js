// src/lib/redact.js
// Utilities for sanitizing sensitive data before logging.

/**
 * Extracts only the short secret name from a full GCP Secret Manager resource path.
 * Example: "projects/my-project/secrets/my-secret/versions/3" → "my-secret (v:***)"
 * If the path doesn't match the expected format, returns "[REDACTED]".
 *
 * @param {string} secretResourceName - Full GCP secret resource name
 * @returns {string} Redacted representation safe for logging
 */
function redactSecretName(secretResourceName) {
    if (!secretResourceName || typeof secretResourceName !== 'string') {
        return '[REDACTED]';
    }
    const parts = secretResourceName.split('/secrets/');
    if (parts.length < 2) {
        return '[REDACTED]';
    }
    const secretName = parts[1].split('/')[0];
    return secretName ? `${secretName} (v:***)` : '[REDACTED]';
}

export { redactSecretName };
