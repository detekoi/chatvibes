// src/components/web/cleanupEndpoint.js
// HTTP endpoint for automated secret cleanup (triggered by Cloud Scheduler)

import logger from '../../lib/logger.js';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

const client = new SecretManagerServiceClient();
const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'chatvibestts';
const VERSIONS_TO_KEEP = 2;

/**
 * Clean up old secret versions, keeping only the latest N versions
 */
async function cleanupSecretVersions(secretName) {
    const parent = `projects/${PROJECT_ID}/secrets/${secretName}`;

    try {
        const [versions] = await client.listSecretVersions({
            parent,
            filter: 'state:ENABLED',
        });

        if (!versions || versions.length <= VERSIONS_TO_KEEP) {
            return { secret: secretName, disabled: 0, kept: versions?.length || 0 };
        }

        const sortedVersions = versions.sort((a, b) => {
            const versionA = parseInt(a.name.split('/').pop());
            const versionB = parseInt(b.name.split('/').pop());
            return versionB - versionA;
        });

        const versionsToDisable = sortedVersions.slice(VERSIONS_TO_KEEP);

        for (const version of versionsToDisable) {
            await client.disableSecretVersion({ name: version.name });
        }

        return {
            secret: secretName,
            disabled: versionsToDisable.length,
            kept: VERSIONS_TO_KEEP,
        };
    } catch (error) {
        logger.error({ err: error, secret: secretName }, 'Error cleaning up secret versions');
        return { secret: secretName, disabled: 0, kept: 0, error: error.message };
    }
}

/**
 * HTTP handler for cleanup endpoint (called by Cloud Scheduler)
 * Automatically cleans up old secret versions to reduce storage costs
 */
export async function handleSecretCleanup(req, res) {
    // Verify request is from Cloud Scheduler (check for cron header)
    const isCloudScheduler = req.headers['x-cloudscheduler'] === 'true' ||
                            req.headers['user-agent']?.includes('Google-Cloud-Scheduler');

    if (!isCloudScheduler) {
        logger.warn({ ip: req.ip, headers: req.headers }, 'Unauthorized cleanup request');
        return res.status(403).json({ error: 'Forbidden' });
    }

    logger.info('Starting automated secret cleanup...');

    try {
        // List all secrets
        const [secrets] = await client.listSecrets({
            parent: `projects/${PROJECT_ID}`,
        });

        const results = [];
        for (const secret of secrets) {
            const secretName = secret.name.split('/').pop();
            const result = await cleanupSecretVersions(secretName);
            results.push(result);
        }

        const totalDisabled = results.reduce((sum, r) => sum + r.disabled, 0);
        const totalKept = results.reduce((sum, r) => sum + r.kept, 0);

        logger.info({
            secretsProcessed: results.length,
            versionsDisabled: totalDisabled,
            versionsKept: totalKept,
        }, 'Secret cleanup completed');

        res.status(200).json({
            success: true,
            secretsProcessed: results.length,
            versionsDisabled: totalDisabled,
            versionsKept: totalKept,
            results: results.filter(r => r.disabled > 0), // Only show secrets that had versions disabled
        });
    } catch (error) {
        logger.error({ err: error }, 'Failed to run secret cleanup');
        res.status(500).json({ error: 'Cleanup failed', message: error.message });
    }
}
