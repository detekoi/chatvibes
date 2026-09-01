// tests/unit/chatHandlerCommandMessages.test.js
// readCommandMessages: whether a chat message that starts with "!" is speech.
//
// In all mode, a message like "!lurk" or "!so" is a command for some other bot
// (Nightbot, StreamElements). The bot does not know it, so commandProcessor
// returns nothing and the message used to fall through and be read as chat.
// A command the bot does know but that is not "!tts" was read aloud too, on
// purpose. readCommandMessages (default true) keeps both; off skips both.
// "!tts <text>" is dispatched to say.js before the setting is consulted, so it
// is never affected, and a cheer is paid for, so it is exempt here as it is
// from every other gate.

import { jest } from '@jest/globals';

describe('handleChatMessage: messages that start with "!"', () => {
    let handleChatMessage;
    let dispatchTtsEvent;
    let getTtsState;
    let hasPermission;
    let processMessage;

    const allMode = { engineEnabled: true, mode: 'all', emoteMode: 'read', ttsPermissionLevel: 'everyone' };

    beforeEach(async () => {
        jest.resetModules();
        dispatchTtsEvent = jest.fn().mockResolvedValue(true);
        getTtsState = jest.fn().mockResolvedValue({ ...allMode });
        hasPermission = jest.fn().mockReturnValue(true);
        // Unknown command by default, which is what "!lurk" gets.
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

    const chat = (text, extra = {}) => ({
        chatter_user_login: 'viewer',
        chatter_user_id: '1',
        message_id: 'm1',
        badges: [],
        message: { text, fragments: [{ type: 'text', text }] },
        ...extra,
    });

    const spoken = () => dispatchTtsEvent.mock.calls.map(c => c[1]);

    describe('default (readCommandMessages unset)', () => {
        it('reads an unknown "!" command as chat in all mode', async () => {
            await handleChatMessage(chat('!lurk'), 'testchannel');
            expect(spoken()).toHaveLength(1);
            expect(spoken()[0]).toMatchObject({ type: 'chat', text: '!lurk' });
        });

        it('reads a command the bot ran itself, other than !tts, in all mode', async () => {
            processMessage.mockResolvedValue('so');
            await handleChatMessage(chat('!so viewer'), 'testchannel');
            expect(spoken()).toHaveLength(1);
            expect(spoken()[0]).toMatchObject({ type: 'command' });
        });
    });

    describe('readCommandMessages: false', () => {
        beforeEach(() => {
            getTtsState.mockResolvedValue({ ...allMode, readCommandMessages: false });
        });

        it('does not read an unknown "!" command', async () => {
            await handleChatMessage(chat('!lurk'), 'testchannel');
            expect(spoken()).toEqual([]);
        });

        it('does not read a command the bot ran itself', async () => {
            processMessage.mockResolvedValue('so');
            await handleChatMessage(chat('!so viewer'), 'testchannel');
            expect(spoken()).toEqual([]);
        });

        it('still runs the command; only the speech is skipped', async () => {
            processMessage.mockResolvedValue('so');
            await handleChatMessage(chat('!so viewer'), 'testchannel');
            expect(processMessage).toHaveBeenCalledWith('testchannel', expect.anything(), '!so viewer', expect.anything());
        });

        it('still dispatches "!tts <text>" to the command processor', async () => {
            // say.js enqueues its own speech and returns 'tts'; the handler must
            // not decide anything about it here.
            processMessage.mockResolvedValue('tts');
            await handleChatMessage(chat('!tts hello'), 'testchannel');
            expect(processMessage).toHaveBeenCalledWith('testchannel', expect.anything(), '!tts hello', expect.anything());
        });

        it('still reads ordinary chat', async () => {
            await handleChatMessage(chat('hello there'), 'testchannel');
            expect(spoken()).toHaveLength(1);
            expect(spoken()[0]).toMatchObject({ type: 'chat', text: 'hello there' });
        });

        it('treats a bare "!" and leading whitespace as command-shaped', async () => {
            await handleChatMessage(chat('!'), 'testchannel');
            await handleChatMessage(chat('  !lurk'), 'testchannel');
            expect(spoken()).toEqual([]);
        });

        it('checks the message after the reply @mention is stripped', async () => {
            await handleChatMessage(chat('@someone !lurk', {
                reply: { parent_message_id: 'p1' },
                message: { text: '@someone !lurk', fragments: [{ type: 'mention', text: '@someone' }, { type: 'text', text: ' !lurk' }] },
            }), 'testchannel');
            expect(spoken()).toEqual([]);
        });

        it('still reads a cheer whose message starts with "!"', async () => {
            await handleChatMessage({
                ...chat('Cheer100 !so viewer'),
                cheer: { bits: 100 },
                message: {
                    text: 'Cheer100 !so viewer',
                    fragments: [{ type: 'cheermote', text: 'Cheer100' }, { type: 'text', text: ' !so viewer' }],
                },
            }, 'testchannel');
            expect(spoken()).toHaveLength(1);
            expect(spoken()[0]).toMatchObject({ type: 'cheer_tts', text: '!so viewer' });
        });
    });

    it('changes nothing in command mode, where "!" messages were never read', async () => {
        getTtsState.mockResolvedValue({ ...allMode, mode: 'command' });
        await handleChatMessage(chat('!lurk'), 'testchannel');
        expect(spoken()).toEqual([]);
        getTtsState.mockResolvedValue({ ...allMode, mode: 'command', readCommandMessages: false });
        await handleChatMessage(chat('!lurk'), 'testchannel');
        expect(spoken()).toEqual([]);
    });
});
