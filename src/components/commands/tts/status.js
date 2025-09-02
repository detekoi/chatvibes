// src/components/commands/tts/status.js
import { getTtsState } from '../../tts/ttsState.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import { getOrCreateChannelQueue } from '../../tts/ttsQueue.js';

export default {
    name: 'status',
    description: 'Get the current TTS application status.',
    usage: '!tts status',
    permission: 'everyone', // Or 'moderator'
    execute: async (context) => {
        const { channel, user, ircClient, replyToId } = context;
        const channelNameNoHash = channel.substring(1);
        const ttsState = await getTtsState(channelNameNoHash); // from ttsState.js
        const queueModule = await import('../../tts/ttsQueue.js'); // Dynamic import for cq
        const cq = queueModule.getOrCreateChannelQueue(channelNameNoHash);


        const statusMsg = `TTS Status for #${channelNameNoHash}: Engine ${ttsState.engineEnabled ? 'Enabled' : 'Disabled'}. Mode: ${ttsState.mode}. Queue: ${cq.queue.length} pending, Paused: ${cq.isPaused}. Voice: ${ttsState.voiceId}.`;
        // Use native Twitch reply instead of @mention
        enqueueMessage(channel, statusMsg, { replyToId });
    },
};