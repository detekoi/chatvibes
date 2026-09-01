// tests/unit/chatHandlerSpeechGuard.test.js
// engineEnabled, the ignore list and banned words suppress speech, not commands.
//
// The guard at the top of handleChatMessage used to return before
// processCommand, so "!tts off" locked moderators out of "!tts on" and every
// other chat command until someone opened the dashboard, and an ignored viewer
// could not run "!tts ignore del" to opt back in. These tests pin the split:
// commands still run, nothing is spoken, and the one command that is itself
// speech ("!tts <text>") is held back for an ignored viewer or a banned word.

import { jest } from '@jest/globals';

describe('handleChatMessage: speech guard vs. commands', () => {
    let handleChatMessage;
    let processMessage;
    let dispatchTtsEvent;
    let getTtsState;

    const baseConfig = { engineEnabled: true, mode: 'all', emoteMode: 'read', ttsPermissionLevel: 'everyone' };

    beforeEach(async () => {
        jest.resetModules();
        processMessage = jest.fn().mockResolvedValue(null);
        dispatchTtsEvent = jest.fn().mockResolvedValue(true);
        getTtsState = jest.fn().mockResolvedValue({ ...baseConfig });

        jest.unstable_mockModule('../../src/lib/logger.js', () => ({
            default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        }));
        jest.unstable_mockModule('../../src/components/commands/commandProcessor.js', () => ({
            processMessage,
            hasPermission: jest.fn().mockReturnValue(true),
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

    const event = (text) => ({
        chatter_user_login: 'viewer',
        chatter_user_id: '1',
        message_id: 'm1',
        badges: [],
        message: { text, fragments: [{ type: 'text', text }] },
    });

    it('control: with the engine on, plain chat in all mode is spoken', async () => {
        await handleChatMessage(event('hello'), 'testchannel');
        expect(dispatchTtsEvent).toHaveBeenCalledTimes(1);
    });

    describe('engine off', () => {
        beforeEach(() => getTtsState.mockResolvedValue({ ...baseConfig, engineEnabled: false }));

        it('still processes "!tts on" so a moderator can switch it back on from chat', async () => {
            processMessage.mockResolvedValue('tts');
            await handleChatMessage(event('!tts on'), 'testchannel');
            expect(processMessage).toHaveBeenCalledTimes(1);
            expect(processMessage.mock.calls[0][2]).toBe('!tts on');
            expect(dispatchTtsEvent).not.toHaveBeenCalled();
        });

        it('speaks nothing for plain chat', async () => {
            await handleChatMessage(event('hello'), 'testchannel');
            expect(dispatchTtsEvent).not.toHaveBeenCalled();
        });

        it('hands "!tts <text>" to the command so say.js can reply that TTS is off', async () => {
            processMessage.mockResolvedValue('tts');
            await handleChatMessage(event('!tts hello'), 'testchannel');
            expect(processMessage).toHaveBeenCalledTimes(1);
            expect(dispatchTtsEvent).not.toHaveBeenCalled();
        });
    });

    describe('ignored viewer', () => {
        beforeEach(() => getTtsState.mockResolvedValue({ ...baseConfig, ignoredUserIds: { 'twitch:1': 'Viewer' } }));

        it('can still run "!tts ignore del" to opt back in', async () => {
            processMessage.mockResolvedValue('tts');
            await handleChatMessage(event('!tts ignore del'), 'testchannel');
            expect(processMessage).toHaveBeenCalledTimes(1);
            expect(dispatchTtsEvent).not.toHaveBeenCalled();
        });

        it('cannot speak through "!tts <text>"', async () => {
            await handleChatMessage(event('!tts hello'), 'testchannel');
            expect(processMessage).not.toHaveBeenCalled();
            expect(dispatchTtsEvent).not.toHaveBeenCalled();
        });

        it('is not read in all mode', async () => {
            await handleChatMessage(event('hello'), 'testchannel');
            expect(dispatchTtsEvent).not.toHaveBeenCalled();
        });
    });

    describe('banned word', () => {
        beforeEach(() => getTtsState.mockResolvedValue({ ...baseConfig, bannedWords: ['badword'] }));

        it('is not read in all mode', async () => {
            await handleChatMessage(event('this has a BadWord in it'), 'testchannel');
            expect(dispatchTtsEvent).not.toHaveBeenCalled();
        });

        it('cannot be spoken through "!tts <text>"', async () => {
            await handleChatMessage(event('!tts badword'), 'testchannel');
            expect(processMessage).not.toHaveBeenCalled();
            expect(dispatchTtsEvent).not.toHaveBeenCalled();
        });

        it('does not stop an unrelated command from running', async () => {
            processMessage.mockResolvedValue('tts');
            await handleChatMessage(event('!tts status'), 'testchannel');
            expect(processMessage).toHaveBeenCalledTimes(1);
        });
    });
});
