// tests/unit/chatHandlerSpotlight.test.js
// Spotlight mode in the Twitch chat handler.
//
// A plain chat message that passes the gates of all mode becomes a candidate for
// the spotlight buffer; a message that starts with "!" never does. Nothing is
// formatted for a candidate: formatTtsText runs only when the buffer calls the
// speak closure for a pick, which dispatches a 'spotlight' clip with the prefix
// "Chat spotlight from <display name>: ". Cheers, commands and "!tts <text>"
// keep their own paths.

import { jest } from '@jest/globals';

describe('handleChatMessage: spotlight mode', () => {
    let handleChatMessage;
    let dispatchTtsEvent;
    let getTtsState;
    let hasPermission;
    let processMessage;
    let offerSpotlightCandidate;
    let formatTtsText;
    let isViewerGloballyOptedOut;

    const baseConfig = {
        engineEnabled: true,
        mode: 'spotlight',
        emoteMode: 'read',
        ttsPermissionLevel: 'everyone',
    };

    beforeEach(async () => {
        jest.resetModules();
        dispatchTtsEvent = jest.fn().mockResolvedValue(true);
        getTtsState = jest.fn().mockResolvedValue({ ...baseConfig });
        hasPermission = jest.fn().mockReturnValue(true);
        processMessage = jest.fn().mockResolvedValue(null);
        offerSpotlightCandidate = jest.fn().mockReturnValue(true);
        formatTtsText = jest.fn(async (text) => text);
        isViewerGloballyOptedOut = jest.fn().mockResolvedValue(false);

        jest.unstable_mockModule('../../src/lib/logger.js', () => ({
            default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        }));
        jest.unstable_mockModule('../../src/components/commands/commandProcessor.js', () => ({ processMessage, hasPermission }));
        jest.unstable_mockModule('../../src/components/tts/ttsState.js', () => ({
            getTtsState,
            getUserEmoteModePreference: jest.fn().mockResolvedValue(null),
            isViewerGloballyOptedOut,
        }));
        jest.unstable_mockModule('../../src/lib/ttsDispatch.js', () => ({ dispatchTtsEvent }));
        jest.unstable_mockModule('../../src/components/twitch/eventUtils.js', () => ({
            getSharedSessionInfo: jest.fn().mockResolvedValue(null),
        }));
        jest.unstable_mockModule('../../src/lib/emotes/index.js', () => ({
            isGeminiAvailable: () => false,
            processMessageWithEmoteDescriptions: jest.fn(),
        }));
        jest.unstable_mockModule('../../src/lib/formatTtsText.js', () => ({ formatTtsText }));
        jest.unstable_mockModule('../../src/components/twitch/redemptionFragmentCache.js', () => ({ storeFragments: jest.fn() }));
        jest.unstable_mockModule('../../src/lib/spotlight/spotlightBuffer.js', () => ({ offerSpotlightCandidate }));

        ({ handleChatMessage } = await import('../../src/components/twitch/handlers/chatHandler.js'));
    });

    const chat = (text, extra = {}) => ({
        broadcaster_user_id: '100',
        chatter_user_login: 'viewer',
        chatter_user_name: 'ViewerName',
        chatter_user_id: '1',
        message_id: 'msg-1',
        message_type: 'text',
        badges: [],
        message: { text, fragments: [{ type: 'text', text }] },
        ...extra,
    });
    const offered = () => offerSpotlightCandidate.mock.calls.map(c => c[0]);
    const spoken = () => dispatchTtsEvent.mock.calls.map(c => c[1]);
    const useConfig = (overrides) => getTtsState.mockResolvedValue({ ...baseConfig, ...overrides });

    it('offers plain chat to the buffer without formatting or speaking it', async () => {
        await handleChatMessage(chat('that boss should pay rent'), 'testchannel');
        expect(offered()).toHaveLength(1);
        expect(offered()[0]).toMatchObject({
            broadcasterId: '100',
            channelName: 'testchannel',
            id: 'msg-1',
            user: 'ViewerName',
            userId: '1',
            text: 'that boss should pay rent',
            platform: 'twitch',
        });
        expect(formatTtsText).not.toHaveBeenCalled();
        expect(spoken()).toEqual([]);
    });

    it('formats and speaks a pick with the prefix when the buffer calls speak', async () => {
        await handleChatMessage(chat('that boss should pay rent'), 'testchannel');
        await expect(offered()[0].speak({ reason: 'funny' })).resolves.toBe(true);
        expect(formatTtsText).toHaveBeenCalledTimes(1);
        expect(spoken()).toEqual([expect.objectContaining({
            type: 'spotlight',
            text: 'Chat spotlight from ViewerName: that boss should pay rent',
            user: 'viewer',
            userId: '1',
            messageId: 'msg-1',
        })]);
    });

    it('says the prefix in the channel language', async () => {
        useConfig({ languageBoost: 'Spanish' });
        await handleChatMessage(chat('hola chat que tal'), 'testchannel');
        await offered()[0].speak({ reason: 'r' });
        expect(spoken()[0].text).toContain('hola chat que tal');
        expect(spoken()[0].text).toContain('ViewerName');
    });

    it('resolves false when formatting left nothing to say', async () => {
        formatTtsText.mockResolvedValue('');
        await handleChatMessage(chat('hello there'), 'testchannel');
        await expect(offered()[0].speak({ reason: 'r' })).resolves.toBe(false);
        expect(spoken()).toEqual([]);
    });

    it('never offers a message that starts with "!", even with readCommandMessages on', async () => {
        useConfig({ readCommandMessages: true });
        await handleChatMessage(chat('!lurk'), 'testchannel');
        expect(offered()).toEqual([]);
        expect(spoken()).toEqual([]);
    });

    it('does not read back a command the bot ran', async () => {
        processMessage.mockResolvedValue('lurk');
        await handleChatMessage(chat('!lurk'), 'testchannel');
        expect(offered()).toEqual([]);
        expect(spoken()).toEqual([]);
    });

    it('runs "!tts <text>" as a command, not as a candidate', async () => {
        processMessage.mockResolvedValue('tts');
        await handleChatMessage(chat('!tts hello'), 'testchannel');
        expect(processMessage).toHaveBeenCalledTimes(1);
        expect(offered()).toEqual([]);
    });

    it('applies ttsPermissionLevel', async () => {
        useConfig({ ttsPermissionLevel: 'mods' });
        hasPermission.mockReturnValue(false);
        await handleChatMessage(chat('hello there'), 'testchannel');
        expect(offered()).toEqual([]);
    });

    it('does not offer anything for an unrecognized ttsPermissionLevel', async () => {
        useConfig({ ttsPermissionLevel: 'bogus' });
        await handleChatMessage(chat('hello there'), 'testchannel');
        expect(offered()).toEqual([]);
    });

    it('does not offer a viewer on the ignore list', async () => {
        useConfig({ ignoredUserIds: { 'twitch:1': 'Viewer' } });
        await handleChatMessage(chat('hello there'), 'testchannel');
        expect(offered()).toEqual([]);
    });

    it('does not offer a message with a banned word', async () => {
        useConfig({ bannedWords: ['badword'] });
        await handleChatMessage(chat('this has badword in it'), 'testchannel');
        expect(offered()).toEqual([]);
    });

    it('does not offer a viewer who opted out of TTS everywhere', async () => {
        isViewerGloballyOptedOut.mockResolvedValue(true);
        await handleChatMessage(chat('hello there'), 'testchannel');
        expect(offered()).toEqual([]);
        expect(formatTtsText).not.toHaveBeenCalled();
    });

    it('does not offer anything when the engine is off', async () => {
        useConfig({ engineEnabled: false });
        await handleChatMessage(chat('hello there'), 'testchannel');
        expect(offered()).toEqual([]);
    });

    it('reads a cheer directly as a cheer, not through the router', async () => {
        const text = 'Cheer100 great stream';
        await handleChatMessage(chat(text, {
            cheer: { bits: 100 },
            message: { text, fragments: [{ type: 'cheermote', text: 'Cheer100' }, { type: 'text', text: ' great stream' }] },
        }), 'testchannel');
        expect(offered()).toEqual([]);
        expect(spoken()).toEqual([expect.objectContaining({ type: 'cheer_tts', text: 'great stream' })]);
    });

    it('treats a highlighted message as an ordinary candidate', async () => {
        await handleChatMessage(chat('look at me', { message_type: 'channel_points_highlighted' }), 'testchannel');
        expect(offered()).toHaveLength(1);
        expect(spoken()).toEqual([]);
    });
});
