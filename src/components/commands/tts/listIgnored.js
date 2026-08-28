// src/components/commands/tts/listIgnored.js
import { getTtsState } from '../../tts/ttsState.js';
import { enqueueMessage } from '../../../lib/chatSender.js';
import { listIgnoredAccounts, PLATFORM_YOUTUBE } from '../../../lib/ignoreList.js';
import logger from '../../../lib/logger.js';

export default {
    name: 'listIgnored', // Mapped to 'ignored'
    description: 'Lists users currently ignored by TTS.',
    usage: '!tts ignored',
    permission: 'moderator', // Or 'everyone' if you want anyone to see
    execute: async (context) => {
        const { channel, replyToId } = context;
        const channelNameNoHash = channel.substring(1);

        try {
            const ttsConfig = await getTtsState(channelNameNoHash);
            // Entries are keyed by account ID; the stored label is what viewers
            // recognise, so that is what gets printed. A YouTube entry is marked
            // because the same display name can exist on both platforms.
            const labels = listIgnoredAccounts(ttsConfig).map(entry =>
                entry.platform === PLATFORM_YOUTUBE ? `${entry.label} (YouTube)` : entry.label);

            if (labels.length === 0) {
                enqueueMessage(channel, context.t('cmd.ignore.listEmpty'), { replyToId });
                return;
            }

            // Paginate if the list is too long for one message
            const MAX_USERS_PER_MSG = 15;
            for (let i = 0; i < labels.length; i += MAX_USERS_PER_MSG) {
                const prefix = context.t(i === 0 ? 'cmd.ignore.listPrefix' : 'cmd.ignore.listMore');
                enqueueMessage(channel, prefix + labels.slice(i, i + MAX_USERS_PER_MSG).join(', '), { replyToId });
            }
        } catch (error) {
            logger.error({ err: error, channelName: channelNameNoHash }, 'Error fetching ignored users for TTS.');
            enqueueMessage(channel, context.t('cmd.ignore.listFailed'), { replyToId });
        }
    },
};
