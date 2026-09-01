// src/components/commands/tts/readCommands.js
// Toggle whether a chat message that starts with "!" is read aloud in all mode.
//
// Channels running Nightbot or StreamElements heard every "!lurk", "!so" and
// "!sr" spoken as chat. Off makes the bot treat a "!"-prefixed message as a
// command for some other bot rather than as speech. "!tts" is not affected by
// this switch at all: it is dispatched as a command before the setting is
// consulted, so "!tts <text>" keeps working with it off.
import { setTtsState, getTtsState } from '../../tts/ttsState.js';
import { enqueueMessage } from '../../../lib/chatSender.js';
import logger from '../../../lib/logger.js';

export default {
    name: 'readCommands', // Mapped from 'readcommands' and 'chatcommands'
    description: 'Read or skip chat messages that start with "!" in all mode. !tts is never affected.',
    usage: '!tts readcommands <on|off>',
    permission: 'moderator',
    execute: async (context) => {
        const { channel, user, args, replyToId, t } = context;
        const channelNameNoHash = channel.substring(1).toLowerCase();
        const reply = msg => enqueueMessage(channel, msg, { replyToId });
        const stateWord = enabled => t(enabled ? 'cmd.onOff.on' : 'cmd.onOff.off');

        const action = (args[0] || 'status').toLowerCase();

        if (action === 'status') {
            const current = await getTtsState(channelNameNoHash);
            reply(t('cmd.readCommands.current', { state: stateWord(current.readCommandMessages !== false) }));
            return;
        }

        let enable;
        if (action === 'on') {
            enable = true;
        } else if (action === 'off') {
            enable = false;
        } else {
            reply(t('cmd.readCommands.invalid'));
            return;
        }

        const success = await setTtsState(channelNameNoHash, 'readCommandMessages', enable);
        if (!success) {
            reply(t('cmd.readCommands.failed'));
            return;
        }

        logger.info({ channel: channelNameNoHash, readCommandMessages: enable, user: user.username }, 'readCommandMessages toggled');
        reply(t('cmd.readCommands.set', { state: stateWord(enable) }));
    },
};
