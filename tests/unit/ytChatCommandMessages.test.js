// tests/unit/ytChatCommandMessages.test.js
// readCommandMessages on the YouTube side: a chat message that starts with "!"
// is a command for some other bot, not speech, when the setting is off.
// "!tts <text>" is recognised before the regular-chat branch and keeps working,
// exactly as on Twitch.

import { jest } from '@jest/globals';

describe('YouTube chat: messages that start with "!"', () => {
    let handleYouTubeChatMessage;
    let dispatchYouTubeTtsEvent;
    let getTtsState;

    const allMode = {
        engineEnabled: true,
        youtubeEnabled: true,
        mode: 'all',
        emoteMode: 'read',
        ttsPermissionLevel: 'everyone',
    };

    const message = (text) => ({
        type: 'message',
        eventType: 'chat',
        username: 'Viewer',
        message: text,
        id: 'yt-msg-1',
        channelId: 'UCviewer',
        tags: {},
    });

    const spoken = () => dispatchYouTubeTtsEvent.mock.calls.map(c => c[1]);

    beforeEach(async () => {
        jest.resetModules();
        dispatchYouTubeTtsEvent = jest.fn().mockResolvedValue(true);
        getTtsState = jest.fn().mockResolvedValue({ ...allMode });

        jest.unstable_mockModule('../../src/lib/logger.js', () => ({
            default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        }));
        jest.unstable_mockModule('../../src/components/tts/ttsState.js', () => ({
            getTtsState,
            getAllChannelConfigs: jest.fn().mockResolvedValue([]),
            onYouTubeConfigChange: jest.fn(),
        }));
        jest.unstable_mockModule('../../src/lib/ttsDispatch.js', () => ({ dispatchYouTubeTtsEvent }));
        jest.unstable_mockModule('../../src/lib/emotes/index.js', () => ({
            isGeminiAvailable: () => false,
            describeEmoteFromUrl: jest.fn(),
            processMessageWithEmoteDescriptions: jest.fn(),
        }));

        ({ handleYouTubeChatMessage } = await import('../../src/components/youtube/ytChatClient.js'));
    });

    it('reads "!lurk" as chat in all mode by default', async () => {
        await handleYouTubeChatMessage('chan-1', message('!lurk'));
        expect(spoken()).toHaveLength(1);
        expect(spoken()[0]).toMatchObject({ type: 'chat', text: '!lurk' });
    });

    describe('readCommandMessages: false', () => {
        beforeEach(() => {
            getTtsState.mockResolvedValue({ ...allMode, readCommandMessages: false });
        });

        it('skips "!lurk"', async () => {
            await handleYouTubeChatMessage('chan-1', message('!lurk'));
            expect(spoken()).toEqual([]);
        });

        it('still speaks "!tts <text>"', async () => {
            await handleYouTubeChatMessage('chan-1', message('!tts hello there'));
            expect(spoken()).toHaveLength(1);
            expect(spoken()[0]).toMatchObject({ type: 'command_say', text: 'hello there' });
        });

        it('still reads ordinary chat', async () => {
            await handleYouTubeChatMessage('chan-1', message('hello there'));
            expect(spoken()).toHaveLength(1);
        });
    });
});
