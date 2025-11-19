// exchange-oauth-code.js
// Script to exchange OAuth authorization code for tokens and update Secret Manager
import axios from 'axios';
import dotenv from 'dotenv';
import { getClientId, getClientSecret } from './src/components/twitch/auth.js';
import { addSecretVersion } from './src/lib/secretManager.js';
import config from './src/config/index.js';

dotenv.config();

async function exchangeCode(authCode) {
    if (!authCode) {
        console.error('❌ Usage: node exchange-oauth-code.js <authorization_code>');
        console.error('\nThe authorization code is provided after you authorize the app in your browser.');
        process.exit(1);
    }

    try {
        const clientId = await getClientId();
        const clientSecret = await getClientSecret();
        const redirectUri = 'https://tts.wildcat.chat/auth/twitch/callback';

        if (!clientId || !clientSecret) {
            console.error('❌ Failed to get Client ID or Client Secret');
            return;
        }

        console.log('Exchanging authorization code for tokens...');

        // Exchange the authorization code for an access token and refresh token
        const params = new URLSearchParams();
        params.append('client_id', clientId);
        params.append('client_secret', clientSecret);
        params.append('code', authCode);
        params.append('grant_type', 'authorization_code');
        params.append('redirect_uri', redirectUri);

        const response = await axios.post('https://id.twitch.tv/oauth2/token', params, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        const { access_token, refresh_token, expires_in, scope } = response.data;

        console.log('\n✅ Successfully obtained tokens!\n');
        console.log('Access Token:', access_token.substring(0, 10) + '...');
        console.log('Refresh Token:', refresh_token.substring(0, 10) + '...');
        console.log('Expires in:', expires_in, 'seconds');
        console.log('\nScopes granted:');
        scope.forEach(s => console.log(`  - ${s}`));

        // Validate the token to check scopes
        console.log('\nValidating token...');
        const validateResponse = await axios.get('https://id.twitch.tv/oauth2/validate', {
            headers: {
                'Authorization': `Bearer ${access_token}`
            }
        });

        console.log('Token validated successfully!');
        console.log('User ID:', validateResponse.data.user_id);
        console.log('Login:', validateResponse.data.login);

        // Check if required scopes are present
        const requiredScopes = ['user:read:chat', 'user:write:chat'];
        const missingScopes = requiredScopes.filter(scope => !validateResponse.data.scopes.includes(scope));

        if (missingScopes.length > 0) {
            console.error('\n❌ ERROR: Missing required scopes:');
            missingScopes.forEach(scope => {
                console.error(`  - ${scope}`);
            });
            console.error('\nPlease re-run the OAuth flow and ensure all scopes are granted.');
            return;
        }

        console.log('\n✅ All required scopes are present!');

        // Update the refresh token in Secret Manager
        console.log('\nUpdating refresh token in Secret Manager...');
        const refreshTokenSecretName = config.secrets.twitchBotRefreshTokenName;

        if (!refreshTokenSecretName) {
            console.error('❌ TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME is not set in config');
            return;
        }

        await addSecretVersion(refreshTokenSecretName, refresh_token);
        console.log('✅ Refresh token updated successfully in Secret Manager!');

        console.log('\n=== Summary ===');
        console.log('1. New refresh token has been stored in Secret Manager');
        console.log('2. The bot now has the required scopes:');
        requiredScopes.forEach(scope => {
            console.log(`   - ${scope}`);
        });
        console.log('3. Restart your bot to use the new token');
        console.log('\nYou can verify the scopes by running:');
        console.log('  node check-token-scopes.js');

    } catch (error) {
        if (error.response) {
            console.error('❌ Error:', error.response.status, error.response.data);
        } else {
            console.error('❌ Error:', error.message);
        }
    }
}

const authCode = process.argv[2];
exchangeCode(authCode).catch(console.error);
