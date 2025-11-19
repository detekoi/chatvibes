// cleanup-eventsub.js
// Script to delete all existing EventSub subscriptions
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;

async function getAppAccessToken() {
    const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
        params: {
            client_id: TWITCH_CLIENT_ID,
            client_secret: TWITCH_CLIENT_SECRET,
            grant_type: 'client_credentials'
        }
    });
    return response.data.access_token;
}

async function getAllSubscriptions(token) {
    const response = await axios.get('https://api.twitch.tv/helix/eventsub/subscriptions', {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Client-ID': TWITCH_CLIENT_ID
        }
    });
    return response.data.data;
}

async function deleteSubscription(token, subscriptionId) {
    await axios.delete(`https://api.twitch.tv/helix/eventsub/subscriptions?id=${subscriptionId}`, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Client-ID': TWITCH_CLIENT_ID
        }
    });
}

async function main() {
    console.log('Getting app access token...');
    const token = await getAppAccessToken();

    console.log('Fetching all EventSub subscriptions...');
    const subscriptions = await getAllSubscriptions(token);

    console.log(`\nFound ${subscriptions.length} subscriptions. Deleting...\n`);

    for (const sub of subscriptions) {
        console.log(`Deleting ${sub.type} (${sub.id})...`);
        try {
            await deleteSubscription(token, sub.id);
            console.log(`Deleted.`);
        } catch (e) {
            console.error(`Failed to delete ${sub.id}: ${e.message}`);
        }
    }

    console.log('\nAll subscriptions deleted!');
}

main().catch(console.error);
