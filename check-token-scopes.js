// check-token-scopes.js
// Script to validate the bot's access token and check its scopes
import axios from 'axios';
import dotenv from 'dotenv';
import { getValidIrcToken } from './src/components/twitch/ircAuthHelper.js';

dotenv.config();

async function validateToken() {
    try {
        console.log('Fetching bot access token...');
        const tokenWithPrefix = await getValidIrcToken();

        if (!tokenWithPrefix) {
            console.error('❌ Failed to get bot access token');
            return;
        }

        // Remove 'oauth:' prefix if present
        const token = tokenWithPrefix.replace(/^oauth:/, '');

        console.log('Validating token with Twitch...');
        const response = await axios.get('https://id.twitch.tv/oauth2/validate', {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        const { data } = response;
        console.log('\n✅ Token is valid!\n');
        console.log('Client ID:', data.client_id);
        console.log('User ID:', data.user_id);
        console.log('Login:', data.login);
        console.log('Expires in:', data.expires_in, 'seconds');
        console.log('\nScopes:');
        data.scopes.forEach(scope => {
            console.log('  -', scope);
        });

        // Check for required scopes
        const requiredScopes = ['user:read:chat', 'user:write:chat'];
        const missingScopes = requiredScopes.filter(scope => !data.scopes.includes(scope));

        if (missingScopes.length > 0) {
            console.log('\n⚠️  WARNING: Missing required scopes:');
            missingScopes.forEach(scope => {
                console.log('  -', scope);
            });
            console.log('\nTo add these scopes, you need to re-authenticate the bot with the OAuth flow.');
            console.log('The authorization URL should include these scopes in the scope parameter.');
        } else {
            console.log('\n✅ All required scopes are present!');
        }

    } catch (error) {
        if (error.response) {
            console.error('❌ Token validation failed:', error.response.status, error.response.data);
        } else {
            console.error('❌ Error:', error.message);
        }
    }
}

validateToken().catch(console.error);
