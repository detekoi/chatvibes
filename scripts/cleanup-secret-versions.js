#!/usr/bin/env node
// scripts/cleanup-secret-versions.js
//
// Cleans up old Secret Manager versions to reduce costs.
// Google charges $0.06 per active secret version per month.
// This script keeps only the latest N versions enabled and disables the rest.

import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

const client = new SecretManagerServiceClient();
const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'chatvibestts';

// Number of latest versions to keep enabled (recommend 2: current + previous for rollback)
const VERSIONS_TO_KEEP = 2;

// Dry run mode - set to false to actually disable versions
const DRY_RUN = process.argv.includes('--execute');

async function cleanupSecretVersions(secretName) {
    const parent = `projects/${PROJECT_ID}/secrets/${secretName}`;

    try {
        // List all versions
        const [versions] = await client.listSecretVersions({
            parent,
            filter: 'state:ENABLED',
        });

        if (!versions || versions.length === 0) {
            console.log(`  ✓ ${secretName}: No enabled versions found`);
            return { secret: secretName, disabled: 0, kept: 0 };
        }

        // Sort by version number (descending - newest first)
        const sortedVersions = versions.sort((a, b) => {
            const versionA = parseInt(a.name.split('/').pop());
            const versionB = parseInt(b.name.split('/').pop());
            return versionB - versionA;
        });

        const totalEnabled = sortedVersions.length;

        if (totalEnabled <= VERSIONS_TO_KEEP) {
            console.log(`  ✓ ${secretName}: ${totalEnabled} enabled version(s) (keeping all)`);
            return { secret: secretName, disabled: 0, kept: totalEnabled };
        }

        const versionsToKeep = sortedVersions.slice(0, VERSIONS_TO_KEEP);
        const versionsToDisable = sortedVersions.slice(VERSIONS_TO_KEEP);

        console.log(`  → ${secretName}: ${totalEnabled} enabled versions found`);
        console.log(`     Keeping: ${versionsToKeep.map(v => v.name.split('/').pop()).join(', ')}`);
        console.log(`     ${DRY_RUN ? 'Disabling' : 'Would disable'}: ${versionsToDisable.map(v => v.name.split('/').pop()).join(', ')}`);

        let disabledCount = 0;

        if (DRY_RUN) {
            for (const version of versionsToDisable) {
                try {
                    await client.disableSecretVersion({ name: version.name });
                    disabledCount++;
                } catch (error) {
                    console.error(`     ✗ Failed to disable ${version.name}: ${error.message}`);
                }
            }
            console.log(`     ✓ Disabled ${disabledCount} old version(s)`);
        }

        return {
            secret: secretName,
            disabled: DRY_RUN ? disabledCount : versionsToDisable.length,
            kept: versionsToKeep.length,
        };

    } catch (error) {
        console.error(`  ✗ ${secretName}: Error - ${error.message}`);
        return { secret: secretName, disabled: 0, kept: 0, error: error.message };
    }
}

async function main() {
    console.log('🔍 Secret Manager Version Cleanup Tool');
    console.log('=====================================');
    console.log(`Project: ${PROJECT_ID}`);
    console.log(`Keeping: ${VERSIONS_TO_KEEP} latest version(s) per secret`);
    console.log(`Mode: ${DRY_RUN ? '🔴 EXECUTE (will disable versions)' : '🟡 DRY RUN (preview only)'}`);
    console.log('');

    if (!DRY_RUN) {
        console.log('⚠️  DRY RUN MODE - No changes will be made');
        console.log('   Run with --execute flag to actually disable versions');
        console.log('');
    }

    try {
        // List all secrets
        const [secrets] = await client.listSecrets({
            parent: `projects/${PROJECT_ID}`,
        });

        if (!secrets || secrets.length === 0) {
            console.log('No secrets found in project.');
            return;
        }

        console.log(`Found ${secrets.length} secret(s) in project\n`);

        const results = [];
        for (const secret of secrets) {
            const secretName = secret.name.split('/').pop();
            const result = await cleanupSecretVersions(secretName);
            results.push(result);
        }

        // Summary
        console.log('\n📊 Summary');
        console.log('==========');

        const totalDisabled = results.reduce((sum, r) => sum + r.disabled, 0);
        const totalKept = results.reduce((sum, r) => sum + r.kept, 0);
        const errors = results.filter(r => r.error).length;

        console.log(`Secrets processed: ${results.length}`);
        console.log(`Versions kept: ${totalKept}`);
        console.log(`Versions ${DRY_RUN ? 'disabled' : 'to disable'}: ${totalDisabled}`);
        if (errors > 0) {
            console.log(`Errors: ${errors}`);
        }

        if (!DRY_RUN && totalDisabled > 0) {
            const monthlySavings = (totalDisabled * 0.06).toFixed(2);
            console.log(`\n💰 Potential monthly savings: $${monthlySavings}`);
            console.log('   Run with --execute to apply these changes');
        } else if (DRY_RUN && totalDisabled > 0) {
            const monthlySavings = (totalDisabled * 0.06).toFixed(2);
            console.log(`\n💰 Estimated monthly savings: $${monthlySavings}`);
        }

    } catch (error) {
        console.error('Fatal error:', error);
        process.exit(1);
    }
}

main().catch(console.error);
