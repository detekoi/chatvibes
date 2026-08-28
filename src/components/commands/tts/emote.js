// src/components/commands/tts/emote.js
// View, regenerate, and manually set cached emote descriptions
import { enqueueMessage } from '../../../lib/chatSender.js';
import { getTtsState } from '../../tts/ttsState.js';
import { resolveChannelLocale } from '../../../i18n/index.js';
import { findEmoteDescriptionsByName, invalidateEmoteDescription, setEmoteDescription } from '../../../lib/emotes/index.js';
import { getBroadcasterIdByLogin, getChannelEmotes } from '../../twitch/helixClient.js';
import logger from '../../../lib/logger.js';


export default {
    name: 'emote',
    description: 'View, regenerate, or manually set a cached emote description.',
    usage: '!tts emote <emoteName> | !tts emote regenerate <emoteName> | !tts emote set <emoteName> = <description>',
    permission: 'moderator',
    execute: async (context) => {
        const { channel, user, args, replyToId, t } = context;

        if (args.length === 0) {
            enqueueMessage(channel, t('cmd.emote.usage'), { replyToId });
            return;
        }

        const subAction = args[0].toLowerCase();
        const channelNameNoHash = channel.replace('#', '').toLowerCase();
        const locale = resolveChannelLocale(await getTtsState(channelNameNoHash));

        try {
            if (subAction === 'set') {
                // !tts emote set <emoteName> = <description>
                const rest = args.slice(1).join(' ');
                const eqIndex = rest.indexOf('=');

                if (eqIndex === -1 || eqIndex === 0) {
                    enqueueMessage(channel, t('cmd.emote.setUsage'), { replyToId });
                    return;
                }

                const emoteName = rest.substring(0, eqIndex).trim();
                const description = rest.substring(eqIndex + 1).trim();

                if (!emoteName || !description) {
                    enqueueMessage(channel, t('cmd.emote.setUsage'), { replyToId });
                    return;
                }

                // Resolve broadcaster ID once for ownership checks
                const broadcasterId = await getBroadcasterIdByLogin(channelNameNoHash);
                if (!broadcasterId) {
                    enqueueMessage(channel, t('cmd.emote.lookupFailed'), { replyToId });
                    return;
                }

                // Try Firestore first for existing cached entries
                const matches = await findEmoteDescriptionsByName(emoteName, locale);
                const channelMatches = matches.filter(m => m.ownerId === broadcasterId);

                if (channelMatches.length > 0) {
                    // Existing channel entries — update them
                    let updated = 0;
                    for (const match of channelMatches) {
                        const success = await setEmoteDescription(match.emoteId, emoteName, description, broadcasterId, locale);
                        if (success) updated++;
                    }
                    logger.info({ emoteName, description, updated, user: user.username, channel: channelNameNoHash }, 'Emote description(s) manually set via command');
                    enqueueMessage(channel, t('cmd.emote.updated', { count: updated, name: emoteName, description }), { replyToId });
                } else {
                    // No cached entry for this channel — look up via Twitch API
                    const emotes = await getChannelEmotes(broadcasterId);
                    const match = emotes.find(e => e.name === emoteName);

                    if (!match) {
                        // Check if it exists as a global/other-channel emote in cache
                        if (matches.length > 0) {
                            const isGlobal = matches.some(m => !m.ownerId || m.ownerId === '0');
                            enqueueMessage(channel, isGlobal
                                ? t('cmd.emote.globalLocked')
                                : t('cmd.emote.notOurs'), { replyToId });
                        } else {
                            enqueueMessage(channel, t('cmd.emote.notChannel', { name: emoteName, channel: channelNameNoHash }), { replyToId });
                        }
                        return;
                    }

                    const success = await setEmoteDescription(match.id, emoteName, description, broadcasterId, locale);
                    if (success) {
                        logger.info({ emoteName, emoteId: match.id, description, user: user.username, channel: channelNameNoHash }, 'Emote description manually set via command (new entry)');
                        enqueueMessage(channel, t('cmd.emote.set', { name: emoteName, description }), { replyToId });
                    } else {
                        enqueueMessage(channel, t('cmd.emote.saveFailed', { name: emoteName }), { replyToId });
                    }
                }
            } else if (subAction === 'regenerate') {
                const emoteName = args.slice(1).join(' ');

                if (!emoteName) {
                    enqueueMessage(channel, t('cmd.emote.needName'), { replyToId });
                    return;
                }

                const matches = await findEmoteDescriptionsByName(emoteName, locale);

                if (matches.length === 0) {
                    enqueueMessage(channel, t('cmd.emote.noCache', { name: emoteName }), { replyToId });
                    return;
                }

                // Scope regenerate to this channel's emotes
                const broadcasterId = await getBroadcasterIdByLogin(channelNameNoHash);
                if (!broadcasterId) {
                    enqueueMessage(channel, t('cmd.emote.lookupFailed'), { replyToId });
                    return;
                }

                const channelMatches = matches.filter(m => m.ownerId === broadcasterId);
                if (channelMatches.length === 0) {
                    const isGlobal = matches.some(m => !m.ownerId || m.ownerId === '0');
                    enqueueMessage(channel, isGlobal
                        ? t('cmd.emote.globalLocked')
                        : t('cmd.emote.notOurs'), { replyToId });
                    return;
                }

                let cleared = 0;
                for (const match of channelMatches) {
                    const success = await invalidateEmoteDescription(match.emoteId, locale);
                    if (success) cleared++;
                }

                logger.info({ emoteName, cleared, total: channelMatches.length, user: user.username, channel: channelNameNoHash }, 'Emote description(s) regenerated via command');
                enqueueMessage(channel, t('cmd.emote.cleared', { count: cleared, name: emoteName }), { replyToId });
            } else {
                // View mode: treat all args as emote name (no ownership check needed)
                const emoteName = args.join(' ');
                const matches = await findEmoteDescriptionsByName(emoteName, locale);

                if (matches.length === 0) {
                    enqueueMessage(channel, t('cmd.emote.noCacheYet', { name: emoteName }), { replyToId });
                    return;
                }

                const descriptions = matches.map(m => `"${m.description}"`).join(', ');
                enqueueMessage(channel, t('cmd.emote.view', { name: emoteName, descriptions }), { replyToId });
            }
        } catch (error) {
            logger.error({ err: error, args }, 'Error in emote description command');
            enqueueMessage(channel, t('cmd.emote.error'), { replyToId });
        }
    },
};
