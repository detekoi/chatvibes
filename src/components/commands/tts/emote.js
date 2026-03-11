// src/components/commands/tts/emote.js
// View, regenerate, and manually set cached emote descriptions
import { enqueueMessage } from '../../../lib/chatSender.js';
import { findEmoteDescriptionsByName, invalidateEmoteDescription, setEmoteDescription } from '../../../lib/geminiEmoteDescriber.js';
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

        try {
            if (subAction === 'set') {
                // Broadcaster-only: descriptions are global, so only the channel owner can set them
                const channelNameNoHash = channel.replace('#', '').toLowerCase();
                const isBroadcaster = user.badges?.broadcaster === '1' || user.username.toLowerCase() === channelNameNoHash;
                if (!isBroadcaster) {
                    enqueueMessage(channel, `Only the broadcaster can manually set emote descriptions.`, { replyToId });
                    return;
                }

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

                // Find existing entries for this emote name to update them
                const matches = await findEmoteDescriptionsByName(emoteName);

                if (matches.length > 0) {
                    // Update all existing entries with the new description
                    let updated = 0;
                    for (const match of matches) {
                        const success = await setEmoteDescription(match.emoteId, emoteName, description);
                        if (success) updated++;
                    }
                    logger.info({ emoteName, description, updated, user: user.username }, 'Emote description(s) manually set via command');
                    enqueueMessage(channel, `Updated ${updated} "${emoteName}" description${updated !== 1 ? 's' : ''} to: "${description}"`, { replyToId });
                } else {
                    // No existing entry — tell the user the emote hasn't been cached yet
                    enqueueMessage(channel, `No cached entry found for "${emoteName}". The description will be set automatically when the emote next appears in chat, or you can send the emote first and then use this command.`, { replyToId });
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

                let cleared = 0;
                for (const match of matches) {
                    const success = await invalidateEmoteDescription(match.emoteId);
                    if (success) cleared++;
                }

                logger.info({ emoteName, cleared, total: matches.length, user: user.username }, 'Emote description(s) regenerated via command');
                enqueueMessage(channel, `Cleared ${cleared} cached description${cleared !== 1 ? 's' : ''} for "${emoteName}". It will be re-described next time it appears.`, { replyToId });
            } else {
                // View mode: treat all args as emote name
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
