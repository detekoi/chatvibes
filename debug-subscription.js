
import 'dotenv/config'; // Load .env if present
import { subscribeChannelChatMessage } from './src/components/twitch/twitchSubs.js';
import { getBotUserId } from './src/components/twitch/chatClient.js';
import { getUsersByLogin } from './src/components/twitch/helixClient.js';
import { initializeHelixClient } from './src/components/twitch/helixClient.js';
import { getClientId } from './src/components/twitch/auth.js';
import logger from './src/lib/logger.js';
import config from './src/config/index.js';

async function debugSubscription() {
    try {
        console.log('Initializing...');
        await initializeHelixClient();

        // Verify we can get client ID
        const clientId = await getClientId();
        console.log(`Client ID: ${clientId.substring(0, 10)}...`);

        const channelName = 'parfaittest'; // Hardcoded for debugging
        console.log(`Target Channel: ${channelName}`);

        // 1. Get Bot User ID
        const botUserId = await getBotUserId();
        console.log(`Bot User ID: ${botUserId}`);
        console.log(`Bot Username (Config): ${config.twitch.username}`);

        // 2. Get Broadcaster ID
        const users = await getUsersByLogin([channelName]);
        if (!users.length) {
            console.error('Broadcaster not found!');
            return;
        }
        const broadcasterUserId = users[0].id;
        console.log(`Broadcaster User ID: ${broadcasterUserId}`);

        // 3. Attempt Subscription
        console.log('Attempting channel.chat.message subscription...');
        const result = await subscribeChannelChatMessage(broadcasterUserId);

        if (result.success) {
            console.log('✅ Subscription SUCCESS!');
            console.log(JSON.stringify(result.data, null, 2));
        } else {
            console.error('❌ Subscription FAILED');
            console.error(result.error);
            // If result.error is a string, it might not show the full details.
            // The logger in twitchSubs.js logs the full error.
            // But we want to see it here.
        }

    } catch (error) {
        console.error('Unexpected Error:', error);
    }
}

debugSubscription();
