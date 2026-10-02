// tests/unit/ytChatFormatOnlyWhenSpoken.test.js
// The YouTube handler formats a message only when that message will be spoken.
//
// Formatting used to run on every message before the mode was checked. In
// describe mode (the default) each emote is a Gemini call, so every YouTube
// chat message with an emote in command, bits_points_only or highlighted_only
// mode paid for a description that was then thrown away. A Super Sticker's
// text was formatted and then overwritten by its announcement.

import { jest } from '@jest/globals';

describe('YouTube chat: formatting only what is spoken', () => {
    let handleYouTubeChatMessage;
    let dispatchYouTubeTtsEvent;
    let getTtsState;
    let describeEmoteFromUrl;

    const baseConfig = {
        engineEnabled: true,
        youtubeEnabled: true,
        mode: 'command',
        emoteMode: 'describe',
        ttsPermissionLevel: 'everyone',
    };

    const withEmote = (extra = {}) => ({
        type: 'message',
        eventType: 'chat',
        username: 'Viewer',
        message: 'hello :wave:',
        emoteFragments: [
            { type: 'text', text: 'hello ' },
            { type: 'yt_emote', text: ':wave:', label: 'wave', imageUrl: 'https://yt3.ggpht.com/wave' },
        ],
        id: 'yt-msg-1',
        channelId: 'UCviewer',
        tags: {},
        ...extra,
    });

    const spoken = () => dispatchYouTubeTtsEvent.mock.calls.map(c => c[1]);

    beforeEach(async () => {
        jest.resetModules();
        dispatchYouTubeTtsEvent = jest.fn().mockResolvedValue(true);
        getTtsState = jest.fn().mockResolvedValue({ ...baseConfig });
        describeEmoteFromUrl = jest.fn().mockResolvedValue('a waving hand');

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
            isGeminiAvailable: () => true,
            describeEmoteFromUrl,
            processMessageWithEmoteDescriptions: jest.fn(),
        }));

        ({ handleYouTubeChatMessage } = await import('../../src/components/youtube/ytChatClient.js'));
    });

    it.each(['command', 'bits_points_only', 'highlighted_only'])(
        'does not describe the emotes of plain chat it will not speak, in %s mode',
        async (mode) => {
            getTtsState.mockResolvedValue({ ...baseConfig, mode });
            await handleYouTubeChatMessage('chan-1', withEmote());
            expect(describeEmoteFromUrl).not.toHaveBeenCalled();
            expect(spoken()).toEqual([]);
        }
    );

    it('does not describe the emotes of a "!tts" message it will not speak', async () => {
        getTtsState.mockResolvedValue({ ...baseConfig, mode: 'highlighted_only' });
        await handleYouTubeChatMessage('chan-1', withEmote({ message: '!tts hello :wave:' }));
        expect(describeEmoteFromUrl).not.toHaveBeenCalled();
    });

    it('still describes them in all mode, where the message is spoken', async () => {
        getTtsState.mockResolvedValue({ ...baseConfig, mode: 'all' });
        await handleYouTubeChatMessage('chan-1', withEmote());
        expect(describeEmoteFromUrl).toHaveBeenCalled();
        expect(spoken()).toHaveLength(1);
        expect(spoken()[0].type).toBe('chat');
    });

    it('still describes the message of a Super Chat in command mode', async () => {
        await handleYouTubeChatMessage('chan-1', withEmote({ eventType: 'superchat', amount: '$5.00' }));
        expect(describeEmoteFromUrl).toHaveBeenCalled();
        expect(spoken()).toHaveLength(1);
        expect(spoken()[0]).toMatchObject({ type: 'cheer_tts' });
    });

    it('speaks only the announcement for a Super Sticker, without formatting its text', async () => {
        await handleYouTubeChatMessage('chan-1', withEmote({ eventType: 'supersticker', amount: '$2.00' }));
        expect(describeEmoteFromUrl).not.toHaveBeenCalled();
        expect(spoken()).toHaveLength(1);
        expect(spoken()[0].type).toBe('cheer_tts');
        expect(spoken()[0].text).toMatch(/\$2\.00/);
        expect(spoken()[0].text).not.toMatch(/hello|wave/);
    });
});
