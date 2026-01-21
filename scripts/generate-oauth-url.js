// generate-oauth-url.js
// Script to generate the OAuth URL for bot authentication with required scopes
import dotenv from 'dotenv';
import { getClientId } from '../src/components/twitch/auth.js';

dotenv.config();

async function generateOAuthUrl() {
    try {
        const clientId = await getClientId();

        if (!clientId) {
            console.error('❌ Failed to get Client ID');
            return;
        }

        // Define all required scopes for the bot
        const requiredScopes = [
            'user:bot',            // Required for Chat Bot apps
            // Chat functionality (EventSub and IRC)
            'user:read:chat',      // Required for channel.chat.message EventSub subscriptions
            'user:write:chat',     // Required for sending chat messages via Helix API

            // Event tracking
            'bits:read',                      // For bit/cheer events
            'channel:read:subscriptions',     // For subscription events
            'moderator:read:followers',       // For follower events (channel.follow v2)
        ];

        const redirectUri = 'https://tts.wildcat.chat/auth/twitch/callback';
        const scopes = requiredScopes.join(' ');

        const authUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scopes)}`;

        console.log('\n=== Bot Re-authentication Instructions ===\n');
        console.log('Your bot is missing the following scopes:');
        console.log('  - user:bot');
        console.log('  - user:read:chat');
        console.log('  - user:write:chat');
        console.log('\nTo fix this, you need to re-authenticate your bot:\n');
        console.log('1. Visit this URL in your browser (logged in as the bot account):');
        console.log(`\n${authUrl}\n`);
        console.log('2. Authorize the application with the requested permissions');
        console.log('3. You will be redirected to a page with an authorization code');
        console.log('4. Use the script below to exchange the code for tokens:\n');
        console.log('   node scripts/exchange-oauth-code.js <authorization_code>\n');
        console.log('5. The script will update the refresh token in Secret Manager\n');
        console.log('Required scopes:');
        requiredScopes.forEach(scope => {
            console.log(`  - ${scope}`);
        });
        console.log('\n==========================================\n');

    } catch (error) {
        console.error('❌ Error:', error.message);
    }
}

generateOAuthUrl().catch(console.error);
