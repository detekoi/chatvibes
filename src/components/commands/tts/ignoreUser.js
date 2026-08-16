// src/components/commands/tts/ignoreUser.js
import { addIgnoredUser, removeIgnoredUser, getTtsState } from '../../tts/ttsState.js';
import { enqueueMessage } from '../../../lib/chatSender.js';
import { isPrivilegedUser } from '../../../lib/permissions.js';
import { getUsersByLogin } from '../../twitch/helixClient.js';
import { findRecentYouTubeChatter } from '../../youtube/ytChatClient.js';
import { getChannelIdFromName } from '../../../lib/allowList.js';
import {
    ignoreKey,
    listIgnoredAccounts,
    PLATFORM_TWITCH,
    PLATFORM_YOUTUBE,
} from '../../../lib/ignoreList.js';
import logger from '../../../lib/logger.js';

/**
 * Turn the name a moderator typed into an ignore-list key.
 *
 * Twitch is tried first: a login always resolves through Helix, and that is the
 * overwhelmingly common case. Only when Twitch has no such account do we look at
 * the YouTube viewers seen recently in this channel, which is the one place a
 * YouTube display name can be tied to its immutable channel ID.
 *
 * @param {string} channelNameNoHash
 * @param {string} rawName As typed, minus any leading @
 * @returns {Promise<{ key: string, label: string }|{ error: string }>}
 */
async function resolveIgnoreTarget(channelNameNoHash, rawName) {
    const twitchUsers = await getUsersByLogin([rawName.toLowerCase()]);
    if (twitchUsers.length > 0) {
        const user = twitchUsers[0];
        return {
            key: ignoreKey(PLATFORM_TWITCH, user.id),
            label: user.display_name || user.login,
        };
    }

    const channelId = getChannelIdFromName(channelNameNoHash);
    const ytChatter = channelId ? findRecentYouTubeChatter(channelId, rawName) : null;
    if (ytChatter) {
        return {
            key: ignoreKey(PLATFORM_YOUTUBE, ytChatter.authorChannelId),
            label: ytChatter.displayName,
        };
    }

    return { error: `No Twitch account named "${rawName}" exists, and no YouTube viewer by that name has spoken here recently.` };
}

/**
 * Find an existing entry whose display label matches what was typed. Removal has
 * to work on the name the list actually shows, which goes stale when someone
 * renames — resolving the name afresh would then miss the entry it belongs to.
 * @param {object} ttsConfig
 * @param {string} rawName
 * @returns {{ key: string, label: string }|null}
 */
function findListedByLabel(ttsConfig, rawName) {
    const wanted = rawName.toLowerCase();
    const match = listIgnoredAccounts(ttsConfig).find(e => e.label.toLowerCase() === wanted);
    return match ? { key: match.key, label: match.label } : null;
}

export default {
    name: 'ignore',
    description: 'Adds self to TTS ignore list. Mods can add/remove any user. Usage: !tts ignore <username> OR !tts ignore <add|del|delete|rem|remove> <username>',
    usage: '!tts ignore <username> | !tts ignore add <username> | !tts ignore <del|delete|rem|remove> <username (mod only)>',
    permission: 'everyone',
    execute: async (context) => {
        const { channel, user, args, replyToId } = context;
        const channelNameNoHash = channel.substring(1).toLowerCase();
        const invokingUsernameLower = user.username.toLowerCase();
        const invokingUserId = user['user-id'];

        // Determine invoker's status
        const isModOrBroadcaster = isPrivilegedUser(user, channelNameNoHash);

        // The remaining args are joined rather than indexed: YouTube display names
        // routinely contain spaces, and args arrive whitespace-split. Omitting the
        // verb still means add, so "!tts ignore <name>" keeps working.
        // Null-prototype so a viewer named "constructor" or "toString" is read as a
        // name rather than resolving to an inherited Object property.
        const ACTIONS = Object.assign(Object.create(null),
            { add: 'add', del: 'del', delete: 'del', rem: 'del', remove: 'del' });
        const verb = ACTIONS[args[0]?.toLowerCase()];
        const action = verb || 'add';
        const targetUsername = (verb ? args.slice(1) : args).join(' ').trim().replace(/^@/, '');

        if (!targetUsername) {
            let usageMsg = `Usage: !tts ignore <username_to_ignore_yourself>, OR !tts ignore add <username_to_ignore_yourself_or_other_if_mod>, OR (mods only) !tts ignore <del|remove> <username_to_unignore>`;
            if (args.length === 0) {
                 usageMsg = `You can ignore yourself with '!tts ignore ${invokingUsernameLower}'. Mods can use '!tts ignore add <user>' or '!tts ignore del <user>'.`;
            }
            enqueueMessage(channel, usageMsg, { replyToId });
            return;
        }

        const isSelf = targetUsername.toLowerCase() === invokingUsernameLower;

        try {
            if (action === 'add') {
                // Non-mods may only add themselves
                if (!isSelf && !isModOrBroadcaster) {
                    enqueueMessage(channel, `You can only add yourself or another user (if you are a mod) to the ignore list. Try '!tts ignore ${invokingUsernameLower}'.`, { replyToId });
                    return;
                }

                // Self-ignore skips the Helix round trip: the invoker's own ID is
                // already on the message that triggered this command.
                const target = isSelf && invokingUserId ?
                    { key: ignoreKey(PLATFORM_TWITCH, invokingUserId), label: user['display-name'] || user.username } :
                    await resolveIgnoreTarget(channelNameNoHash, targetUsername);

                if (target.error) {
                    enqueueMessage(channel, target.error, { replyToId });
                    return;
                }

                const success = await addIgnoredUser(channelNameNoHash, target.key, target.label);
                if (isSelf) {
                    enqueueMessage(channel, success ? `You will now be ignored by TTS.` : `Could not add you to the ignore list.`, { replyToId });
                } else {
                    enqueueMessage(channel, success ? `${target.label} will now be ignored by TTS.` : `Could not add ${target.label} to ignore list.`, { replyToId });
                }
                return;
            }

            // action === 'del' — only mods/broadcasters can delete
            if (!isModOrBroadcaster) {
                enqueueMessage(channel, `Only moderators can remove users from the TTS ignore list.`, { replyToId });
                return;
            }

            const ttsConfig = await getTtsState(channelNameNoHash);
            const listed = findListedByLabel(ttsConfig, targetUsername);
            const target = listed || await resolveIgnoreTarget(channelNameNoHash, targetUsername);

            if (target.error) {
                enqueueMessage(channel, `${targetUsername} was not on the ignore list.`, { replyToId });
                return;
            }

            const success = await removeIgnoredUser(channelNameNoHash, target.key);
            enqueueMessage(channel, success ?
                `${target.label} will no longer be ignored by TTS.` :
                `${target.label} was not on the ignore list or could not be removed.`, { replyToId });
        } catch (error) {
            logger.error({ err: error, channel: channelNameNoHash, target: targetUsername, action },
                'Failed to update the TTS ignore list.');
            enqueueMessage(channel, `Could not update the ignore list right now.`, { replyToId });
        }
    },
};
