// src/components/twitch/handlers/chatHandler.js
// Handles chat message events from Twitch EventSub

import logger from '../../../lib/logger.js';
import config from '../../../config/index.js';
import { convertEventSubToTags } from '../eventSubToTags.js';
import { processMessage as processCommand, hasPermission } from '../../commands/commandProcessor.js';
import { getTtsState, getUserEmoteModePreference } from '../../tts/ttsState.js';
import { publishTtsEvent } from '../../../lib/pubsub.js';
import { getSharedSessionInfo } from '../eventUtils.js';
import { isGeminiAvailable } from '../../../lib/emotes/index.js';
import { formatTtsText } from '../../../lib/formatTtsText.js';

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
            // Filter out cheermote fragments but keep emotes and mentions
            // so emote descriptions still work for cheer messages
            cleanMessage = event.message.fragments
                .filter(f => f.type !== 'cheermote')
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

    // --- TTS CONFIG & EMOTE MODE RESOLUTION ---
    // Resolved before command processing so eventData can flow into command handlers
    const ttsConfig = await getTtsState(channelName);
    const isTtsIgnored = ttsConfig.ignoredUsers && ttsConfig.ignoredUsers.includes(username);
    const containsBannedWord = ttsConfig.bannedWords?.length > 0 &&
        ttsConfig.bannedWords.some(w => messageText.toLowerCase().includes(w));

    // If TTS is globally off, user is ignored, or message contains banned word, skip TTS
    if (!ttsConfig.engineEnabled || isTtsIgnored || containsBannedWord) {
        if (containsBannedWord) {
            logger.debug({ channelName, user: username }, 'Skipping message containing banned word');
        }
        return;
    }

    const userId = event.chatter_user_id || event.user_id; // Extract User ID

    // Resolve emote mode: user preference → channel default → 'describe'
    const userEmoteMode = await getUserEmoteModePreference(username, userId);
    // Channel-level emote mode
    let channelEmoteMode = ttsConfig.emoteMode || 'describe';
    const emoteMode = userEmoteMode || channelEmoteMode;
    const fragmentTypes = event.message?.fragments?.map(f => ({ type: f.type, text: f.text.substring(0, 20), hasEmoteId: !!f.emote?.id })) || [];
    logger.info({ userEmoteMode, channelEmoteMode, emoteMode, bits, fragmentTypes, geminiAvailable: isGeminiAvailable() }, 'Emote mode resolved');

    // Filter out cheermote fragments for emote processing so cheermote text
    // doesn't appear in the described/skipped output
    const ttsFragments = event.message?.fragments?.filter(f => f.type !== 'cheermote');

    // Build command-specific fragments: strip the leading "!tts" text prefix so
    // the fragment array aligns with the text say.js will speak (everything after !tts).
    let commandFragments = ttsFragments;
    if (cleanMessage.startsWith('!tts') && ttsFragments) {
        commandFragments = stripCommandPrefixFromFragments(ttsFragments, '!tts');
    }

    // --- COMMAND PROCESSING ---
    const processedCommandName = await processCommand(channelName, tags, cleanMessage, {
        fragments: commandFragments,
        emoteMode,
        channelEmoteMode,
        readFullUrls: ttsConfig.readFullUrls,
    });

    // --- TTS PUBLISHING ---
    // A. If a command was just run, decide if we should READ the command text aloud
    if (processedCommandName) {
        // Read non-tts commands aloud in 'all' mode
        if (processedCommandName !== 'tts' && ttsConfig.mode === 'all') {
            const processedMessage = await formatTtsText(cleanMessage, ttsFragments, { emoteMode, channelEmoteMode, readFullUrls: ttsConfig.readFullUrls });
            if (processedMessage) {
                await publishTtsEvent(channelName, { text: processedMessage, user: username, userId, type: 'command', messageId: event.message_id }, sharedSessionInfo);
                logger.debug({ channel: channelName, user: username, command: processedCommandName }, 'Published command text for TTS');
            }
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
                    const processedMessage = await formatTtsText(cleanMessage, ttsFragments, { emoteMode, channelEmoteMode, readFullUrls: ttsConfig.readFullUrls });
                    if (processedMessage) {
                        await publishTtsEvent(channelName, { text: processedMessage, user: username, userId, type: 'cheer_tts', messageId: event.message_id }, sharedSessionInfo);
                        logger.debug({ channel: channelName, user: username, bits }, 'Published cheer message for TTS');
                    }
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
                const processedMessage = await formatTtsText(cleanMessage, ttsFragments, { emoteMode, channelEmoteMode, readFullUrls: ttsConfig.readFullUrls });
                if (processedMessage) {
                    await publishTtsEvent(channelName, { text: processedMessage, user: username, userId, type: 'chat', messageId: event.message_id }, sharedSessionInfo);
                    logger.debug({ channel: channelName, user: username, textPreview: processedMessage.substring(0, 30) }, 'Published chat message for TTS');
                }
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

/**
 * Strip the command prefix (e.g. "!tts") from the beginning of a fragment array.
 * The first text fragment typically contains "!tts " or "!tts" — we remove that
 * prefix text so the remaining fragments align with the content say.js will speak.
 *
 * @param {Array<{type: string, text: string}>} fragments - Original fragments (cheermotes already filtered).
 * @param {string} prefix - The command prefix to strip, e.g. "!tts".
 * @returns {Array<{type: string, text: string}>} A new array with the prefix removed from the first text fragment.
 */
function stripCommandPrefixFromFragments(fragments, prefix) {
    if (!fragments || fragments.length === 0) return fragments;

    const result = [];
    let prefixStripped = false;

    for (const frag of fragments) {
        if (!prefixStripped && frag.type === 'text') {
            const trimmed = frag.text.trimStart();
            if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
                // Remove the prefix and any trailing whitespace after it
                const remaining = trimmed.slice(prefix.length).replace(/^\s+/, '');
                prefixStripped = true;
                if (remaining) {
                    result.push({ ...frag, text: remaining });
                }
                // If nothing remains after stripping, skip this fragment entirely
            } else {
                result.push(frag);
            }
        } else {
            result.push(frag);
        }
    }

    return result;
}
