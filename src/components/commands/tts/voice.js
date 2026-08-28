// src/components/commands/tts/voice.js
import { setGlobalUserPreference, clearGlobalUserPreference, getGlobalUserPreferences } from '../../tts/ttsState.js';
import { getAvailableVoices } from '../../tts/ttsService.js';
import { enqueueMessage } from '../../../lib/chatSender.js';
import logger from '../../../lib/logger.js';
import say from './say.js';

export default {
    name: 'voice',
    description: `Sets your preferred TTS voice. Use 'reset' to use channel default. Check channel !tts voices command for link to list.`,
    usage: '!tts voice <voice_id|reset>',
    permission: 'everyone',
    execute: async (context) => {
        const { channel, user, args, replyToId } = context;
        const username = user.username;
        const userId = user['user-id'];

        if (args.length === 0) {
            const prefs = await getGlobalUserPreferences(username, userId);
            const currentVoice = prefs.voiceId;
            if (currentVoice) {
                enqueueMessage(channel, context.t('cmd.voice.current', { value: currentVoice }), { replyToId });
            } else {
                enqueueMessage(channel, context.t('cmd.voice.currentUnset'), { replyToId });
            }
            return;
        }

        // Check for 'reset' first, as it's a single keyword
        if (args.length === 1 && (args[0].toLowerCase() === 'reset' || args[0].toLowerCase() === 'default' || args[0].toLowerCase() === 'auto')) {
            const success = await clearGlobalUserPreference(username, 'voiceId', userId);
            if (success) {
                enqueueMessage(channel, context.t('cmd.voice.reset'), { replyToId });
            } else {
                enqueueMessage(channel, context.t('cmd.voice.resetFailed'), { replyToId });
            }
            return;
        }

        // If not 'reset', join all arguments to form the voice_id
        // This allows for voice IDs containing spaces, which are then compared against the fetched voice list.
        // The Wavespeed model's voice_id values sometimes contain spaces or are underscore_separated.
        // The getAvailableVoices() function in ttsService.js should provide IDs in the exact format required by the API.
        const requestedVoiceIdInput = args.join(' '); // User's input, e.g., "friendly_person"

        const availableVoices = await getAvailableVoices(); // This returns [{ id: 'Friendly_Person', name: 'Friendly Person', ... }, ... ]

        // Find the voice with a case-insensitive match
        const matchedVoice = availableVoices.find(v => v.id.toLowerCase() === requestedVoiceIdInput.toLowerCase());

        if (!matchedVoice) {
            // Fallback: treat "!tts voice ..." as a say request when no valid voice matches
            const channelNameNoHash = channel.replace('#', '');
            logger.info(`[${channelNameNoHash}] No matching voice for "${requestedVoiceIdInput}". Falling back to say for user ${username}.`);
            const sayContext = {
                ...context,
                command: 'say',
                args: ['voice', ...args],
            };
            await say.execute(sayContext);
            return;
        }

        // Use the correctly cased ID from the available voices list for storing
        const validVoiceIdToStore = matchedVoice.id;

        const success = await setGlobalUserPreference(username, 'voiceId', validVoiceIdToStore, userId);
        if (success) {
            enqueueMessage(channel, context.t('cmd.voice.set', { value: validVoiceIdToStore }), { replyToId });
        } else {
            enqueueMessage(channel, context.t('cmd.voice.setFailed', { value: requestedVoiceIdInput }), { replyToId });
        }
    },
};