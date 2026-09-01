// src/components/commands/tts/redeems.js
// Choose which channel point redeems are announced.
//
// Redemption announcements are all-or-nothing by default; this command carves
// out the rewards that should stay silent (soundboards, mostly — they play
// their own audio, and "so-and-so redeemed Air Horn" on top of it is noise).
// Everything not muted here is still announced.
//
// The reward is named by title, resolved to Twitch's reward ID before it is
// stored (a rename must not shed the entry) — see rewardResolver.js for how a
// typed title becomes exactly one reward, and why the model is only allowed to
// narrow, never to pick something the words could not have meant. Every reply
// names the reward that was actually muted, and unmute undoes it, so a wrong
// resolution costs one command.
import { enqueueMessage } from '../../../lib/chatSender.js';
import { getTtsState, muteReward, unmuteReward } from '../../tts/ttsState.js';
import { getChannelIdFromName } from '../../../lib/allowList.js';
import { getBroadcasterIdByLogin } from '../../twitch/helixClient.js';
import { listCustomRewards, RewardListError } from '../../twitch/customRewards.js';
import { resolveReward } from '../../../lib/rewardResolver.js';
import { pickRewardWithGemini } from '../../../lib/rewardMatcherApi.js';
import { buildMutedRewardEntry, isRewardMuted, listMutedRewards } from '../../../lib/rewardMuteList.js';
import logger from '../../../lib/logger.js';

const USAGE = '!tts redeems mute <reward title> | unmute <reward title> | list | all';

// Twitch caps a message at 500 characters; reward titles are up to 45.
const TITLES_PER_MESSAGE = 8;
const AMBIGUOUS_SHOWN = 5;

const MUTE_WORDS = new Set(['mute', 'silence', 'skip', 'hide', 'ignore', 'off']);
const UNMUTE_WORDS = new Set(['unmute', 'announce', 'read', 'show', 'unignore', 'on']);

async function resolveBroadcasterId(channelName) {
    return getChannelIdFromName(channelName) || await getBroadcasterIdByLogin(channelName);
}

