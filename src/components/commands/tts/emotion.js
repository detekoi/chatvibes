// src/components/commands/tts/emotion.js
import { setUserEmotionPreference, clearUserEmotionPreference, getUserEmotionPreference } from '../../tts/ttsState.js';
import { VALID_EMOTIONS } from '../../tts/ttsConstants.js';
import { enqueueMessage } from '../../../lib/ircSender.js';


export default {
    name: 'emotion',
    description: `Sets your preferred TTS emotion. Valid emotions: ${VALID_EMOTIONS.join(', ')}. Use 'auto' or 'reset' to use channel default.`,
    usage: '!tts emotion <emotion_name|auto|reset>',
    permission: 'everyone',
    execute: async (context) => {
        const { channel, user, args, replyToId } = context;
        const channelNameNoHash = channel.substring(1);
        const username = user.username;

        if (args.length === 0) {
            const currentEmotion = await getUserEmotionPreference(channelNameNoHash, username);
            if (currentEmotion) {
                enqueueMessage(channel, `Your current TTS emotion is set to: ${currentEmotion}. Use '!tts emotion <emotion_name>' to change it or '!tts emotion reset' to use the channel default.`, { replyToId });
            } else {
                enqueueMessage(channel, `You haven't set a specific TTS emotion. The channel default will be used. Use '!tts emotion <emotion_name>' to set one.`, { replyToId });
            }
            return;
        }

        const requestedEmotion = args[0].toLowerCase();

        if (requestedEmotion === 'reset' || requestedEmotion === 'default' || requestedEmotion === 'auto') {
            const success = await clearUserEmotionPreference(channelNameNoHash, username);
            if (success) {
                enqueueMessage(channel, `Your TTS emotion preference has been reset. The channel default will now be used.`, { replyToId });
            } else {
                enqueueMessage(channel, `Could not reset your TTS emotion preference at this time.`, { replyToId });
            }
            return;
        }

        if (!VALID_EMOTIONS.includes(requestedEmotion)) {
            enqueueMessage(channel, `Invalid emotion. Valid options are: ${VALID_EMOTIONS.join(', ')}.`, { replyToId });
            return;
        }

        const success = await setUserEmotionPreference(channelNameNoHash, username, requestedEmotion);
        if (success) {
            enqueueMessage(channel, `Your TTS emotion has been set to: ${requestedEmotion}.`, { replyToId });
        } else {
            enqueueMessage(channel, `Could not set your TTS emotion to ${requestedEmotion} at this time.`, { replyToId });
        }
    },
};