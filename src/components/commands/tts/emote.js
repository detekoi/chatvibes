// src/components/commands/tts/emote.js
// View, regenerate, and manually set cached emote descriptions
import { enqueueMessage } from '../../../lib/chatSender.js';
import { findEmoteDescriptionsByName, invalidateEmoteDescription, setEmoteDescription } from '../../../lib/geminiEmoteDescriber.js';
import { getBroadcasterIdByLogin, getChannelEmotes } from '../../twitch/helixClient.js';
import logger from '../../../lib/logger.js';


export default {
    name: 'emote',
    description: 'View, regenerate, or manually set a cached emote description.',
    usage: '!tts emote <emoteName> | !tts emote regenerate <emoteName> | !tts emote set <emoteName> = <description>',
    permission: 'moderator',
    execute: async (context) => {
        const { channel, user, args, replyToId } = context;

        if (args.length === 0) {
            enqueueMessage(channel, `Usage: !tts emote <name> — view. !tts emote regenerate <name> — clear. !tts emote set <name> = <description> — set manually.`, { replyToId });
            return;
        }

        const subAction = args[0].toLowerCase();
        const channelNameNoHash = channel.replace('#', '').toLowerCase();

        try {
            if (subAction === 'set') {
                // !tts emote set <emoteName> = <description>
                const rest = args.slice(1).join(' ');
                const eqIndex = rest.indexOf('=');

                if (eqIndex === -1 || eqIndex === 0) {
                    enqueueMessage(channel, `Usage: !tts emote set <emoteName> = <description>`, { replyToId });
                    return;
                }

                const emoteName = rest.substring(0, eqIndex).trim();
                const description = rest.substring(eqIndex + 1).trim();

                if (!emoteName || !description) {
                    enqueueMessage(channel, `Usage: !tts emote set <emoteName> = <description>`, { replyToId });
                    return;
                }

                // Resolve broadcaster ID once for ownership checks
                const broadcasterId = await getBroadcasterIdByLogin(channelNameNoHash);
                if (!broadcasterId) {
                    enqueueMessage(channel, 'Could not look up channel info.', { replyToId });
                    return;
                }

                // Try Firestore first for existing cached entries
                const matches = await findEmoteDescriptionsByName(emoteName);
                const channelMatches = matches.filter(m => m.ownerId === broadcasterId);

                if (channelMatches.length > 0) {
                    // Existing channel entries — update them
                    let updated = 0;
                    for (const match of channelMatches) {
                        const success = await setEmoteDescription(match.emoteId, emoteName, description, broadcasterId);
                        if (success) updated++;
                    }
                    logger.info({ emoteName, description, updated, user: user.username, channel: channelNameNoHash }, 'Emote description(s) manually set via command');
                    enqueueMessage(channel, `Updated ${updated} "${emoteName}" description${updated !== 1 ? 's' : ''} to: "${description}"`, { replyToId });
                } else {
                    // No cached entry for this channel — look up via Twitch API
                    const emotes = await getChannelEmotes(broadcasterId);
                    const match = emotes.find(e => e.name === emoteName);

                    if (!match) {
                        // Check if it exists as a global/other-channel emote in cache
                        if (matches.length > 0) {
                            const isGlobal = matches.some(m => !m.ownerId || m.ownerId === '0');
                            enqueueMessage(channel, isGlobal
                                ? 'Global emotes cannot be manually modified — they are described automatically.'
                                : 'That emote does not belong to this channel.', { replyToId });
                        } else {
                            enqueueMessage(channel, `"${emoteName}" is not a channel emote in #${channelNameNoHash}.`, { replyToId });
                        }
                        return;
                    }

                    const success = await setEmoteDescription(match.id, emoteName, description, broadcasterId);
                    if (success) {
                        logger.info({ emoteName, emoteId: match.id, description, user: user.username, channel: channelNameNoHash }, 'Emote description manually set via command (new entry)');
                        enqueueMessage(channel, `Set "${emoteName}" description to: "${description}"`, { replyToId });
                    } else {
                        enqueueMessage(channel, `Failed to save description for "${emoteName}".`, { replyToId });
                    }
                }
            } else if (subAction === 'regenerate') {
                const emoteName = args.slice(1).join(' ');

                if (!emoteName) {
                    enqueueMessage(channel, `Please specify an emote name. Usage: !tts emote regenerate <emoteName>`, { replyToId });
                    return;
                }

                const matches = await findEmoteDescriptionsByName(emoteName);

                if (matches.length === 0) {
                    enqueueMessage(channel, `No cached description found for "${emoteName}".`, { replyToId });
                    return;
                }

                // Scope regenerate to this channel's emotes
                const broadcasterId = await getBroadcasterIdByLogin(channelNameNoHash);
                if (!broadcasterId) {
                    enqueueMessage(channel, 'Could not look up channel info.', { replyToId });
                    return;
                }

                const channelMatches = matches.filter(m => m.ownerId === broadcasterId);
                if (channelMatches.length === 0) {
                    const isGlobal = matches.some(m => !m.ownerId || m.ownerId === '0');
                    enqueueMessage(channel, isGlobal
                        ? 'Global emotes cannot be manually modified — they are described automatically.'
                        : 'That emote does not belong to this channel.', { replyToId });
                    return;
                }

                let cleared = 0;
                for (const match of channelMatches) {
                    const success = await invalidateEmoteDescription(match.emoteId);
                    if (success) cleared++;
                }

                logger.info({ emoteName, cleared, total: channelMatches.length, user: user.username, channel: channelNameNoHash }, 'Emote description(s) regenerated via command');
                enqueueMessage(channel, `Cleared ${cleared} cached description${cleared !== 1 ? 's' : ''} for "${emoteName}". It will be re-described next time it appears.`, { replyToId });
            } else {
                // View mode: treat all args as emote name (no ownership check needed)
                const emoteName = args.join(' ');
                const matches = await findEmoteDescriptionsByName(emoteName);

                if (matches.length === 0) {
                    enqueueMessage(channel, `No cached description found for "${emoteName}". It will be described when it next appears in chat.`, { replyToId });
                    return;
                }

                const descriptions = matches.map(m => `"${m.description}"`).join(', ');
                enqueueMessage(channel, `${emoteName}: ${descriptions}`, { replyToId });
            }
        } catch (error) {
            logger.error({ err: error, args }, 'Error in emote description command');
            enqueueMessage(channel, `Error looking up emote description.`, { replyToId });
        }
    },
};
