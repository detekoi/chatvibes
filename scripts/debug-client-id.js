#!/usr/bin/env node

// Quick script to check what Client ID is being used

import { getClientId } from '../src/components/twitch/auth.js';
import { initializeSecretManager } from '../src/lib/secretManager.js';

async function main() {
    console.log('\n🔍 Checking Client ID configuration...\n');
    
    // Initialize Secret Manager
    initializeSecretManager();
    
    // Get the Client ID the bot is using
    const clientId = await getClientId();
    
    console.log(`✅ Bot is using Client ID: ${clientId}\n`);
    console.log('This Client ID must match the one used by the web UI when parfaitfair authenticated.\n');
}

main().catch(error => {
    console.error('Error:', error.message);
    process.exit(1);
});

