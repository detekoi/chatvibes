// src/components/commands/tts/voice.js
import { setUserVoicePreference, clearUserVoicePreference, getUserVoicePreference } from '../../tts/ttsState.js';
import { getAvailableVoices } from '../../tts/ttsService.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import logger from '../../../lib/logger.js';

export default {
    name: 'voice',
    description: `Sets your preferred TTS voice. Use 'reset' to use channel default. Check channel !tts voices command for link to list.`,
    usage: '!tts voice <voice_id|reset>',
    permission: 'everyone',
    execute: async (context) => {
        const { channel, user, args } = context;
        const channelNameNoHash = channel.substring(1);
        const username = user.username;
        const displayName = user['display-name'] || username;

        if (args.length === 0) {
            const currentVoice = await getUserVoicePreference(channelNameNoHash, username);
            if (currentVoice) {
                enqueueMessage(channel, `@${displayName}, Your current TTS voice is set to: ${currentVoice}. Use '!tts voice <voice_id>' to change it or '!tts voice reset' to use the channel default.`);
            } else {
                enqueueMessage(channel, `@${displayName}, You haven't set a specific TTS voice. The channel default will be used. Use '!tts voice <voice_id>' to set one.`);
            }
            return;
        }

        // Check for 'reset' first, as it's a single keyword
        if (args.length === 1 && (args[0].toLowerCase() === 'reset' || args[0].toLowerCase() === 'default' || args[0].toLowerCase() === 'auto')) {
            const success = await clearUserVoicePreference(channelNameNoHash, username);
            if (success) {
                enqueueMessage(channel, `@${displayName}, Your TTS voice preference has been reset. The channel default will now be used.`);
            } else {
                enqueueMessage(channel, `@${displayName}, Could not reset your TTS voice preference at this time.`);
            }
            return;
        }

        // If not 'reset', join all arguments to form the voice_id
        // This allows for voice IDs containing spaces, which are then compared against the fetched voice list.
        // The Replicate model's voice_id values sometimes contain spaces or are underscore_separated.
        // The getAvailableVoices() function in ttsService.js should provide IDs in the exact format required by the API.
        const requestedVoiceId = args.join(' '); // Rejoin arguments with spaces

        const availableVoices = await getAvailableVoices();
        // Ensure exact match against the available voice IDs
        const isValidVoice = availableVoices.some(v => v.id === requestedVoiceId);

        if (!isValidVoice) {
            // CORRECTED DOCUMENTATION LINK
            const voicesCmdDocLink = 'https://detekoi.github.io/chatvibesdocs.html#voices';
            enqueueMessage(channel, `@${displayName}, Invalid voice ID '${requestedVoiceId}'. See the list of available voices here: ${voicesCmdDocLink} (or use !tts voices for link)`);
            logger.warn(`[${channelNameNoHash}] User ${username} attempted to set invalid voice: ${requestedVoiceId}`);
            return;
        }

        const success = await setUserVoicePreference(channelNameNoHash, username, requestedVoiceId);
        if (success) {
            enqueueMessage(channel, `@${displayName}, Your TTS voice has been set to: ${requestedVoiceId}.`);
        } else {
            enqueueMessage(channel, `@${displayName}, Could not set your TTS voice to ${requestedVoiceId} at this time.`);
        }
    },
};