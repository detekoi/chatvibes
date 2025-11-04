// src/components/commands/tts/preferences.js
import { enqueueMessage } from '../../../lib/ircSender.js';
import { getTtsState } from '../../tts/ttsState.js';

const WEB_UI_BASE_URL = process.env.WEB_UI_BASE_URL || 'https://tts.wildcat.chat';

export default {
    name: 'preferences',
    description: 'Get a link to customize your personal TTS settings for this channel',
    usage: '!tts preferences',
    aliases: ['prefs'],
    permission: 'everyone',
    execute: async (context) => {
        const { channel, user, replyToId } = context;
        const channelNameNoHash = channel.substring(1).toLowerCase();
        const username = user.username;

        try {
            const ttsState = await getTtsState(channelNameNoHash);
            if (ttsState && ttsState.allowViewerPreferences === false) {
                enqueueMessage(channel, `The streamer has disabled personal voice settings for this channel.`, { replyToId });
                return;
            }
        } catch (e) {
            // If fetching state fails, proceed without blocking, but log to console
            console.error('Failed to fetch TTS state for allowViewerPreferences check:', e);
        }

        const settingsUrl = `${WEB_UI_BASE_URL}/viewer-settings.html?channel=${encodeURIComponent(channelNameNoHash)}`;
        enqueueMessage(channel, `Configure your TTS settings here → ${settingsUrl}`, { replyToId });
    },
};