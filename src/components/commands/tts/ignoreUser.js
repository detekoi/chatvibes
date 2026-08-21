// src/components/commands/tts/ignoreUser.js
import { addIgnoredUser, removeIgnoredUser, getTtsState } from '../../tts/ttsState.js';
import { enqueueMessage } from '../../../lib/chatSender.js';
import { isPrivilegedUser } from '../../../lib/permissions.js';
import { getUsersByLogin } from '../../twitch/helixClient.js';
import { findRecentYouTubeChatter } from '../../youtube/ytChatClient.js';
import { getChannelIdFromName } from '../../../lib/allowList.js';
import {
    ignoreKey,
    getIgnoreEntry,
    canSelfUnignore,
    listIgnoredAccounts,
    IGNORE_SOURCE_SELF,
    IGNORE_SOURCE_MODERATOR,
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
    description: 'Opt yourself out of TTS, or back in. Mods can add/remove any user. Usage: !tts ignore [username] OR !tts ignore <add|del|delete|rem|remove> [username]',
    usage: '!tts ignore [username] | !tts ignore add [username (mod only for others)] | !tts ignore del [username (mod only for others)]',
    permission: 'everyone',
    execute: async (context) => {
        const { channel, user, args, replyToId } = context;
        const channelNameNoHash = channel.substring(1).toLowerCase();
        const invokingUsernameLower = user.username.toLowerCase();
        const invokingUserId = user['user-id'];
        const invokerKey = ignoreKey(PLATFORM_TWITCH, invokingUserId);

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

        // A bare verb with no name means "me". `!tts ignore del` is how a viewer
        // undoes their own opt-out, so it has to reach the del branch rather than
        // fall out here as a usage error. A bare `!tts ignore` stays a usage hint:
        // silently muting someone who typed the command to read its help would be
        // the wrong guess in the one direction that is awkward to reverse.
        const isSelfTarget = Boolean(verb) && !targetUsername;

        if (!targetUsername && !isSelfTarget) {
            enqueueMessage(channel,
                `Opt yourself out with '!tts ignore ${invokingUsernameLower}', and back in with '!tts ignore del'. Mods can use '!tts ignore add <user>' or '!tts ignore del <user>'.`,
                { replyToId });
            return;
        }

        const isSelf = isSelfTarget || targetUsername.toLowerCase() === invokingUsernameLower;

        try {
            const ttsConfig = await getTtsState(channelNameNoHash);

            if (action === 'add') {
                // Non-mods may only add themselves
                if (!isSelf && !isModOrBroadcaster) {
                    enqueueMessage(channel, `You can only add yourself or another user (if you are a mod) to the ignore list. Try '!tts ignore ${invokingUsernameLower}'.`, { replyToId });
                    return;
                }

                // Self-ignore skips the Helix round trip: the invoker's own ID is
                // already on the message that triggered this command.
                const target = isSelf && invokingUserId ?
                    { key: invokerKey, label: user['display-name'] || user.username } :
                    await resolveIgnoreTarget(channelNameNoHash, targetUsername);

                if (target.error) {
                    enqueueMessage(channel, target.error, { replyToId });
                    return;
                }

                // A viewer re-adding themselves must not overwrite a moderator's
                // entry with a self-sourced one — that would hand them a way to
                // downgrade a mute into something they can lift a moment later.
                if (isSelf && !isModOrBroadcaster) {
                    const existing = getIgnoreEntry(ttsConfig, PLATFORM_TWITCH, invokingUserId);
                    if (existing && !canSelfUnignore(existing)) {
                        enqueueMessage(channel, `You are already ignored by TTS here — a moderator set that, so only a moderator can undo it.`, { replyToId });
                        return;
                    }
                }

                // Putting yourself on the list is self-imposed however privileged
                // you are, so a moderator who opts out and later loses the badge
                // can still opt back in. Nobody gains anything by it: a non-mod can
                // only ever target themselves, and a mod can already lift any entry.
                const provenance = {
                    source: isSelf ? IGNORE_SOURCE_SELF : IGNORE_SOURCE_MODERATOR,
                    by: invokerKey,
                };

                const success = await addIgnoredUser(channelNameNoHash, target.key, target.label, provenance);
                if (isSelf) {
                    enqueueMessage(channel, success ?
                        `You will now be ignored by TTS. Undo this with '!tts ignore del'.` :
                        `Could not add you to the ignore list.`, { replyToId });
                } else {
                    enqueueMessage(channel, success ? `${target.label} will now be ignored by TTS.` : `Could not add ${target.label} to ignore list.`, { replyToId });
                }
                return;
            }

            // action === 'del'
            //
            // A viewer may lift their own opt-out and nothing else. Matching by key
            // rather than by label for the self case sidesteps the staleness that
            // makes findListedByLabel necessary for everyone else: the invoker's ID
            // is on the message, so a rename cannot hide their own entry from them.
            if (!isModOrBroadcaster) {
                if (!isSelf) {
                    enqueueMessage(channel, `Only moderators can remove other users from the TTS ignore list. You can remove yourself with '!tts ignore del'.`, { replyToId });
                    return;
                }

                const own = getIgnoreEntry(ttsConfig, PLATFORM_TWITCH, invokingUserId);
                if (!own) {
                    enqueueMessage(channel, `You are not on the TTS ignore list.`, { replyToId });
                    return;
                }
                if (!canSelfUnignore(own)) {
                    enqueueMessage(channel, `A moderator opted you out of TTS here, so only a moderator can undo it.`, { replyToId });
                    return;
                }

                const removed = await removeIgnoredUser(channelNameNoHash, own.key);
                enqueueMessage(channel, removed ?
                    `You will no longer be ignored by TTS.` :
                    `Could not remove you from the ignore list.`, { replyToId });
                return;
            }

            const listed = isSelfTarget ?
                (getIgnoreEntry(ttsConfig, PLATFORM_TWITCH, invokingUserId) || { key: invokerKey, label: user['display-name'] || user.username }) :
                findListedByLabel(ttsConfig, targetUsername);
            const target = listed || await resolveIgnoreTarget(channelNameNoHash, targetUsername);

            if (target.error) {
                enqueueMessage(channel, `${targetUsername} was not on the ignore list.`, { replyToId });
                return;
            }

            const success = await removeIgnoredUser(channelNameNoHash, target.key);
            if (isSelf) {
                enqueueMessage(channel, success ?
                    `You will no longer be ignored by TTS.` :
                    `You were not on the ignore list or could not be removed.`, { replyToId });
                return;
            }
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