export default {
    name: 'redeems',
    description: 'Choose which channel point redeems TTS announces.',
    usage: USAGE,
    permission: 'moderator',
    execute: async (context) => {
        const { channel, user, args, replyToId } = context;
        const channelName = channel.replace('#', '').toLowerCase();
        const { t } = context;
        const reply = msg => enqueueMessage(channel, msg, { replyToId });

        const verb = (args[0] || 'list').toLowerCase();
        const query = args.slice(1).join(' ').trim();

        try {
            const ttsConfig = await getTtsState(channelName);

            if (verb === 'list' || verb === 'muted') {
                const muted = listMutedRewards(ttsConfig);
                if (muted.length === 0) {
                    reply(t('cmd.redeems.noneMuted'));
                    return;
                }
                const titles = muted.map(m => m.title);
                for (let i = 0; i < titles.length; i += TITLES_PER_MESSAGE) {
                    const list = titles.slice(i, i + TITLES_PER_MESSAGE).join(', ');
                    reply(t(i === 0 ? 'cmd.redeems.mutedList' : 'cmd.redeems.mutedListMore', { list }));
                }
                return;
            }

            if (verb === 'all' || verb === 'rewards') {
                const rewards = await fetchRewards(channelName, reply, t);
                if (!rewards) return;
                if (rewards.length === 0) {
                    reply(t('cmd.redeems.allEmpty'));
                    return;
                }
                const titles = rewards
                    .map(r => isRewardMuted(ttsConfig, r.id) ? t('cmd.redeems.mutedSuffix', { title: r.title }) : r.title)
                    .sort((a, b) => a.localeCompare(b));
                for (let i = 0; i < titles.length; i += TITLES_PER_MESSAGE) {
                    const list = titles.slice(i, i + TITLES_PER_MESSAGE).join(', ');
                    reply(t(i === 0 ? 'cmd.redeems.allPrefix' : 'cmd.redeems.allMore', { list }));
                }
                return;
            }

            const isMute = MUTE_WORDS.has(verb);
            const isUnmute = UNMUTE_WORDS.has(verb);
            if ((!isMute && !isUnmute) || !query) {
                reply(t('cmd.redeems.usage', { usage: USAGE }));
                return;
            }

            if (isUnmute) {
                // The stored titles are the whole universe here, so no Helix call:
                // an unmute names something that is on the list or it is a no-op.
                const stored = listMutedRewards(ttsConfig).map(m => ({ id: m.rewardId, title: m.title }));
                const result = await resolveReward(query, stored, { llmPick: pickRewardWithGemini });
                if (result.status === 'ambiguous') {
                    reply(t('cmd.redeems.ambiguous', { title: query, candidates: candidateList(result.candidates) }));
                    return;
                }
                if (result.status !== 'match') {
                    reply(t('cmd.redeems.notMuted', { title: query }));
                    return;
                }
                const ok = await unmuteReward(channelName, result.reward.id);
                if (!ok) {
                    reply(t('cmd.redeems.unmuteFailed', { title: result.reward.title }));
                    return;
                }
                logger.info({ channel: channelName, rewardId: result.reward.id, title: result.reward.title, via: result.via, user: user.username }, 'Reward unmuted');
                reply(t('cmd.redeems.unmuted', { title: result.reward.title }));
                return;
            }

            const rewards = await fetchRewards(channelName, reply, t);
            if (!rewards) return;
            const result = await resolveReward(query, rewards, { llmPick: pickRewardWithGemini });
            if (result.status === 'ambiguous') {
                reply(t('cmd.redeems.ambiguous', { title: query, candidates: candidateList(result.candidates) }));
                return;
            }
            if (result.status !== 'match') {
                reply(t('cmd.redeems.notFound', { title: query }));
                return;
            }
            const { reward } = result;

            // Muting the TTS reward would silence the feature it exists for; the
            // dashboard has the switch for that.
            const ttsRewardId = ttsConfig.channelPoints?.rewardId || ttsConfig.channelPointRewardId;
            if (ttsRewardId && reward.id === ttsRewardId) {
                reply(t('cmd.redeems.isTtsReward', { title: reward.title }));
                return;
            }
            if (isRewardMuted(ttsConfig, reward.id)) {
                reply(t('cmd.redeems.alreadyMuted', { title: reward.title }));
                return;
            }

            const by = user['user-id'] ? `twitch:${user['user-id']}` : null;
            const ok = await muteReward(channelName, reward.id, buildMutedRewardEntry({ title: reward.title, by }));
            if (!ok) {
                reply(t('cmd.redeems.muteFailed', { title: reward.title }));
                return;
            }
            logger.info({ channel: channelName, rewardId: reward.id, title: reward.title, via: result.via, query, user: user.username }, 'Reward muted');
            reply(t('cmd.redeems.muted', { title: reward.title }));
        } catch (error) {
            logger.error({ err: error, channel: channelName, args }, 'Error in !tts redeems');
            reply(t('cmd.redeems.error'));
        }
    },
};

function candidateList(candidates) {
    return candidates.slice(0, AMBIGUOUS_SHOWN).map(c => c.title).join(', ');
}

/**
 * The channel's rewards from Helix, or null after replying with why not.
 */
async function fetchRewards(channelName, reply, t) {
    const broadcasterId = await resolveBroadcasterId(channelName);
    if (!broadcasterId) {
        reply(t('cmd.redeems.lookupFailed'));
        return null;
    }
    try {
        return await listCustomRewards(broadcasterId, channelName);
    } catch (error) {
        if (error instanceof RewardListError && (error.code === 'no_token' || error.code === 'unauthorized')) {
            reply(t('cmd.redeems.needsAuth'));
        } else {
            reply(t('cmd.redeems.lookupFailed'));
        }
        return null;
    }
}
