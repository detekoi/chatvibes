// src/components/twitch/handlers/sharedChatHandler.js
// Handles Twitch Shared Chat session events

import logger from '../../../lib/logger.js';
import * as sharedChatManager from '../sharedChatManager.js';

/**
 * Handle channel.shared_chat.begin event
 * Called when a shared chat session starts
 */
export async function onBegin(event) {
    try {
        const sessionId = event?.session_id;
        const hostBroadcasterId = event?.host_broadcaster_user_id;
        const participants = event?.participants || [];

        if (!sessionId || !hostBroadcasterId) {
            logger.warn({ event }, 'WildcatTTS: channel.shared_chat.begin missing required fields');
            return;
        }

        const channelLogins = participants.map(p => p.broadcaster_user_login);
        logger.info({
            sessionId,
            hostBroadcasterId,
            participantCount: participants.length,
            channels: channelLogins
        }, `WildcatTTS: Shared chat session started: ${channelLogins.join(', ')}`);

        sharedChatManager.addSession(sessionId, hostBroadcasterId, participants);
    } catch (error) {
        logger.error({ err: error }, 'WildcatTTS: Error handling channel.shared_chat.begin');
    }
}

/**
 * Handle channel.shared_chat.update event
 * Called when participants join or leave a shared chat session
 */
export async function onUpdate(event) {
    try {
        const sessionId = event?.session_id;
        const participants = event?.participants || [];

        if (!sessionId) {
            logger.warn({ event }, 'WildcatTTS: channel.shared_chat.update missing session_id');
            return;
        }

        const channelLogins = participants.map(p => p.broadcaster_user_login);
        logger.info({
            sessionId,
            participantCount: participants.length,
            channels: channelLogins
        }, `WildcatTTS: Shared chat session updated: ${channelLogins.join(', ')}`);

        sharedChatManager.updateSession(sessionId, participants);
    } catch (error) {
        logger.error({ err: error }, 'WildcatTTS: Error handling channel.shared_chat.update');
    }
}

/**
 * Handle channel.shared_chat.end event
 * Called when a shared chat session ends
 */
export async function onEnd(event) {
    try {
        const sessionId = event?.session_id;

        if (!sessionId) {
            logger.warn({ event }, 'WildcatTTS: channel.shared_chat.end missing session_id');
            return;
        }

        logger.info({ sessionId }, 'WildcatTTS: Shared chat session ended');
        sharedChatManager.removeSession(sessionId);
    } catch (error) {
        logger.error({ err: error }, 'WildcatTTS: Error handling channel.shared_chat.end');
    }
}
