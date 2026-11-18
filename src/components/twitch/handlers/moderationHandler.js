// src/components/twitch/handlers/moderationHandler.js
// A moderator, or a moderation bot such as a spam filter, removed Twitch chat.
// The bot must not read a message that chat no longer shows, so the clips made
// from it are removed (ttsQueue.removeChatClips).
//
//   channel.chat.message_delete       one message was deleted
//   channel.chat.clear_user_messages  a viewer was timed out or banned
//
// A spotlight candidate that waits for the router is not removed. If the router
// picks it, ttsQueue.enqueue drops the clip, because it remembers the removal.
//
// Only speech made from a chat message is removed. Announcements (subs, raids,
// follows) and the TTS reward are left alone: they have no chat message to delete.
// These events act whatever the TTS mode is and whether or not the engine is on.

import logger from '../../../lib/logger.js';
import { currentTiming } from '../../../lib/ttsTiming.js';
import { removeChatClips } from '../../tts/ttsQueue.js';

export const CHAT_REMOVAL_TYPES = Object.freeze([
    'channel.chat.message_delete',
    'channel.chat.clear_user_messages',
]);

/**
 * The removal an event describes, or null when it names nothing to remove.
 * `atMs` is when the event reached the bot. For a forwarded event it is the time
 * at the first instance, the same clock that stamps a chat message.
 * @param {string} type
 * @param {object} event
 * @returns {import('../../tts/ttsQueue.js').ChatRemoval|null}
 */
export function chatRemovalFor(type, event) {
    const atMs = currentTiming()?.receivedMs ?? Date.now();
    if (type === 'channel.chat.message_delete') {
        return event?.message_id ? { messageId: String(event.message_id), atMs } : null;
    }
    if (type === 'channel.chat.clear_user_messages') {
        return event?.target_user_id ? { userId: String(event.target_user_id), atMs } : null;
    }
    return null;
}

/**
 * @param {string} type One of CHAT_REMOVAL_TYPES.
 * @param {object} event The EventSub event.
 * @param {string} channelName The channel login.
 */
export function handleChatRemoval(type, event, channelName) {
    const removal = chatRemovalFor(type, event);
    if (!removal) {
        logger.debug({ channelName, type }, 'Chat removal event names nothing to remove');
        return;
    }
    const clips = removeChatClips(channelName, removal);
    const removedSomething = clips.queued > 0 || clips.generating || clips.sent > 0;
    // No chat text in this line: only counts and IDs.
    logger[removedSomething ? 'info' : 'debug']({
        logKey: 'CHAT_REMOVAL',
        channelName,
        type,
        queued: clips.queued,
        generating: clips.generating,
        sent: clips.sent,
    }, 'A moderator removed chat; removed the speech made from it');
}
