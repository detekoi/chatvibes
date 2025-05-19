// src/lib/secretManager.js
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import logger from './logger.js'; // Path is relative to this file in src/lib/

let client = null;

/**
 * Initializes the Secret Manager client.
 */
function initializeSecretManager() {
    if (client) {
        logger.warn('ChatVibes: Secret Manager client already initialized.'); // Updated name
        return;
    }
    try {
        logger.info('ChatVibes: Initializing Google Cloud Secret Manager client...'); // Updated name
        client = new SecretManagerServiceClient();
        logger.info('ChatVibes: Secret Manager client initialized successfully.'); // Updated name
    } catch (error) {
        logger.fatal({ err: error }, 'ChatVibes: Failed to initialize Secret Manager client. Ensure ADC or credentials are configured.'); // Updated name
        throw error;
    }
}

function getSecretManagerClient() {
    if (!client) {
        logger.warn('ChatVibes: Secret Manager client accessed before explicit initialization. Attempting lazy init.'); // Updated
        initializeSecretManager();
        if (!client) { // Check again after attempting lazy init
             throw new Error('ChatVibes: Secret Manager client could not be initialized after lazy attempt.'); // Updated
        }
    }
    return client;
}

async function getSecretValue(secretResourceName) {
    if (!secretResourceName) {
        logger.error('ChatVibes: getSecretValue called with empty secretResourceName.'); // Updated
        return null;
    }
    const smClient = getSecretManagerClient();
    try {
        logger.debug(`ChatVibes: Accessing secret: ${secretResourceName}`); // Updated
        const [version] = await smClient.accessSecretVersion({
            name: secretResourceName,
        });

        if (!version.payload?.data) {
            logger.warn(`ChatVibes: Secret payload data is missing for ${secretResourceName}.`); // Updated
            return null;
        }

        const secretValue = version.payload.data.toString('utf8');
        logger.info(`ChatVibes: Successfully retrieved secret: ${secretResourceName.split('/secrets/')[1].split('/')[0]} (version: ${secretResourceName.split('/').pop()})`); // Updated
        return secretValue;
    } catch (error) {
        const GcpError = error; // For type hinting if using TS later
        logger.error(
            { err: { message: GcpError.message, code: GcpError.code }, secretName: secretResourceName },
            `ChatVibes: Failed to access secret version ${secretResourceName}. Check permissions and secret existence.` // Updated
        );
        if (GcpError.code === 5) {
             logger.error(`ChatVibes: Secret or version not found: ${secretResourceName}`); // Updated
        } else if (GcpError.code === 7) {
             logger.error(`ChatVibes: Permission denied accessing secret: ${secretResourceName}. Check IAM roles.`); // Updated
        }
        return null;
    }
}

export { initializeSecretManager, getSecretValue, getSecretManagerClient };