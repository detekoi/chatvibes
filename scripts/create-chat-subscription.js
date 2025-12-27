// create-chat-subscription.js
// Manually create channel.chat.message EventSub subscription
import { subscribeChannelChatMessage } from '../src/components/twitch/twitchSubs.js';
import { getUsersByLogin, initializeHelixClient } from '../src/components/twitch/helixClient.js';
import { loadBotAccessToken } from '../src/components/twitch/ircAuthHelper.js';
import config from '../src/config/index.js';

const channelName = process.argv[2];

if (!channelName) {
    console.error('Usage: node create-chat-subscription.js <channel_name>');
    console.error('Example: node create-chat-subscription.js parfaittest');
    process.exit(1);
}

async function main() {
    console.log(`Creating channel.chat.message subscription for: ${channelName}\n`);

    // Initialize Helix client
    await initializeHelixClient();

    // Load bot access token
    console.log('Loading bot access token...');
    const tokenLoaded = await loadBotAccessToken();
    if (!tokenLoaded) {
        console.error('❌ Failed to load bot access token');
        process.exit(1);
    }
    console.log('✅ Bot access token loaded');

    // Get broadcaster ID
    console.log(`Looking up broadcaster ID for ${channelName}...`);
    const users = await getUsersByLogin([channelName]);
    if (!users || users.length === 0) {
        console.error(`❌ Channel not found: ${channelName}`);
        process.exit(1);
    }

    const broadcasterId = users[0].id;
    console.log(`✅ Found broadcaster ID: ${broadcasterId}`);

    // Create subscription
    console.log('\nCreating channel.chat.message EventSub subscription...');
    const result = await subscribeChannelChatMessage(broadcasterId);

    if (result.success) {
        console.log('\n✅ Successfully created channel.chat.message subscription!');
        console.log('\nSubscription details:');
        console.log(JSON.stringify(result.data, null, 2));
    } else {
        console.error('\n❌ Failed to create subscription');
        console.error('Error:', result.error);
    }
}

main().catch(error => {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
});
