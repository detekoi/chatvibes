// src/components/commands/tts/defaultvoice.js
import { setTtsState, getTtsState } from '../../tts/ttsState.js';
import { getAvailableVoices } from '../../tts/ttsService.js';
import { DOC_LINKS } from '../../tts/ttsConstants.js';
import { enqueueMessage } from '../../../lib/chatSender.js';
import logger from '../../../lib/logger.js';
import config from '../../../config/index.js'; // To get the system default voice

export default {
    name: 'defaultvoice',
    description: `Sets the channel's default TTS voice. Use 'reset' to use the system default. Check !tts voices for link to list.`,
    usage: '!tts defaultvoice <voice_id|reset>',
    permission: 'moderator', // Only moderators can change the channel's default voice
    execute: async (context) => {
        const { channel, args, replyToId } = context;
        const channelNameNoHash = channel.substring(1);

        if (args.length === 0) {
            const currentChannelConfig = await getTtsState(channelNameNoHash);
            const currentDefaultVoice = currentChannelConfig.voiceId || config.tts.defaultVoiceId;
            enqueueMessage(channel, context.t('cmd.defaultvoice.current', { value: currentDefaultVoice }), { replyToId });
            return;
        }

        const requestedVoiceIdOrAction = args.join(' ').toLowerCase(); // Join args and lowercase for action matching e.g. "reset"

        if (requestedVoiceIdOrAction === 'reset' || requestedVoiceIdOrAction === 'systemdefault') {
            const systemDefaultVoice = config.tts.defaultVoiceId || 'Friendly_Person'; // Fallback if not in config
            const success = await setTtsState(channelNameNoHash, 'voiceId', systemDefaultVoice);
            if (success) {
                enqueueMessage(channel, context.t('cmd.defaultvoice.reset', { value: systemDefaultVoice }), { replyToId });
                logger.info(`[${channelNameNoHash}] Channel default TTS voice reset to system default '${systemDefaultVoice}'.`);
            } else {
                enqueueMessage(channel, context.t('cmd.defaultvoice.resetFailed'), { replyToId });
            }
            return;
        }

        // If not 'reset', it's a voice_id. We will perform case-insensitive matching
        // but store the correctly cased ID.
        const requestedVoiceIdInput = args.join(' '); // Keep original casing for potential error messages

        const availableVoices = await getAvailableVoices();
        if (!availableVoices || availableVoices.length === 0) {
            enqueueMessage(channel, context.t('cmd.defaultvoice.listFailed'), { replyToId });
            logger.warn(`[${channelNameNoHash}] Could not get available voices for !tts defaultvoice command.`);
            return;
        }

        const matchedVoice = availableVoices.find(v => v.id.toLowerCase() === requestedVoiceIdInput.toLowerCase());

        if (!matchedVoice) {
            enqueueMessage(channel, context.t('cmd.defaultvoice.invalid', { value: requestedVoiceIdInput, docLink: DOC_LINKS.voices }), { replyToId });
            logger.warn(`[${channelNameNoHash}] Attempted to set invalid channel default voice: ${requestedVoiceIdInput}`);
            return;
        }

        const validVoiceIdToStore = matchedVoice.id; // Use the correctly cased ID

        const success = await setTtsState(channelNameNoHash, 'voiceId', validVoiceIdToStore);
        if (success) {
            enqueueMessage(channel, context.t('cmd.defaultvoice.set', { value: validVoiceIdToStore }), { replyToId });
            logger.info(`[${channelNameNoHash}] Channel default TTS voice set to '${validVoiceIdToStore}'.`);
        } else {
            enqueueMessage(channel, context.t('cmd.defaultvoice.setFailed', { value: validVoiceIdToStore }), { replyToId });
        }
    },
};
