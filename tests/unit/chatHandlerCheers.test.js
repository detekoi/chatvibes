// tests/unit/chatHandlerCheers.test.js
// The message attached to a cheer.
//
// A cheer is paid for, so its message is read in every mode once it meets
// bitsMinimumAmount, and it is never subject to ttsPermissionLevel.
// readCheerMessages (default true) switches that off in all and command mode;
// bits_points_only ignores it because reading cheers is what that mode is for.

import { jest } from '@jest/globals';

describe('handleChatMessage: cheer messages', () => {
    let handleChatMessage;
    let dispatchTtsEvent;
    let getTtsState;
    let hasPermission;

    const baseConfig = { engineEnabled: true, mode: 'command', emoteMode: 'read', ttsPermissionLevel: 'everyone' };

    beforeEach(async () => {
        jest.resetModules();
        dispatchTtsEvent = jest.fn().mockResolvedValue(true);
        getTtsState = jest.fn().mockResolvedValue({ ...baseConfig });
        hasPermission = jest.fn().mockReturnValue(false); // a plain viewer

        jest.unstable_mockModule('../../src/lib/logger.js', () => ({
            default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        }));
        jest.unstable_mockModule('../../src/components/commands/commandProcessor.js', () => ({
            processMessage: jest.fn().mockResolvedValue(null),
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

    const cheer = (bits, text = 'Cheer100 great stream') => ({
        chatter_user_login: 'viewer',
        chatter_user_id: '1',
        message_id: 'm1',
        badges: [],
        cheer: { bits },
        message: {
            text,
            fragments: [
                { type: 'cheermote', text: 'Cheer100' },
                { type: 'text', text: ' great stream' },
            ],
        },
    });

    const spoken = () => dispatchTtsEvent.mock.calls.map(c => c[1]);

    it('reads a cheer message in command mode by default', async () => {
        await handleChatMessage(cheer(100), 'testchannel');
        expect(spoken()).toHaveLength(1);
        expect(spoken()[0]).toMatchObject({ type: 'cheer_tts', text: 'great stream' });
    });

    it('reads a cheer message in all mode', async () => {
        getTtsState.mockResolvedValue({ ...baseConfig, mode: 'all' });
        await handleChatMessage(cheer(100), 'testchannel');
        expect(spoken()).toHaveLength(1);
    });

    it('does not read it when readCheerMessages is off', async () => {
        getTtsState.mockResolvedValue({ ...baseConfig, readCheerMessages: false });
        await handleChatMessage(cheer(100), 'testchannel');
        expect(spoken()).toEqual([]);
    });

    it('always reads it in bits_points_only mode, even with readCheerMessages off', async () => {
        getTtsState.mockResolvedValue({ ...baseConfig, mode: 'bits_points_only', readCheerMessages: false });
        await handleChatMessage(cheer(100), 'testchannel');
        expect(spoken()).toHaveLength(1);
    });

    it('is not subject to ttsPermissionLevel, in any mode', async () => {
        for (const mode of ['all', 'command', 'bits_points_only']) {
            dispatchTtsEvent.mockClear();
            getTtsState.mockResolvedValue({ ...baseConfig, mode, ttsPermissionLevel: 'mods' });
            await handleChatMessage(cheer(100), 'testchannel');
            expect(spoken()).toHaveLength(1);
        }
    });

    it('skips a cheer below the minimum', async () => {
        getTtsState.mockResolvedValue({ ...baseConfig, bitsMinimumAmount: 500 });
        await handleChatMessage(cheer(100), 'testchannel');
        expect(spoken()).toEqual([]);
    });

    it('treats a missing or zero minimum as 1, so every cheer counts', async () => {
        getTtsState.mockResolvedValue({ ...baseConfig, bitsMinimumAmount: 0 });
        await handleChatMessage(cheer(1, 'Cheer1 hi'), 'testchannel');
        expect(spoken()).toHaveLength(1);
    });
});
