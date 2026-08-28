// src/lib/channelLanguageSync.js
// Fills in a channel's TTS language from the one it already declares on Twitch,
// so a streamer who never opens the dashboard still gets announcements in their
// own language instead of English.
//
// Deliberately conservative in three ways:
//
//   1. It only ever writes when the channel has made no choice — languageBoost
//      unset, or one of the "auto" values. An explicit setting is never
//      overwritten, so this can never undo something a streamer did on purpose
//      and needs no opt-out switch in the dashboard.
//   2. A Twitch language with no MiniMax equivalent (its "other" and "asl", plus
//      the languages the provider does not synthesise) leaves the channel on
//      auto. Guessing a near neighbour would change what the bot says out loud
//      with nothing to signal why.
//   3. Every write logs at info. Cloud Run runs at LOG_LEVEL=info and the silent
//      branches here log at debug, so an unexplained change of announcement
//      language would otherwise be very hard to trace back to this.
//
// Leader-only: it is started from the same hook as the EventSub subsystem, so N
// Cloud Run instances do not each poll Helix and race on the same write.

import logger from './logger.js';
import { getActiveChannels } from './allowList.js';
import { getChannelInformation } from '../components/twitch/helixClient.js';
import { getStoredLanguageBoost, setChannelDefaultLanguage } from '../components/tts/ttsState.js';
import { languageBoostFromTwitch, isAutoLanguageBoost } from '../i18n/index.js';

// Helix caps /channels at 100 broadcaster IDs per request.
const HELIX_BATCH_SIZE = 100;

// A channel's declared language changes very rarely, and the only cost of
// noticing late is that the first announcements stay English.
const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

let syncTimer = null;

/**
 * One pass over every active channel. Exported for tests and for the startup call.
 * @returns {Promise<{checked: number, updated: number, skipped: number}>}
 */
export async function syncChannelLanguages() {
    const channels = getActiveChannels();
    if (channels.length === 0) {
        logger.debug('Channel language sync: no active channels with a broadcaster ID');
        return { checked: 0, updated: 0, skipped: 0 };
    }

    const byId = new Map(channels.map(c => [c.broadcasterId, c.channelName]));
    let checked = 0;
    let updated = 0;
    let skipped = 0;

    for (let i = 0; i < channels.length; i += HELIX_BATCH_SIZE) {
        const batch = channels.slice(i, i + HELIX_BATCH_SIZE).map(c => c.broadcasterId);
        let info;
        try {
            info = await getChannelInformation(batch);
        } catch (err) {
            // getChannelInformation already logs and returns [] on API errors;
            // this only catches a genuinely unexpected throw. A failed batch is
            // retried by the next scheduled pass, so it is not fatal.
            logger.warn({ err, count: batch.length }, 'Channel language sync: Helix batch failed');
            continue;
        }

        for (const channel of info || []) {
            const channelName = byId.get(String(channel.broadcaster_id));
            if (!channelName) continue;
            checked++;

            const languageBoost = languageBoostFromTwitch(channel.broadcaster_language);
            if (!languageBoost) {
                logger.debug({ channel: channelName, broadcasterLanguage: channel.broadcaster_language },
                    'Channel language sync: no TTS language for this Twitch language — leaving on auto');
                skipped++;
                continue;
            }

            // Must be the stored value, not getTtsState's: that one returns
            // defaults (languageBoost 'auto') when a Firestore read fails, which
            // is indistinguishable from a channel that never chose one — so an
            // outage would make this overwrite real preferences.
            let stored;
            try {
                stored = await getStoredLanguageBoost(channelName);
            } catch (err) {
                logger.warn({ err, channel: channelName },
                    'Channel language sync: could not read stored language — skipping rather than risk overwriting a choice');
                continue;
            }

            if (!isAutoLanguageBoost(stored)) {
                logger.debug({ channel: channelName, languageBoost: stored },
                    'Channel language sync: channel has chosen a language — leaving it alone');
                skipped++;
                continue;
            }

            const ok = await setChannelDefaultLanguage(channelName, languageBoost);
            if (ok) {
                updated++;
                logger.info({ channel: channelName, broadcasterLanguage: channel.broadcaster_language, languageBoost },
                    'Channel language sync: set TTS language from the channel\'s Twitch language');
            } else {
                logger.warn({ channel: channelName, languageBoost },
                    'Channel language sync: write rejected');
            }
        }
    }

    logger.info({ checked, updated, skipped }, 'Channel language sync complete');
    return { checked, updated, skipped };
}

/** Begin periodic syncing. Safe to call twice; the second call is ignored. */
export function startChannelLanguageSync() {
    if (syncTimer) return;

    syncChannelLanguages().catch(err =>
        logger.error({ err }, 'Channel language sync: initial pass failed'));

    syncTimer = setInterval(() => {
        syncChannelLanguages().catch(err =>
            logger.error({ err }, 'Channel language sync: scheduled pass failed'));
    }, SYNC_INTERVAL_MS);

    // Must not hold the process open during a graceful shutdown.
    syncTimer.unref?.();
    logger.info({ intervalHours: SYNC_INTERVAL_MS / 3600000 }, 'Channel language sync started');
}

export function stopChannelLanguageSync() {
    if (!syncTimer) return;
    clearInterval(syncTimer);
    syncTimer = null;
    logger.info('Channel language sync stopped');
}

export const _internals = { SYNC_INTERVAL_MS, HELIX_BATCH_SIZE };
