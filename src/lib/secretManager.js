// src/lib/secretManager.js
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import logger from './logger.js'; // Path is relative to this file in src/lib/
import { redactSecretName } from './redact.js';

let client = null;

// In-memory cache for secrets with TTL
const secretCache = new Map(); // secretName -> { value, expiresAt }
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes default

/**
 * Initializes the Secret Manager client.
 */
function initializeSecretManager() {
    if (client) {
        logger.warn('WildcatTTS: Secret Manager client already initialized.'); // Updated name
        return;
    }
    try {
        logger.info('WildcatTTS: Initializing Google Cloud Secret Manager client...'); // Updated name
        client = new SecretManagerServiceClient();
        logger.info('WildcatTTS: Secret Manager client initialized successfully.'); // Updated name
    } catch (error) {
        logger.fatal({ err: error }, 'WildcatTTS: Failed to initialize Secret Manager client. Ensure ADC or credentials are configured.'); // Updated name
        throw error;
    }
}

function getSecretManagerClient() {
    if (!client) {
        logger.warn('WildcatTTS: Secret Manager client accessed before explicit initialization. Attempting lazy init.'); // Updated
        initializeSecretManager();
        if (!client) { // Check again after attempting lazy init
            throw new Error('WildcatTTS: Secret Manager client could not be initialized after lazy attempt.'); // Updated
        }
    }
    return client;
}

async function getSecretValue(secretResourceName, cacheTtlMs = DEFAULT_CACHE_TTL_MS) {
    if (!secretResourceName) {
        logger.error('WildcatTTS: getSecretValue called with empty secretResourceName.'); // Updated
        return null;
    }

    // Check cache first
    const now = Date.now();
    const cached = secretCache.get(secretResourceName);
    if (cached && cached.expiresAt > now) {
        logger.debug(`WildcatTTS: Using cached secret: ${redactSecretName(secretResourceName)}`);
        return cached.value;
    }

    const smClient = getSecretManagerClient();
    try {
        logger.debug(`WildcatTTS: Accessing secret: ${redactSecretName(secretResourceName)}`);
        const [version] = await smClient.accessSecretVersion({
            name: secretResourceName,
        });

        if (!version.payload?.data) {
            logger.warn(`WildcatTTS: Secret payload data is missing for ${redactSecretName(secretResourceName)}.`);
            return null;
        }

        const secretValue = version.payload.data.toString('utf8');
        logger.info(`WildcatTTS: Successfully retrieved secret: ${redactSecretName(secretResourceName)}`);

        // Cache the secret value
        secretCache.set(secretResourceName, {
            value: secretValue,
            expiresAt: now + cacheTtlMs
        });
        logger.debug(`WildcatTTS: Cached secret for ${cacheTtlMs}ms: ${redactSecretName(secretResourceName)}`);

        return secretValue;
    } catch (error) {
        const GcpError = error; // For type hinting if using TS later
        logger.error(
            { err: { message: GcpError.message, code: GcpError.code }, secretName: redactSecretName(secretResourceName) },
            `WildcatTTS: Failed to access secret ${redactSecretName(secretResourceName)}. Check permissions and secret existence.`
        );
        if (GcpError.code === 5) {
            logger.error(`WildcatTTS: Secret or version not found: ${redactSecretName(secretResourceName)}`);
        } else if (GcpError.code === 7) {
            logger.error(`WildcatTTS: Permission denied accessing secret: ${redactSecretName(secretResourceName)}. Check IAM roles.`);
        }
        return null;
    }
}

async function addSecretVersion(secretResourceName, value) {
    if (!secretResourceName) {
        logger.error('WildcatTTS: addSecretVersion called with empty secretResourceName.');
        return null;
    }
    const smClient = getSecretManagerClient();
    try {
        // Remove /versions/... if present to get the parent secret resource
        const parent = secretResourceName.replace(/\/versions\/.*$/, '');
        logger.info(`WildcatTTS: Adding new secret version to: ${redactSecretName(parent)}`);
        const [version] = await smClient.addSecretVersion({
            parent,
            payload: { data: Buffer.from(value, 'utf8') }
        });
        logger.info(`WildcatTTS: New secret version added: ${version.name}`);

        // Invalidate cache for this secret (since we just updated it)
        invalidateSecretCache(secretResourceName);

        // Auto-cleanup: Keep only the latest 2 versions enabled to reduce costs
        // Google charges $0.06 per active secret version per month
        try {
            const VERSIONS_TO_KEEP = 2;
            const [versions] = await smClient.listSecretVersions({
                parent,
                filter: 'state:ENABLED',
            });

            if (versions && versions.length > VERSIONS_TO_KEEP) {
                // Sort by version number (descending - newest first)
                const sortedVersions = versions.sort((a, b) => {
                    const versionA = parseInt(a.name.split('/').pop());
                    const versionB = parseInt(b.name.split('/').pop());
                    return versionB - versionA;
                });

                const versionsToDisable = sortedVersions.slice(VERSIONS_TO_KEEP);
                logger.info(`WildcatTTS: Auto-cleanup - disabling ${versionsToDisable.length} old version(s) of ${redactSecretName(parent)}`);

                for (const oldVersion of versionsToDisable) {
                    try {
                        await smClient.disableSecretVersion({ name: oldVersion.name });
                    } catch (disableErr) {
                        logger.warn({ err: disableErr, version: oldVersion.name }, 'WildcatTTS: Failed to disable old secret version during auto-cleanup');
                    }
                }
            }
        } catch (cleanupErr) {
            // Don't fail the entire operation if cleanup fails
            logger.warn({ err: cleanupErr, secret: redactSecretName(parent) }, 'WildcatTTS: Failed to auto-cleanup old secret versions (non-fatal)');
        }

        return version;
    } catch (error) {
        logger.error({ err: error, secretName: redactSecretName(secretResourceName) }, 'WildcatTTS: Failed to add new secret version.');
        return null;
    }
}

/**
 * Invalidate a specific secret from the cache
 */
function invalidateSecretCache(secretResourceName) {
    const deleted = secretCache.delete(secretResourceName);
    if (deleted) {
        logger.debug(`WildcatTTS: Invalidated cache for secret: ${redactSecretName(secretResourceName)}`);
    }
}

/**
 * Clear all cached secrets (useful for testing or manual refresh)
 */
function clearSecretCache() {
    const count = secretCache.size;
    secretCache.clear();
    logger.info(`WildcatTTS: Cleared ${count} secrets from cache`);
}

export { initializeSecretManager, getSecretValue, getSecretManagerClient, addSecretVersion, invalidateSecretCache, clearSecretCache };