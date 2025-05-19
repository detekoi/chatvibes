// src/components/commands/tts/listCommands.js
import { enqueueMessage } from '../../../lib/ircSender.js';

const ttsCommandsList = [
    "!tts status - Get current status.",
    "!tts on/off - Enable/disable TTS.",
    "!tts mode <all|command> - Set read mode.",
    "!tts voices - List available voices.",
    "!tts emotion <emotion|reset> - Set your TTS emotion.",
    "!tts events <on|off> - Toggle speaking of events (subs, cheers, etc.).",
    "!tts pause/resume - Pause/resume the TTS queue.",
    "!tts clear - Clear pending TTS events.",
    "!tts stop - Stop currently speaking audio.",
    "!tts ignore add/del <user> - Manage ignored users.",
    "!tts ignored - List ignored users.",
    // Add more as they are implemented
];

export default {
    name: 'listCommands', // Will be mapped to 'commands' in tts/index.js
    description: 'Lists available TTS commands.',
    usage: '!tts commands',
    permission: 'everyone',
    execute: async (context) => {
        const { channel, user } = context;
        // Send in multiple messages if too long for one Twitch message
        const header = `@${user['display-name']}, Available TTS commands: `;
        let currentMessage = header;

        for (const cmd of ttsCommandsList) {
            if (currentMessage.length + cmd.length + 2 > 480) { // Max length with some buffer
                enqueueMessage(channel, currentMessage);
                currentMessage = cmd;
            } else {
                currentMessage += (currentMessage === header ? "" : ", ") + cmd;
            }
        }
        if (currentMessage !== header) {
            enqueueMessage(channel, currentMessage);
        } else if (ttsCommandsList.length === 0) {
             enqueueMessage(channel, `@${user['display-name']}, No TTS commands are currently listed.`);
        }
    },
};