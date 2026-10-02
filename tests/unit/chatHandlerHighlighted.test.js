// tests/unit/chatHandlerHighlighted.test.js
// highlighted_only mode: Twitch "Highlight My Message" and nothing else from chat.
//
// A highlight arrives as an ordinary channel.chat.message with
// message_type "channel_points_highlighted" and no custom reward ID. In
// highlighted_only mode it is read as type 'highlight' and, being paid for, it
// skips ttsPermissionLevel the way a cheer does. Plain chat and "!tts <text>"
// are silent there; cheers keep their own switch. bits_points_only still drops
// highlights, and all mode still reads them as chat behind the permission check.

import { jest } from '@jest/globals';

describe('handleChatMessage: highlighted messages', () => {
    let handleChatMessage;
    let dispatchTtsEvent;
    let getTtsState;
    let hasPermission;
    let processMessage;

    const baseConfig = {
        engineEnabled: true,
        mode: 'highlighted_only',
        emoteMode: 'read',
        ttsPermissionLevel: 'mods',
    };

    beforeEach(async () => {
        jest.resetModules();
        dispatchTtsEvent = jest.fn().mockResolvedValue(true);
        getTtsState = jest.fn().mockResolvedValue({ ...baseConfig });
        hasPermission = jest.fn().mockReturnValue(false); // a plain viewer, below 'mods'
        processMessage = jest.fn().mockResolvedValue(null);

        jest.unstable_mockModule('../../src/lib/logger.js', () => ({
            default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        }));
        jest.unstable_mockModule('../../src/components/commands/commandProcessor.js', () => ({
            processMessage,
            hasPermission,
        }));
        jest.unstable_mockModule('../../src/components/tts/ttsState.js', () => ({
            getTtsState,
            getUserEmoteModePreference: jest.fn().mockResolvedValue(null),
        }));
        jest.unstable_mockModule('../../src/lib/ttsDispatch.js', () => ({ dispatchTtsEvent }));
        jest.unstable_mockModule('../../src/components/twitch/eventUtils.js', () => ({
            getSharedSessionInfo: jest.fn().mockResolvedValue(null),
        }));
        jest.unstable_mockModule('../../src/lib/emotes/index.js', () => ({
            isGeminiAvailable: () => false,
            processMessageWithEmoteDescriptions: jest.fn(),
        }));
        jest.unstable_mockModule('../../src/components/twitch/redemptionFragmentCache.js', () => ({
            storeFragments: jest.fn(),
        }));

        ({ handleChatMessage } = await import('../../src/components/twitch/handlers/chatHandler.js'));
    });

    const chat = (text, { highlighted = false } = {}) => ({
        chatter_user_login: 'viewer',
        chatter_user_id: '1',
        message_id: 'm1',
        message_type: highlighted ? 'channel_points_highlighted' : 'text',
        badges: [],
        message: { text, fragments: [{ type: 'text', text }] },
    });
    const highlight = (text) => chat(text, { highlighted: true });

    const cheer = (bits, { highlighted = false } = {}) => ({
        ...chat(`Cheer${bits} great stream`, { highlighted }),
        cheer: { bits },
        message: {
            text: `Cheer${bits} great stream`,
            fragments: [
                { type: 'cheermote', text: `Cheer${bits}` },
                { type: 'text', text: ' great stream' },
            ],
        },
    });

    const spoken = () => dispatchTtsEvent.mock.calls.map(c => c[1]);
    const useConfig = (overrides) => getTtsState.mockResolvedValue({ ...baseConfig, ...overrides });

    describe('in highlighted_only mode', () => {
        it('reads a highlight as type highlight, skipping ttsPermissionLevel', async () => {
            await handleChatMessage(highlight('look at me'), 'testchannel');
            expect(spoken()).toHaveLength(1);
            expect(spoken()[0]).toMatchObject({ type: 'highlight', text: 'look at me', userId: '1', messageId: 'm1' });
            expect(hasPermission).not.toHaveBeenCalled();
        });

        it('does not read plain chat', async () => {
            hasPermission.mockReturnValue(true);
            await handleChatMessage(chat('hello'), 'testchannel');
            expect(spoken()).toEqual([]);
        });

        it('reads a highlighted "!tts <text>" as a highlight without running the command', async () => {
            await handleChatMessage(highlight('!tts hi'), 'testchannel');
            expect(processMessage).not.toHaveBeenCalled();
            expect(spoken()).toHaveLength(1);
            expect(spoken()[0]).toMatchObject({ type: 'highlight', text: 'hi' });
        });

        it('still runs a !tts subcommand', async () => {
            processMessage.mockResolvedValue('tts');
            await handleChatMessage(chat('!tts status'), 'testchannel');
            expect(processMessage).toHaveBeenCalledTimes(1);
            expect(spoken()).toEqual([]);
        });

        it('does not read back another bot\'s command', async () => {
            processMessage.mockResolvedValue('lurk');
            await handleChatMessage(chat('!lurk'), 'testchannel');
            expect(spoken()).toEqual([]);
        });

        it('reads a cheer at or above the minimum as a cheer, and not one below it', async () => {
            useConfig({ bitsMinimumAmount: 100 });
            await handleChatMessage(cheer(100), 'testchannel');
            expect(spoken()).toHaveLength(1);
            expect(spoken()[0]).toMatchObject({ type: 'cheer_tts', text: 'great stream' });

            dispatchTtsEvent.mockClear();
            await handleChatMessage(cheer(50), 'testchannel');
            expect(spoken()).toEqual([]);
        });

        it('follows readCheerMessages for cheers', async () => {
            useConfig({ readCheerMessages: false });
            await handleChatMessage(cheer(100), 'testchannel');
            expect(spoken()).toEqual([]);
        });

        it('reads a highlighted cheer at or above the minimum once, as a cheer', async () => {
            await handleChatMessage(cheer(100, { highlighted: true }), 'testchannel');
            expect(spoken()).toHaveLength(1);
            expect(spoken()[0]).toMatchObject({ type: 'cheer_tts' });
        });

        it('still reads a highlighted cheer below the minimum, as a highlight', async () => {
            useConfig({ bitsMinimumAmount: 500 });
            await handleChatMessage(cheer(100, { highlighted: true }), 'testchannel');
            expect(spoken()).toHaveLength(1);
            expect(spoken()[0]).toMatchObject({ type: 'highlight', text: 'great stream' });
        });

        it('still reads a highlighted cheer with readCheerMessages off, as a highlight', async () => {
            useConfig({ readCheerMessages: false });
            await handleChatMessage(cheer(100, { highlighted: true }), 'testchannel');
            expect(spoken()).toHaveLength(1);
            expect(spoken()[0]).toMatchObject({ type: 'highlight' });
        });

        it('suppresses a highlight from an ignored viewer', async () => {
            useConfig({ ignoredUserIds: { 'twitch:1': 'viewer' } });
            await handleChatMessage(highlight('look at me'), 'testchannel');
            await handleChatMessage(highlight('!tts hi'), 'testchannel');
            expect(spoken()).toEqual([]);
        });

        it('suppresses a highlight containing a banned word', async () => {
            useConfig({ bannedWords: ['badword'] });
            await handleChatMessage(highlight('this is a badword'), 'testchannel');
            expect(spoken()).toEqual([]);
        });

        it('suppresses a highlight with the engine off', async () => {
            useConfig({ engineEnabled: false });
            await handleChatMessage(highlight('look at me'), 'testchannel');
            await handleChatMessage(highlight('!tts hi'), 'testchannel');
            expect(spoken()).toEqual([]);
        });
    });

    describe('in other modes', () => {
        it('bits_points_only still drops a highlight', async () => {
            useConfig({ mode: 'bits_points_only' });
            await handleChatMessage(highlight('look at me'), 'testchannel');
            expect(spoken()).toEqual([]);
        });

        it('bits_points_only still runs a highlighted "!tts <text>" through say.js, not as paid speech', async () => {
            useConfig({ mode: 'bits_points_only' });
            processMessage.mockResolvedValue('tts');
            await handleChatMessage(highlight('!tts hi'), 'testchannel');
            expect(processMessage).toHaveBeenCalledTimes(1);
            expect(spoken()).toEqual([]);
        });

        it('all mode reads a highlight as plain chat, behind the permission check', async () => {
            useConfig({ mode: 'all' });
            await handleChatMessage(highlight('look at me'), 'testchannel');
            expect(spoken()).toEqual([]);

            hasPermission.mockReturnValue(true);
            await handleChatMessage(highlight('look at me'), 'testchannel');
            expect(spoken()).toHaveLength(1);
            expect(spoken()[0]).toMatchObject({ type: 'chat' });
        });

        it('command mode does not read a highlight', async () => {
            useConfig({ mode: 'command' });
            await handleChatMessage(highlight('look at me'), 'testchannel');
            expect(spoken()).toEqual([]);
        });
    });
});
