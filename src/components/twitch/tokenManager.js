// src/components/twitch/tokenManager.js
// Manages all Twitch tokens: App Access Token (client_credentials) and
// Bot User Access Token (refresh_token grant, formerly in ircAuthHelper.js).
import axios from 'axios';
import logger from '../../lib/logger.js';
import config from '../../config/index.js';
import { getSecretValue, addSecretVersion } from '../../lib/secretManager.js';

const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';

// ---------------------------------------------------------------------------
// Client credentials (shared by both token flows)
// ---------------------------------------------------------------------------

let cachedClientId = null;
let cachedClientSecret = null;

/**
 * Get the Twitch Client ID from environment / config.
 * @returns {Promise<string>}
 */
async function getClientId() {
    if (cachedClientId) return cachedClientId;

    cachedClientId = process.env.TWITCH_CLIENT_ID || config.twitch.clientId;

    if (!cachedClientId) {
        logger.fatal('WildcatTTS: TWITCH_CLIENT_ID not found in environment');
        throw new Error('TWITCH_CLIENT_ID not configured');
    }

    logger.debug('WildcatTTS: Using Twitch Client ID from environment');
    return cachedClientId;
}

/**
 * Get the Twitch Client Secret from environment / config.
 * @returns {Promise<string>}
 */
async function getClientSecret() {
    if (cachedClientSecret) return cachedClientSecret;

    cachedClientSecret = process.env.TWITCH_CLIENT_SECRET || config.twitch.clientSecret;

    if (!cachedClientSecret) {
        logger.fatal('WildcatTTS: TWITCH_CLIENT_SECRET not found in environment');
        throw new Error('TWITCH_CLIENT_SECRET not configured');
    }

    logger.debug('WildcatTTS: Using Twitch Client Secret from environment');
    return cachedClientSecret;
}

// ---------------------------------------------------------------------------
// App Access Token (client_credentials – used by Helix API calls)
// ---------------------------------------------------------------------------

let appAccessToken = null;
let tokenExpiryTime = 0;

const TOKEN_REFRESH_BUFFER_SECONDS = 300; // refresh 5 minutes before expiry

/**
 * Fetches a new App Access Token from Twitch.
 * @returns {Promise<string|null>}
 */
async function fetchNewAppAccessToken() {
    logger.info('WildcatTTS: Fetching new App Access Token...');
    try {
        const clientId = await getClientId();
        const clientSecret = await getClientSecret();

        if (!clientId || !clientSecret) {
            logger.error('WildcatTTS: Missing Client ID or Secret for App Access Token.');
            return null;
        }

        const params = new URLSearchParams();
        params.append('client_id', clientId);
        params.append('client_secret', clientSecret);
        params.append('grant_type', 'client_credentials');

        const response = await axios.post(TWITCH_TOKEN_URL, params, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 10000,
        });

        if (response.data?.access_token && response.data?.expires_in) {
            appAccessToken = response.data.access_token;
            tokenExpiryTime = Date.now() + (response.data.expires_in * 1000);
            logger.info(`WildcatTTS: App Access Token fetched. Expires in: ${response.data.expires_in}s`);
            return appAccessToken;
        }

        logger.error({ responseData: response.data }, 'WildcatTTS: Unexpected response fetching App Access Token.');
        return null;
    } catch (error) {
        const errResponse = error.response
            ? { status: error.response.status, data: error.response.data }
            : {};
        logger.error({ err: error.message, response: errResponse }, 'WildcatTTS: Error fetching App Access Token.');
        appAccessToken = null;
        tokenExpiryTime = 0;
        return null;
    }
}

/**
 * Checks whether the cached App Access Token is still valid.
 * @returns {Promise<boolean>}
 */
async function validateToken() {
    if (!appAccessToken) {
        logger.warn('WildcatTTS: No App Access Token available for validation.');
        return false;
    }
    if (Date.now() >= (tokenExpiryTime - (TOKEN_REFRESH_BUFFER_SECONDS * 1000))) {
        logger.info('WildcatTTS: App Access Token is expired or nearing expiry.');
        return false;
    }
    logger.debug('WildcatTTS: App Access Token is valid.');
    return true;
}

/**
 * Returns a valid App Access Token, fetching a new one if necessary.
 * @returns {Promise<string|null>}
 */
async function getAppAccessToken() {
    if (await validateToken()) {
        logger.debug('WildcatTTS: Using cached App Access Token.');
        return appAccessToken;
    }
    logger.info('WildcatTTS: App Access Token invalid or missing – fetching a new one.');
    return fetchNewAppAccessToken();
}

/**
 * Clears the cached App Access Token, forcing a refresh on the next request.
 */
function clearCachedAppAccessToken() {
    logger.info('WildcatTTS: Clearing cached App Access Token.');
    appAccessToken = null;
    tokenExpiryTime = 0;
}

// ---------------------------------------------------------------------------
// Bot User Access Token (refresh_token grant – used for chat messages)
// ---------------------------------------------------------------------------

