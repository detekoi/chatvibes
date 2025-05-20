// src/components/commands/tts/stop.js
import * as ttsQueue from '../../tts/ttsQueue.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import logger from '../../../lib/logger.js';
import { hasPermission } from '../commandProcessor.js'; // Make sure this utility is available and works as expected

export default {
    name: 'stop',
    description: 'Stops the currently playing/generating TTS audio. Users can stop their own messages; mods can stop any.',
    usage: '!tts stop',
    permission: 'everyone', // Base permission is everyone, logic inside execute will check specifics
    execute: async (context) => {
        const { channel, user } = context;
        const channelNameNoHash = channel.substring(1);
        const invokingUsername = user.username.toLowerCase();

        const cq = ttsQueue.getOrCreateChannelQueue(channelNameNoHash);
        const userWhoseSpeechIsPlaying = cq.currentUserSpeaking ? cq.currentUserSpeaking.toLowerCase() : null;

        let canStop = false;

        // Check if there's anything to stop from the server's perspective
        const isSomethingToStopServerSide = cq.currentSpeechUrl || cq.currentSpeechController;

        if (isSomethingToStopServerSide) {
            // Case 1: User stopping their own message
            if (userWhoseSpeechIsPlaying && invokingUsername === userWhoseSpeechIsPlaying) {
                canStop = true;
                logger.info(`[${channelNameNoHash}] User ${invokingUsername} is stopping their own message.`);
            }
            // Case 2: Moderator stopping any message
            else if (hasPermission('moderator', user, channelNameNoHash)) {
                canStop = true;
                logger.info(`[${channelNameNoHash}] Moderator ${invokingUsername} is stopping message from ${userWhoseSpeechIsPlaying || 'an event/unknown source'}.`);
            }
        } else {
            // If nothing is playing/generating according to server, a mod can still issue a precautionary stop to client.
            // A regular user attempting to stop when server knows nothing is playing results in "nothing to stop".
            if (hasPermission('moderator', user, channelNameNoHash)) {
                canStop = true; // Mod can always attempt a stop, even if server thinks nothing is active
                logger.info(`[${channelNameNoHash}] Moderator ${invokingUsername} is issuing a precautionary stop command as server tracks no active speech.`);
            }
        }


        if (!canStop) {
            // If it's not their own message and they are not a mod, and something *is* playing
            if (isSomethingToStopServerSide && userWhoseSpeechIsPlaying && invokingUsername !== userWhoseSpeechIsPlaying) {
                 enqueueMessage(channel, `@${user['display-name']}, You can only stop your own messages. Moderators can stop any TTS.`);
            } else {
                // This case covers non-mods when server tracks nothing active.
                enqueueMessage(channel, `@${user['display-name']}, Nothing appears to be actively playing or generating that you can stop.`);
            }
            logger.warn(`[${channelNameNoHash}] TTS stop command by ${invokingUsername} denied or nothing to stop for them. Speaker: ${userWhoseSpeechIsPlaying}, ServerActive: ${isSomethingToStopServerSide}`);
            return;
        }

        // If permission is granted (or it's a mod's precautionary stop)
        const stopped = await ttsQueue.stopCurrentSpeech(channelNameNoHash);

        if (stopped) {
            // This means stopCurrentSpeech either aborted generation or cleared a known URL
            enqueueMessage(channel, `@${user['display-name']}, Current TTS speech/generation has been STOPPED.`);
            logger.info(`ChatVibes [${channelNameNoHash}]: TTS stopped by ${invokingUsername}. Original speaker was: ${userWhoseSpeechIsPlaying || 'N/A'}.`);
        } else {
            // This means stopCurrentSpeech found no active controller and no active URL on server side.
            // (It still sent a STOP_CURRENT_AUDIO to the client as a precaution).
            enqueueMessage(channel, `@${user['display-name']}, Sent stop signal. Nothing was actively being generated or tracked by the bot to stop.`);
        }
    },
};