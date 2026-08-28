// src/components/commands/tts/status.js
import { getTtsState } from '../../tts/ttsState.js';
import { enqueueMessage } from '../../../lib/chatSender.js';

export default {
    name: 'status',
    description: 'Get the current TTS application status.',
    usage: '!tts status',
    permission: 'everyone', // Or 'moderator'
    execute: async (context) => {
        const { channel, replyToId } = context;
        const channelNameNoHash = channel.substring(1);
        const ttsState = await getTtsState(channelNameNoHash); // from ttsState.js
        const queueModule = await import('../../tts/ttsQueue.js'); // Dynamic import for cq
        const cq = queueModule.getOrCreateChannelQueue(channelNameNoHash);


        const statusMsg = context.t('cmd.status', {
            channel: channelNameNoHash,
            engine: context.t(ttsState.engineEnabled ? 'cmd.status.enabled' : 'cmd.status.disabled'),
            mode: ttsState.mode,
            pending: cq.queue.length,
            paused: context.t(cq.isPaused ? 'cmd.status.yes' : 'cmd.status.no'),
            voice: ttsState.voiceId,
        });
        // Use native Twitch reply instead of @mention
        enqueueMessage(channel, statusMsg, { replyToId });
    },
};