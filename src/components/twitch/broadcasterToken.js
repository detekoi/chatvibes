// src/components/twitch/broadcasterToken.js
// The broadcaster's own OAuth token, for Helix calls an app token cannot make.
//
// Managing channel point rewards and their redemptions needs a *user* token
// carrying channel:manage:redemptions, granted when the streamer signed in to
// the dashboard. The dashboard stores it in Firestore; this reads it back.
// There is no refresh here — a token that has expired surfaces as a 401 from
// Helix, and the caller tells the streamer to sign in to the dashboard again,
// which is where the refresh lives.
import { Firestore } from '@google-cloud/firestore';
import logger from '../../lib/logger.js';

let _firestoreDb = null;
function getDb() {
    if (!_firestoreDb) _firestoreDb = new Firestore();
    return _firestoreDb;
}

/**
 * @param {string} broadcasterId Twitch user ID of the channel owner.
 * @param {string} channelLogin For logging only.
 * @returns {Promise<string|null>} The access token, or null when none is usable.
 */
export async function getBroadcasterAccessToken(broadcasterId, channelLogin) {
    try {
        const db = getDb();

        // Get user document from managedChannels collection (keyed by broadcaster ID)
        const userDoc = await db.collection('managedChannels').doc(broadcasterId).get();

        if (!userDoc.exists) {
            logger.warn({ broadcasterId }, 'Broadcaster not found in managedChannels - cannot get user token');
            return null;
        }

        const { needsTwitchReAuth } = userDoc.data();
        if (needsTwitchReAuth) {
            logger.warn({ broadcasterId }, 'Broadcaster needs to re-authenticate - cannot use user token');
            return null;
        }

        // Access token lives in Firestore (migrated from Secret Manager)
        const oauthDoc = await db.collection('users').doc(broadcasterId)
            .collection('private').doc('oauth').get();

        if (!oauthDoc.exists) {
            logger.warn({ channelLogin, twitchUserId: broadcasterId }, 'Broadcaster OAuth tokens not found in Firestore');
            return null;
        }

        const accessToken = oauthDoc.data()?.twitchAccessToken;
        if (accessToken) {
            logger.debug({ channelLogin }, 'Retrieved broadcaster access token from Firestore');
            return accessToken.trim();
        }
        logger.warn({ channelLogin, twitchUserId: broadcasterId }, 'Broadcaster OAuth doc exists but no access token');
        return null;
    } catch (error) {
        logger.error({ err: error, channelLogin }, 'Error getting broadcaster access token');
        return null;
    }
}
