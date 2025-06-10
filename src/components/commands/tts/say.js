// src/components/commands/tts/say.js
import * as ttsQueue from '../../tts/ttsQueue.js';
import { getTtsState, getUserEmotionPreference, getChannelTtsConfig } from '../../tts/ttsState.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import logger from '../../../lib/logger.js';

export default {
    name: 'say',
    description: 'Makes the bot say a message using TTS (for testing or specific announcements).',
    usage: '!tts say <message>',
    permission: 'everyone', 
    execute: async (context) => {
        const { channel, user, args } = context;
        const channelNameNoHash = channel.substring(1);

        if (args.length === 0) {
            enqueueMessage(channel, `@${user['display-name']}, Please provide a message for me to say.`);
            return;
        }

        const messageToSay = args.join(' ');

        const ttsConfig = await getTtsState(channelNameNoHash);
        if (!ttsConfig.engineEnabled) {
            enqueueMessage(channel, `@${user['display-name']}, TTS is currently disabled.`);
            return;
        }

        // Fetch user-specific or channel-default voice options
        const channelVoiceConfig = await getChannelTtsConfig(channelNameNoHash);
        const userEmotion = await getUserEmotionPreference(channelNameNoHash, user.username);

        const voiceOptions = {
            voiceId: channelVoiceConfig.voiceId, // Or allow overriding via args: args[0] is voice, args.slice(1) is message
            emotion: userEmotion || channelVoiceConfig.emotion || 'auto',
            speed: channelVoiceConfig.speed,
            pitch: channelVoiceConfig.pitch,
            // ... other relevant params
        };
        
        logger.info(`ChatVibes [${channelNameNoHash}]: User ${user.username} requested TTS say: "${messageToSay}" with options: ${JSON.stringify(voiceOptions)}`);

        await ttsQueue.enqueue(channelNameNoHash, {
            text: messageToSay,
            user: user.username, // Associate with the requesting user for preferences
            type: 'command_say', // Differentiate if needed
            voiceOptions: voiceOptions
        });
        // No confirmation message to chat for !tts say, the speech itself is the confirmation.
    },
};