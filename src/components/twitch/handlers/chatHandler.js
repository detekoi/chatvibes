// src/components/twitch/handlers/chatHandler.js
// Handles chat message events from Twitch EventSub

import logger from '../../../lib/logger.js';
import config from '../../../config/index.js';
import { convertEventSubToTags } from '../eventSubToTags.js';
import { processMessage as processCommand, hasPermission } from '../../commands/commandProcessor.js';
import { getTtsState, getUserEmoteModePreference } from '../../tts/ttsState.js';
import { publishTtsEvent } from '../../../lib/pubsub.js';
import { processMessageUrls } from '../../../lib/urlProcessor.js';
import { getSharedSessionInfo } from '../eventUtils.js';
import { isGeminiAvailable, processMessageWithEmoteDescriptions } from '../../../lib/geminiEmoteDescriber.js';

/**
 * Handle channel.chat.message events
 * Processes chat messages including commands, regular messages, and cheers
 */
export async function handleChatMessage(event, channelName) {
    const username = (event.chatter_user_login || event.chatter_user_name || 'Someone').toLowerCase();
    const messageText = event.message?.text || '';
    const bits = event.cheer?.bits || 0;

    // Skip processing the bot's own messages to avoid infinite loops
    const botUsername = config.twitch.username?.toLowerCase();
    if (botUsername && username === botUsername) {
        logger.debug({ user: username }, 'Skipping bot\'s own message');
        return;
    }

    logger.debug({ channelName, user: username, text: messageText, bits }, 'Chat message event');

    // Get shared session info
    const sharedSessionInfo = await getSharedSessionInfo(channelName);

    // Skip if channel points redemption (handled by EventSub channel.channel_points_custom_reward_redemption.add)
    if (event.channel_points_custom_reward_id) {
        logger.debug({
            channelName,
            rewardId: event.channel_points_custom_reward_id
        }, 'Channel Points redemption detected - ignoring (handled by EventSub)');
        return;
    }

    // Convert EventSub event to IRC-style tags for command processor
    const tags = convertEventSubToTags(event);

    // Clean the cheermote from the message using fragments if available (EventSub)
    let cleanMessage = messageText;

    if (bits > 0) {
        if (event.message && event.message.fragments) {
            // New logic: filter out cheermote fragments entirely
            // This handles "Cheer100 hello Cheer100" -> " hello " -> "hello"
            cleanMessage = event.message.fragments
                .filter(f => f.type === 'text')
                .map(f => f.text)
                .join('')
                .trim();
        } else {
            // Fallback for cases where fragments might not be populated (though they should be for EventSub)
            // Remove cheermotes from beginning: "Cheer100 hello" or "Cheer 100 hello" -> "hello"
            cleanMessage = cleanMessage.replace(/^[\w]+\s*\d+\s*/, '').trim();
            // Remove cheermotes after !tts: "!tts Cheer100 hello" or "!tts Cheer 100 hello" -> "!tts hello"
            cleanMessage = cleanMessage.replace(/^(!tts\s+)[\w]+\s*\d+\s*/, '$1').trim();
        }
    }

    if (!cleanMessage) return;

    // --- COMMAND PROCESSING ---
    const processedCommandName = await processCommand(channelName, tags, cleanMessage);

    // --- TTS PROCESSING ---
    const ttsConfig = await getTtsState(channelName);
    const isTtsIgnored = ttsConfig.ignoredUsers && ttsConfig.ignoredUsers.includes(username);

    // If TTS is globally off for the channel or the user is on the ignore list, do no TTS
    if (!ttsConfig.engineEnabled || isTtsIgnored) {
        return;
    }

    const userId = event.chatter_user_id || event.user_id; // Extract User ID

    // Resolve emote mode: user preference → channel default → 'describe'
    const userEmoteMode = await getUserEmoteModePreference(username, userId);
    // Channel-level: check new emoteMode first, fall back to legacy skipEmotes
    let channelEmoteMode = ttsConfig.emoteMode || (ttsConfig.skipEmotes ? 'skip' : 'describe');
    const emoteMode = userEmoteMode || channelEmoteMode;
    const fragmentTypes = event.message?.fragments?.map(f => ({ type: f.type, text: f.text.substring(0, 20), hasEmoteId: !!f.emote?.id })) || [];
    logger.info({ userEmoteMode, channelEmoteMode, emoteMode, fragmentTypes, geminiAvailable: isGeminiAvailable() }, 'Emote mode resolved');

    /**
     * Process emotes in message based on emote mode.
     * - 'read': pass through raw text (no filtering)
     * - 'skip': filter out emote and cheermote fragments
     * - 'describe': replace emotes with AI-generated descriptions
     * @param {string} text - The original message text
     * @returns {Promise<string>} - Processed text based on emote mode
     */
    const processEmotes = async (text) => {
        if (emoteMode === 'read' || !event.message?.fragments) {
            return text;
        }

        if (emoteMode === 'skip') {
            return event.message.fragments
                .filter(f => f.type === 'text' || f.type === 'mention')
                .map(f => f.text)
                .join('')
                .trim() || text;
        }

        // emoteMode === 'describe'
        if (isGeminiAvailable()) {
            try {
                const described = await processMessageWithEmoteDescriptions(event.message.fragments);
                if (described) return described;
            } catch (error) {
                logger.debug({ err: error, channel: channelName, user: username }, 'Emote description failed, falling back');
            }
        }

        // Fallback: use channel's emote mode setting (but not 'describe' to avoid infinite loop)
        const fallbackMode = channelEmoteMode === 'describe' ? 'read' : channelEmoteMode;
        if (fallbackMode === 'skip') {
            return event.message.fragments
                .filter(f => f.type === 'text' || f.type === 'mention')
                .map(f => f.text)
                .join('')
                .trim() || text;
        }
        return text; // 'read' fallback
    };

    // Skip TTS processing for cheer messages in the regular handler if they'll be handled separately
    // (Note: EventSub provides cheer data in the same channel.chat.message event, not a separate cheer event)
    // So we handle both regular messages and cheer messages here

    // A. If a command was just run, decide if we should READ the command text aloud
    if (processedCommandName) {
        // Read non-tts commands aloud in 'all' mode
        if (processedCommandName !== 'tts' && ttsConfig.mode === 'all') {
            const processedMessage = processMessageUrls(await processEmotes(cleanMessage), ttsConfig.readFullUrls);
            await publishTtsEvent(channelName, { text: processedMessage, user: username, userId, type: 'command', messageId: event.message_id }, sharedSessionInfo);
            logger.debug({ channel: channelName, user: username, command: processedCommandName }, 'Published command text for TTS');
        } else if (ttsConfig.mode === 'bits_points_only') {
            // In bits/points only mode, do not read commands
            logger.info({ channel: channelName, mode: ttsConfig.mode }, 'Skipping command in bits_points_only mode');
            return;
        } else {
            // Command mode or tts command - command handler already enqueued if needed
            logger.debug({ channel: channelName, command: processedCommandName, mode: ttsConfig.mode }, 'Command processed, not reading command text aloud');
        }
    }
    // B. If it was NOT a command, it's a regular chat message or cheer
    else {
        // Handle messages with bits (cheers)
        if (bits > 0) {
            const minimumBits = ttsConfig.bitsMinimumAmount || 1;
            if (bits >= minimumBits) {
                // Only process if in all mode or bits/points mode
                if (ttsConfig.mode === 'all' || ttsConfig.mode === 'bits_points_only' || ttsConfig.bitsModeEnabled) {
                    const processedMessage = processMessageUrls(await processEmotes(cleanMessage), ttsConfig.readFullUrls);
                    await publishTtsEvent(channelName, { text: processedMessage, user: username, userId, type: 'cheer_tts', messageId: event.message_id }, sharedSessionInfo);
                    logger.debug({ channel: channelName, user: username, bits }, 'Published cheer message for TTS');
                } else {
                    logger.debug({ channel: channelName, bits, mode: ttsConfig.mode }, 'Skipping cheer - mode not compatible');
                }
            } else {
                logger.debug({ channel: channelName, bits, minimumBits }, 'Skipping cheer - insufficient bits');
            }
        }
        // Handle regular chat messages (no bits)
        else if (ttsConfig.mode === 'all') {
            let requiredPermission = 'everyone';
            if (ttsConfig.ttsPermissionLevel === 'mods') {
                requiredPermission = 'moderator';
            } else if (ttsConfig.ttsPermissionLevel === 'vip') {
                requiredPermission = 'vip';
            }

            if (hasPermission(requiredPermission, tags, channelName)) {
                const processedMessage = processMessageUrls(await processEmotes(cleanMessage), ttsConfig.readFullUrls);
                await publishTtsEvent(channelName, { text: processedMessage, user: username, userId, type: 'chat', messageId: event.message_id }, sharedSessionInfo);
                logger.debug({ channel: channelName, user: username, textPreview: processedMessage.substring(0, 30) }, 'Published chat message for TTS');
            } else {
                logger.debug({ channel: channelName, user: username, requiredPermission, hasMod: tags.mod }, 'Skipping chat - insufficient permission');
            }
        } else if (ttsConfig.mode === 'bits_points_only') {
            // In bits/points only mode, ignore normal chat without bits
            logger.debug({ channel: channelName, mode: ttsConfig.mode }, 'Skipping regular chat in bits_points_only mode');
            return;
        } else {
            // In 'command' mode, non-command messages are ignored
            logger.debug({ channel: channelName, mode: ttsConfig.mode }, 'Skipping regular chat in command mode');
        }
    }
}
