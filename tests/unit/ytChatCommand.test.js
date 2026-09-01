// tests/unit/ytChatCommand.test.js
// "!tts <text>" typed in a YouTube chat.
//
// YouTube messages never go through commandProcessor, so before this the only
// thing a channel in command mode ever spoke from YouTube was Super Chats. The
// handler now recognises the one command that answers in audio, and these tests
// pin the boundaries: it works in all and command mode and stays silent in
// bits_points_only mode (as the Twitch say handler does), it strips the prefix from the
// text and from emote fragments, it stays silent for subcommands the bot could
// not answer anyway, and it honours ttsPermissionLevel the way the Twitch say
// handler does.

import { jest } from '@jest/globals';

describe('YouTube chat: !tts command', () => {
    let handleYouTubeChatMessage;
    let dispatchYouTubeTtsEvent;
    let getTtsState;

    const baseConfig = {
        engineEnabled: true,
        youtubeEnabled: true,
        mode: 'command',
        emoteMode: 'read',
        ttsPermissionLevel: 'everyone',
    };

    const message = (text, extra = {}) => ({
        type: 'message',
        eventType: 'chat',
        username: 'Viewer',
        message: text,
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

    it('speaks "!tts <text>" in command mode, with the prefix removed', async () => {
        await handleYouTubeChatMessage('chan-1', message('!tts hello there'));

        expect(spoken()).toHaveLength(1);
        expect(spoken()[0]).toMatchObject({
            text: 'hello there',
            user: 'Viewer',
            userId: 'UCviewer',
            type: 'command_say',
            platform: 'youtube',
            messageId: 'yt-msg-1',
        });
    });

    it('still skips ordinary chat in command mode', async () => {
        await handleYouTubeChatMessage('chan-1', message('hello there'));
        expect(dispatchYouTubeTtsEvent).not.toHaveBeenCalled();
    });

    it('matches the prefix case-insensitively, as commandProcessor does', async () => {
        await handleYouTubeChatMessage('chan-1', message('!TTS Hello'));
        expect(spoken()[0].text).toBe('Hello');
    });

    it('speaks the command in all mode too, without the prefix', async () => {
        getTtsState.mockResolvedValue({ ...baseConfig, mode: 'all' });
        await handleYouTubeChatMessage('chan-1', message('!tts hello'));
        expect(spoken()[0]).toMatchObject({ text: 'hello', type: 'command_say' });
    });

    it('stays silent in bits_points_only mode, matching the Twitch say handler', async () => {
        getTtsState.mockResolvedValue({ ...baseConfig, mode: 'bits_points_only' });
        await handleYouTubeChatMessage('chan-1', message('!tts hello'));
        expect(spoken()).toEqual([]);
    });

    it('stays silent for a bare !tts', async () => {
        await handleYouTubeChatMessage('chan-1', message('!tts'));
        expect(dispatchYouTubeTtsEvent).not.toHaveBeenCalled();
    });

    it('stays silent for subcommands, which cannot be answered in a YouTube chat', async () => {
        for (const text of ['!tts status', '!tts OFF', '!tts stop', '!tts voice Wise_Woman']) {
            await handleYouTubeChatMessage('chan-1', message(text));
        }
        expect(dispatchYouTubeTtsEvent).not.toHaveBeenCalled();
    });

    it('does not treat "!ttsfoo" as a command', async () => {
        getTtsState.mockResolvedValue({ ...baseConfig, mode: 'all' });
        await handleYouTubeChatMessage('chan-1', message('!ttsfoo bar'));
        expect(spoken()[0]).toMatchObject({ text: '!ttsfoo bar', type: 'chat' });
    });

    it('strips the prefix from emote fragments so read mode does not speak it', async () => {
        await handleYouTubeChatMessage('chan-1', message('!tts hi  ', {
            emoteFragments: [
                { type: 'text', text: '!tts hi ' },
                { type: 'emote', text: ':wave:', label: 'wave', imageUrl: 'https://example.invalid/wave.png' },
            ],
        }));
        expect(spoken()).toHaveLength(1);
        expect(spoken()[0].text).not.toMatch(/!tts/);
        expect(spoken()[0].text).toMatch(/^hi\b/);
    });

    describe('ttsPermissionLevel', () => {
        it('denies a plain viewer when the channel requires mods', async () => {
            getTtsState.mockResolvedValue({ ...baseConfig, ttsPermissionLevel: 'mods' });
            await handleYouTubeChatMessage('chan-1', message('!tts hello'));
            expect(dispatchYouTubeTtsEvent).not.toHaveBeenCalled();
        });

        it('admits a YouTube moderator badge when the channel requires mods', async () => {
            getTtsState.mockResolvedValue({ ...baseConfig, ttsPermissionLevel: 'mods' });
            await handleYouTubeChatMessage('chan-1', message('!tts hello', { tags: { badges: 'moderator/1' } }));
            expect(spoken()[0].text).toBe('hello');
        });

        it('admits the channel owner for a subs gate, since a mod outranks a sub', async () => {
            getTtsState.mockResolvedValue({ ...baseConfig, ttsPermissionLevel: 'subs' });
            await handleYouTubeChatMessage('chan-1', message('!tts hello', { tags: { badges: 'verified/1,broadcaster/1' } }));
            expect(spoken()[0].text).toBe('hello');
        });

        it('does not treat a display name matching the channel as the broadcaster', async () => {
            // A YouTube display name is chosen by the viewer, so the login-equals-channel
            // fallback in permissions.js must not apply here.
            getTtsState.mockResolvedValue({ ...baseConfig, ttsPermissionLevel: 'mods' });
            await handleYouTubeChatMessage('chan-1', message('!tts hello', { username: 'chan-1' }));
            expect(dispatchYouTubeTtsEvent).not.toHaveBeenCalled();
        });

        it('denies everyone on an unrecognised level rather than failing open', async () => {
            getTtsState.mockResolvedValue({ ...baseConfig, ttsPermissionLevel: 'bogus' });
            await handleYouTubeChatMessage('chan-1', message('!tts hello', { tags: { badges: 'broadcaster/1' } }));
            expect(dispatchYouTubeTtsEvent).not.toHaveBeenCalled();
        });
    });

    it('is gated by the ignore list like any other message', async () => {
        getTtsState.mockResolvedValue({ ...baseConfig, ignoredUserIds: { 'youtube:UCviewer': 'Viewer' } });
        await handleYouTubeChatMessage('chan-1', message('!tts hello'));
        expect(dispatchYouTubeTtsEvent).not.toHaveBeenCalled();
    });

    it('does not intercept a Super Chat whose text happens to start with !tts', async () => {
        await handleYouTubeChatMessage('chan-1', message('!tts hello', { eventType: 'superchat', amount: '$5.00' }));
        expect(spoken()).toHaveLength(1);
        expect(spoken()[0].type).toBe('cheer_tts');
    });
});
