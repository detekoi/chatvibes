// src/components/twitch/handlers/chatHandler.js
// Handles chat message events from Twitch EventSub

import logger from '../../../lib/logger.js';
import config from '../../../config/index.js';
import { convertEventSubToTags } from '../eventSubToTags.js';
import { processMessage as processCommand, hasPermission } from '../../commands/commandProcessor.js';
import { mapPermissionLevel } from '../../../lib/permissions.js';
import { parseTtsCommandText, stripCommandPrefixFromFragments } from '../../../lib/ttsCommandText.js';
import { getTtsState, getUserEmoteModePreference } from '../../tts/ttsState.js';
import { dispatchTtsEvent } from '../../../lib/ttsDispatch.js';
import { getSharedSessionInfo } from '../eventUtils.js';
import { isGeminiAvailable } from '../../../lib/emotes/index.js';
import { formatTtsText } from '../../../lib/formatTtsText.js';
import { getPronunciationRules } from '../../../lib/textRewrite/pronunciation.js';
import { resolveChannelLocale } from '../../../i18n/index.js';
import { storeFragments } from '../redemptionFragmentCache.js';
import { isTwitchUserIgnored } from '../../../lib/ignoreList.js';
import { isTtsSubCommand } from '../../commands/tts/subcommandNames.js';

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

    // Skip if channel points redemption (handled by EventSub channel.channel_points_custom_reward_redemption.add)
    // Stash fragment data BEFORE any async work to minimize the race window with the
    // redemption handler, which may call consumeFragments concurrently.
    if (event.channel_points_custom_reward_id) {
        const userId = event.chatter_user_id || event.user_id;
        const fragments = event.message?.fragments || null;
        storeFragments(
            event.channel_points_custom_reward_id,
            userId,
            channelName,
            fragments,
            event.message?.text || ''
        );
        return;
    }

    // Get shared session info (after channel-points early-return to avoid wasted async work)
    const sharedSessionInfo = await getSharedSessionInfo(channelName);

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

    // Strip the @mention prefix that Twitch prepends to reply messages.
    // When a user replies to someone, the message text arrives as
    // "@targetUser !tts hello" — we strip the leading mention so command
    // parsing works and TTS doesn't redundantly read the @mention aloud.
    // The reply metadata is already captured separately in event.reply.
    if (event.reply) {
        cleanMessage = cleanMessage.replace(/^@\S+\s+/, '');
        if (!cleanMessage) return;
    }

    // --- TTS CONFIG & EMOTE MODE RESOLUTION ---
    // Resolved before command processing so eventData can flow into command handlers
    const ttsConfig = await getTtsState(channelName);
    const locale = resolveChannelLocale(ttsConfig);
    const userId = event.chatter_user_id || event.user_id; // Extract User ID
    const isTtsIgnored = isTwitchUserIgnored(ttsConfig, userId);
    // Check against cleanMessage (not raw messageText) so the reply-target
    // @username that Twitch prepends doesn't trigger false banned-word hits.
    const containsBannedWord = ttsConfig.bannedWords?.length > 0 &&
        ttsConfig.bannedWords.some(w => w && cleanMessage.toLowerCase().includes(String(w).toLowerCase()));

    // These three suppress *speech*, not commands. Returning here used to skip
    // command processing too, so "!tts off" locked moderators out of "!tts on"
    // and every other chat command until someone opened the dashboard, and an
    // ignored viewer could not run "!tts ignore del" to opt back in. Commands
    // now run below with their own checks: say.js refuses when the engine is
    // off and replies to say so. The one command that must not run for an
    // ignored viewer or a banned word is "!tts <text>", because it is speech.
    const speechSuppressed = !ttsConfig.engineEnabled || isTtsIgnored || containsBannedWord;
    const ttsCommand = parseTtsCommandText(cleanMessage);
    const isSayCommand = !!ttsCommand && ttsCommand.args.length > 0 && !isTtsSubCommand(ttsCommand.args[0]);
    if (isSayCommand && (isTtsIgnored || containsBannedWord)) {
        logger.debug({ channelName, user: username, ignored: isTtsIgnored, bannedWord: containsBannedWord }, 'Skipping !tts say');
        return;
    }

    // Resolve emote mode: user preference → channel default → 'describe'
    const userEmoteMode = await getUserEmoteModePreference(username, userId);
    // Channel-level emote mode
    let channelEmoteMode = ttsConfig.emoteMode || 'describe';
    const emoteMode = userEmoteMode || channelEmoteMode;
    const fragmentTypes = event.message?.fragments?.map(f => ({ type: f.type, text: f.text.substring(0, 20), hasEmoteId: !!f.emote?.id })) || [];
    logger.info({ userEmoteMode, channelEmoteMode, emoteMode, bits, fragmentTypes, geminiAvailable: isGeminiAvailable() }, 'Emote mode resolved');

    // Filter out cheermote fragments for emote processing so cheermote text
    // doesn't appear in the described/skipped output
    let ttsFragments = event.message?.fragments?.filter(f => f.type !== 'cheermote');

    // Strip the leading @mention fragment for replies, mirroring the text-level
    // strip above (line ~76).  Both assume Twitch sends a mention-typed first
    // fragment for replies — if that EventSub contract changes, update both.
    // Without this, emote-mode processing (skip/describe) would rebuild text
    // from fragments and re-inject the @mention into spoken output.
    if (event.reply && ttsFragments?.length > 0 && ttsFragments[0].type === 'mention') {
        ttsFragments = ttsFragments.slice(1);
        // Trim leading whitespace from the next fragment so it doesn't start with a space
        if (ttsFragments.length > 0 && ttsFragments[0].type === 'text') {
            ttsFragments[0] = { ...ttsFragments[0], text: ttsFragments[0].text.replace(/^\s+/, '') };
        }
    } else if (event.reply && ttsFragments?.length > 0 && ttsFragments[0].type === 'text') {
        // Fallback: if Twitch sends the reply target as plain text rather than a mention
        // fragment, strip it from the text to stay consistent with the text-level strip above.
        ttsFragments[0] = { ...ttsFragments[0], text: ttsFragments[0].text.replace(/^@\S+\s*/, '') };
        if (!ttsFragments[0].text) {
            ttsFragments = ttsFragments.slice(1);
        }
    }

    // Build command-specific fragments: strip the leading "!tts" text prefix so
    // the fragment array aligns with the text say.js will speak (everything after !tts).
    // Case-insensitive, matching commandProcessor: "!TTS hello" is dispatched
    // to say.js too, so its fragments need the same trim.
    let commandFragments = ttsFragments;
    if (ttsCommand && ttsFragments) {
        commandFragments = stripCommandPrefixFromFragments(ttsFragments, '!tts');
    }

    // --- COMMAND PROCESSING ---
    // A cheer whose message starts with "!tts" is still a cheer: the viewer paid
    // for it, so it must not go through say.js, where ttsPermissionLevel applies
    // and bits_points_only mode is silent. The prefix is dropped and the text
    // falls through to the cheer branch below. A cheer carrying a real
    // subcommand ("!tts status") is rare and still runs as a command.
    const isPaidSay = isSayCommand && bits > 0;
    let processedCommandName = null;
    if (isPaidSay) {
        cleanMessage = ttsCommand.args.join(' ');
        if (ttsFragments) ttsFragments = commandFragments;
        logger.debug({ channelName, user: username, bits }, 'Cheer message starts with !tts; reading it as a cheer');
    } else {
        processedCommandName = await processCommand(channelName, tags, cleanMessage, {
            fragments: commandFragments,
            emoteMode,
            channelEmoteMode,
            readFullUrls: ttsConfig.readFullUrls,
        });
    }

    if (speechSuppressed) {
        logger.debug({ channelName, user: username, engineEnabled: ttsConfig.engineEnabled, ignored: isTtsIgnored, bannedWord: containsBannedWord }, 'Speech suppressed; command processed only');
        return;
    }

    // --- TTS PUBLISHING ---
    // readCommandMessages off means a message starting with "!" is not speech
    // in all mode. It covers both branches below: a command the bot ran itself
    // (!myvoice) and one it does not know (!lurk, !so), which otherwise falls
    // through and is read as ordinary chat. !tts never reaches either branch:
    // say.js enqueues its own speech and returns 'tts', which is skipped here.
    // Cheers are exempt below, as they are from every other gate: paid for.
    const isCommandShaped = cleanMessage.trimStart().startsWith('!');
    const skipCommandMessage = ttsConfig.readCommandMessages === false && isCommandShaped;

    // A. If a command was just run, decide if we should READ the command text aloud
    if (processedCommandName) {
        // Read non-tts commands aloud in 'all' mode
        if (processedCommandName !== 'tts' && ttsConfig.mode === 'all') {
            if (skipCommandMessage) {
                logger.debug({ channel: channelName, user: username, command: processedCommandName }, 'Skipping command text - readCommandMessages is off');
                return;
            }
            const processedMessage = await formatTtsText(cleanMessage, ttsFragments, { emoteMode, channelEmoteMode, readFullUrls: ttsConfig.readFullUrls, pronunciationRules: getPronunciationRules(ttsConfig),
            locale });
            if (processedMessage) {
                await dispatchTtsEvent(channelName, { text: processedMessage, user: username, userId, type: 'command', messageId: event.message_id }, sharedSessionInfo);
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
            const minimumBits = Math.max(1, Number(ttsConfig.bitsMinimumAmount) || 1);
            if (bits >= minimumBits) {
                // A cheer is paid for, so it is not subject to ttsPermissionLevel
                // in any mode. bits_points_only always reads cheer messages; all
                // and command mode read them unless readCheerMessages is off.
                if (ttsConfig.mode === 'bits_points_only' || ttsConfig.readCheerMessages !== false) {
                    const processedMessage = await formatTtsText(cleanMessage, ttsFragments, { emoteMode, channelEmoteMode, readFullUrls: ttsConfig.readFullUrls, pronunciationRules: getPronunciationRules(ttsConfig),
            locale });
                    if (processedMessage) {
                        await dispatchTtsEvent(channelName, { text: processedMessage, user: username, userId, type: 'cheer_tts', messageId: event.message_id }, sharedSessionInfo);
                        logger.debug({ channel: channelName, user: username, bits }, 'Published cheer message for TTS');
                    }
                } else {
                    logger.debug({ channel: channelName, bits, mode: ttsConfig.mode }, 'Skipping cheer - readCheerMessages is off');
                }
            } else {
                logger.debug({ channel: channelName, bits, minimumBits }, 'Skipping cheer - insufficient bits');
            }
        }
        // Handle regular chat messages (no bits)
        else if (ttsConfig.mode === 'all') {
            if (skipCommandMessage) {
                logger.debug({ channel: channelName, user: username }, 'Skipping chat - starts with ! and readCommandMessages is off');
                return;
            }
            const requiredPermission = mapPermissionLevel(ttsConfig.ttsPermissionLevel);
            if (requiredPermission === null) {
                logger.debug({ channel: channelName, user: username, ttsPermissionLevel: ttsConfig.ttsPermissionLevel }, 'Skipping chat - unrecognized ttsPermissionLevel');
                return;
            }

            if (hasPermission(requiredPermission, tags, channelName)) {
                const processedMessage = await formatTtsText(cleanMessage, ttsFragments, { emoteMode, channelEmoteMode, readFullUrls: ttsConfig.readFullUrls, pronunciationRules: getPronunciationRules(ttsConfig),
            locale });
                if (processedMessage) {
                    await dispatchTtsEvent(channelName, { text: processedMessage, user: username, userId, type: 'chat', messageId: event.message_id }, sharedSessionInfo);
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
