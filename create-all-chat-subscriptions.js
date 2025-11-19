// create-all-chat-subscriptions.js
// Create channel.chat.message subscriptions for all broadcaster IDs
import { subscribeChannelChatMessage } from './src/components/twitch/twitchSubs.js';
import { initializeHelixClient } from './src/components/twitch/helixClient.js';
import { loadBotAccessToken } from './src/components/twitch/ircAuthHelper.js';

const broadcasterIds = ['129295549', '117295040', '1191328651'];

async function main() {
    console.log('Creating channel.chat.message subscriptions for all channels...\n');

    // Initialize
    await initializeHelixClient();
    await loadBotAccessToken();

    for (const broadcasterId of broadcasterIds) {
        console.log(`\nCreating subscription for broadcaster ID: ${broadcasterId}`);
        const result = await subscribeChannelChatMessage(broadcasterId);

        if (result.success) {
            console.log(`✅ Successfully created subscription for ${broadcasterId}`);
        } else {
            console.log(`❌ Failed to create subscription for ${broadcasterId}: ${result.error}`);
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log('\n✅ Done creating chat message subscriptions!');
}

main().catch(console.error);