let isRefreshing = false; // prevent concurrent refreshes

/**
 * Refreshes the Bot User Access Token using the stored Refresh Token.
 * @returns {Promise<string|null>} The new access token (without oauth: prefix), or null on failure.
 */
async function refreshBotUserToken() {
    if (isRefreshing) {
        logger.warn('WildcatTTS: Bot User Token refresh already in progress. Skipping concurrent request.');
        return null;
    }
    isRefreshing = true;
    logger.info('WildcatTTS: Refreshing Bot User Access Token...');

    const refreshTokenSecretName = config.secrets.twitchBotRefreshTokenName;

    if (!refreshTokenSecretName) {
        logger.error('WildcatTTS: Missing TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME in configuration.');
        isRefreshing = false;
        return null;
    }

    const clientId = await getClientId();
    const clientSecret = await getClientSecret();

    if (!clientId || !clientSecret) {
        logger.error('WildcatTTS: Missing Client ID or Secret for Bot User Token refresh.');
        isRefreshing = false;
        return null;
    }

    let refreshToken = null;
    try {
        refreshToken = await getSecretValue(refreshTokenSecretName);
        if (!refreshToken) {
            throw new Error('Refresh token could not be retrieved from Secret Manager.');
        }
    } catch (error) {
        logger.fatal(
            { err: { code: error.code } },
            'CRITICAL: Failed to retrieve refresh token from Secret Manager. Manual intervention required.'
        );
        isRefreshing = false;
        return null;
    }

    try {
        const params = new URLSearchParams();
        params.append('client_id', clientId);
        params.append('client_secret', clientSecret);
        params.append('grant_type', 'refresh_token');
        params.append('refresh_token', refreshToken);

        const response = await axios.post(TWITCH_TOKEN_URL, params, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 10000,
        });

        if (response.status === 200 && response.data?.access_token) {
            const newAccessToken = response.data.access_token;
            const newRefreshToken = response.data.refresh_token;

            logger.info('WildcatTTS: Bot User Access Token refreshed successfully.');

            if (newRefreshToken && newRefreshToken !== refreshToken) {
                logger.info('WildcatTTS: Received a new refresh token – persisting to Secret Manager.');
                try {
                    await addSecretVersion(refreshTokenSecretName, newRefreshToken);
                    logger.info('WildcatTTS: New refresh token persisted to Secret Manager.');
                } catch (persistErr) {
                    logger.error({ err: persistErr }, 'WildcatTTS: Failed to persist new refresh token.');
                }
            }

            isRefreshing = false;
            return newAccessToken;
        }

        throw new Error(`Unexpected response during Bot User Token refresh. Status: ${response.status}`);

    } catch (error) {
        let errorMessage = 'WildcatTTS: Failed to refresh Bot User Access Token.';
        if (error.response) {
            errorMessage += ` Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`;
            logger.error({ status: error.response.status, data: error.response.data }, errorMessage);
            if (error.response.status === 400 || error.response.status === 401) {
                logger.fatal(
                    `WildcatTTS: Refresh token is likely invalid or revoked (Status: ${error.response.status}). ` +
                    'Manual intervention required.'
                );
            }
        } else if (error.request) {
            errorMessage += ' No response from Twitch token endpoint.';
            logger.error({ request: error.request }, errorMessage);
        } else {
            errorMessage += ` Error: ${error.message}`;
            logger.error({ err: error }, errorMessage);
        }
        return null;
    } finally {
        isRefreshing = false;
    }
}

/**
 * Returns a valid Bot User Access Token (WITH the oauth: prefix), refreshing if needed.
 * Call this before connecting to IRC or sending authenticated chat messages.
 * @returns {Promise<string|null>}
 */
async function getValidBotUserToken() {
    logger.info('WildcatTTS: Requesting valid Bot User Token – attempting refresh...');
    const newToken = await refreshBotUserToken();

    if (newToken) {
        return `oauth:${newToken}`;
    }

    logger.error('WildcatTTS: Failed to obtain a valid Bot User Token after refresh attempt.');
    return null;
}

/**
 * Loads the bot's access token into config for use by EventSub subscriptions.
 * Call this during bot initialisation before creating EventSub subscriptions.
 * @returns {Promise<boolean>} True if the token was successfully loaded.
 */
async function loadBotAccessToken() {
    logger.info('WildcatTTS: Loading Bot User Access Token into config...');
    const token = await refreshBotUserToken();

    if (!token) {
        logger.error('WildcatTTS: Failed to load Bot User Access Token.');
        return false;
    }

    config.twitch.accessToken = token;
    logger.info('WildcatTTS: Bot User Access Token loaded successfully.');
    return true;
}

export {
    // Client credentials
    getClientId,
    getClientSecret,
    // App Access Token
    getAppAccessToken,
    fetchNewAppAccessToken,
    validateToken,
    clearCachedAppAccessToken,
    // Bot User Access Token
    refreshBotUserToken,
    getValidBotUserToken,
    loadBotAccessToken,
};
