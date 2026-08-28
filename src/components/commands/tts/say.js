// src/components/commands/tts/say.js
import { getTtsState } from '../../tts/ttsState.js';
import { enqueueMessage } from '../../../lib/chatSender.js';
import { dispatchTtsEvent } from '../../../lib/ttsDispatch.js';
import { formatTtsText } from '../../../lib/formatTtsText.js';
import { getPronunciationRules } from '../../../lib/textRewrite/pronunciation.js';
import { resolveChannelLocale } from '../../../i18n/index.js';
import { hasPermissionLevel, mapPermissionLevel } from '../../../lib/permissions.js';
import logger from '../../../lib/logger.js';

export default {
    name: 'say',
    description: 'Makes the bot say a message using TTS (for testing or specific announcements).',
    usage: '!tts <message>',
    permission: 'everyone', 
    execute: async (context) => {
        const { channel, user, args, replyToId } = context;
        const channelNameNoHash = channel.substring(1);

        if (args.length === 0) {
            enqueueMessage(channel, context.t('cmd.say.needMessage'), { replyToId });
            return;
        }

        const messageToSay = args.join(' ');

        const ttsConfig = await getTtsState(channelNameNoHash);
        const locale = resolveChannelLocale(ttsConfig);
        if (!ttsConfig.engineEnabled) {
            enqueueMessage(channel, context.t('cmd.say.disabled'), { replyToId });
            return;
        }

        // Enforce ttsPermissionLevel so !tts respects subscriber/vip/mods gating
        const requiredPermission = mapPermissionLevel(ttsConfig.ttsPermissionLevel);
        if (requiredPermission === null) {
            // Unrecognized permission level — deny access, don't fail open
            logger.debug({ channel: channelNameNoHash, user: user.username, ttsPermissionLevel: ttsConfig.ttsPermissionLevel }, 'Skipping !tts say - unrecognized ttsPermissionLevel');
            return;
        }
        if (requiredPermission !== 'everyone' && !hasPermissionLevel(requiredPermission, user, channelNameNoHash)) {
            logger.debug({ channel: channelNameNoHash, user: user.username, requiredPermission }, 'Skipping !tts say - insufficient ttsPermissionLevel');
            return;
        }

        // Apply emote/emoji/URL processing using the shared utility.
        // context.eventData carries fragment data and resolved emote mode from chatHandler.
        // Falls back to 'read' mode (raw text passthrough) when eventData is absent.
        const eventData = context.eventData || {};
        const processedMessage = await formatTtsText(messageToSay, eventData.fragments, {
            emoteMode: eventData.emoteMode || 'read',
            channelEmoteMode: eventData.channelEmoteMode || 'read',
            readFullUrls: ttsConfig.readFullUrls,
            pronunciationRules: getPronunciationRules(ttsConfig),
            locale,
        });

        // Use the processed result if available (null/undefined means processing wasn't possible),
        // but skip publishing entirely if the result is an empty string (e.g. all-emote message in skip mode).
        const finalText = processedMessage != null ? processedMessage : messageToSay;
        if (!finalText) {
            logger.info(`WildcatTTS [${channelNameNoHash}]: Skipping empty TTS after emote processing for user ${user.username}`);
            return;
        }

        // Publish to Pub/Sub for deduplication across instances
        await dispatchTtsEvent(channelNameNoHash, {
            text: finalText,
            user: user.username,
            userId: user['user-id'],
            type: 'command_say'
        });
        // No confirmation message to chat for !tts, the speech itself is the confirmation.
    },
};