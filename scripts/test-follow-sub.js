import { subscribeChannelFollow } from '../src/components/twitch/twitchSubs.js';
import { getUsersByLogin } from '../src/components/twitch/helixClient.js';
import { getClientId } from '../src/components/twitch/auth.js';

async function test() {
    try {
        const users = await getUsersByLogin(['parfaitfair']);
        if (users && users.length > 0) {
            const userId = users[0].id;
            console.log('Testing subscribeChannelFollow for parfaitfair (userId: ' + userId + ')');
            const result = await subscribeChannelFollow(userId);
            console.log('Result:', JSON.stringify(result, null, 2));
        } else {
            console.log('User not found');
        }
    } catch (e) {
        console.error('Error:', e);
    }
}

test();
