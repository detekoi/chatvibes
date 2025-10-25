// src/components/twitch/auth.js
import axios from 'axios';
import logger from '../../lib/logger.js'; // Assuming logger is in src/lib/
import config from '../../config/index.js'; // Assuming config is in src/config/
// Assuming secretManager is in src/lib/

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
let appAccessToken = null;
let tokenExpiryTime = 0; // Store expiry time in milliseconds since epoch

const TOKEN_REFRESH_BUFFER_SECONDS = 300; // Refresh token 5 minutes before it expires

// Cached Client ID and Secret (loaded from Secret Manager if needed)
let cachedClientId = null;
let cachedClientSecret = null;

/**
 * Get Client ID, loading from Secret Manager if not in environment
 * @returns {Promise<string>}
 */
async function getClientId() {
    if (cachedClientId) {
        return cachedClientId;
    }
    
    if (config.twitch.clientId) {
        cachedClientId = config.twitch.clientId;
        return cachedClientId;
    }
    
    // Load from Secret Manager
    try {
        const { getSecretValue } = await import('../../lib/secretManager.js');
        logger.info('ChatVibes: Loading Twitch Client ID from Secret Manager...');
        cachedClientId = await getSecretValue(config.twitch.clientIdSecretPath);
        if (!cachedClientId) {
            throw new Error('Failed to load Client ID from Secret Manager');
        }
        logger.info('ChatVibes: Successfully loaded Twitch Client ID from Secret Manager');
        return cachedClientId;
    } catch (error) {
        logger.fatal({ err: error }, 'ChatVibes: Failed to load Twitch Client ID');
        throw error;
    }
}

/**
 * Get Client Secret, loading from Secret Manager if not in environment
 * @returns {Promise<string>}
 */
async function getClientSecret() {
    if (cachedClientSecret) {
        return cachedClientSecret;
    }
    
    if (config.twitch.clientSecret) {
        cachedClientSecret = config.twitch.clientSecret;
        return cachedClientSecret;
    }
    
    // Load from Secret Manager
    try {
        const { getSecretValue } = await import('../../lib/secretManager.js');
        logger.info('ChatVibes: Loading Twitch Client Secret from Secret Manager...');
        cachedClientSecret = await getSecretValue(config.twitch.clientSecretPath);
        if (!cachedClientSecret) {
            throw new Error('Failed to load Client Secret from Secret Manager');
        }
        logger.info('ChatVibes: Successfully loaded Twitch Client Secret from Secret Manager');
        return cachedClientSecret;
    } catch (error) {
        logger.fatal({ err: error }, 'ChatVibes: Failed to load Twitch Client Secret');
        throw error;
    }
}

/**
 * Fetches a new app access token from Twitch.
 * @returns {Promise<string|null>} The new app access token or null on failure.
 */
async function fetchNewAppAccessToken() {
    logger.info('ChatVibes Twitch Auth: Attempting to fetch new app access token...'); // ChatVibes
    try {
        const clientId = await getClientId();
        const clientSecret = await getClientSecret();

        // If clientSecret is in Secret Manager (more secure for production)
        // const clientSecretPath = config.secrets.twitchClientSecretName; // Example: if you store client secret in SM
        // if (clientSecretPath) {
        //     clientSecret = await getSecretValue(clientSecretPath);
        // }

        if (!clientId || !clientSecret) {
            logger.error('ChatVibes Twitch Auth: Missing Client ID or Client Secret for app access token generation.');
            return null;
        }

        // Create form data parameters for request body
        const params = new URLSearchParams();
        params.append('client_id', clientId);
        params.append('client_secret', clientSecret);
        params.append('grant_type', 'client_credentials');
        
        const response = await axios.post(TOKEN_URL, params, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            timeout: 10000,
        });

        if (response.data && response.data.access_token && response.data.expires_in) {
            appAccessToken = response.data.access_token;
            // Calculate expiry time: current time + (expires_in seconds * 1000 for ms)
            tokenExpiryTime = Date.now() + (response.data.expires_in * 1000);
            logger.info(`ChatVibes Twitch Auth: New app access token fetched successfully. Expires in: ${response.data.expires_in}s`);
            return appAccessToken;
        } else {
            logger.error({ responseData: response.data }, 'ChatVibes Twitch Auth: Failed to get app access token from Twitch response.');
            return null;
        }
    } catch (error) {
        const errResponse = error.response ? { status: error.response.status, data: error.response.data } : {};
        logger.error({ err: error.message, response: errResponse }, 'ChatVibes Twitch Auth: Error fetching new app access token.');
        appAccessToken = null; // Invalidate token on error
        tokenExpiryTime = 0;
        return null;
    }
}

/**
 * Validates the current app access token.
 * This function is usually not needed externally as getAppAccessToken handles expiry.
 * For specific Helix calls that require validation, Twitch's /oauth2/validate endpoint could be used.
 * @returns {Promise<boolean>} True if the token is considered valid (exists and not imminently expiring).
 */
async function validateToken() {
    if (!appAccessToken) {
        logger.warn('ChatVibes Twitch Auth: No app access token available for validation.');
        return false;
    }
    if (Date.now() >= (tokenExpiryTime - (TOKEN_REFRESH_BUFFER_SECONDS * 1000))) {
        logger.info('ChatVibes Twitch Auth: App access token is expired or nearing expiry.');
        return false;
    }
    // For more robust validation, you could call Twitch's validate endpoint,
    // but checking expiry is often sufficient for app access tokens.
    // Example:
    // try {
    //     const response = await axios.get('https://id.twitch.tv/oauth2/validate', {
    //         headers: { Authorization: `OAuth ${appAccessToken}` },
    //     });
    //     logger.debug('ChatVibes Twitch Auth: Token validated successfully by Twitch endpoint.');
    //     return true;
    // } catch (error) {
    //     logger.warn({ err: error.message }, 'ChatVibes Twitch Auth: Token validation failed via Twitch endpoint.');
    //     return false;
    // }
    logger.debug('ChatVibes Twitch Auth: App access token is considered valid (exists and not expired).');
    return true;
}


/**
 * Gets a valid app access token, fetching a new one if necessary.
 * @returns {Promise<string|null>} The app access token or null if fetching fails.
 */
async function getAppAccessToken() {
    if (await validateToken()) { // Checks for existence and expiry
        logger.debug('ChatVibes Twitch Auth: Using existing valid app access token.');
        return appAccessToken;
    }
    logger.info('ChatVibes Twitch Auth: Existing app access token invalid or missing. Fetching a new one.');
    return await fetchNewAppAccessToken();
}

/**
 * Clears the cached app access token, forcing a refresh on next request.
 */
function clearCachedAppAccessToken() {
    logger.info('ChatVibes Twitch Auth: Cached app access token cleared.');
    appAccessToken = null;
    tokenExpiryTime = 0;
}


export {
    getAppAccessToken,
    fetchNewAppAccessToken, // Export if direct refresh is needed
    validateToken,          // Export for potential external validation use
    clearCachedAppAccessToken,
    getClientId,            // Export for Helix client and other modules
    getClientSecret,        // Export for IRC auth and other modules
};