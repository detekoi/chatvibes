// tests/unit/chatHandlerCommandFragments.test.js
// The fragments handed to "!tts" must have the prefix trimmed whatever its
// case: commandProcessor dispatches "!TTS hello" to say.js just like
// "!tts hello", and in skip/describe emote modes say.js rebuilds the spoken
// text from those fragments — a leftover "!TTS" fragment is read aloud.

import { jest } from '@jest/globals';

describe('handleChatMessage: !tts fragment trimming', () => {
    let handleChatMessage;
    let processMessage;

    beforeEach(async () => {
        jest.resetModules();
        processMessage = jest.fn().mockResolvedValue('tts');

        jest.unstable_mockModule('../../src/lib/logger.js', () => ({
            default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        }));
        jest.unstable_mockModule('../../src/components/commands/commandProcessor.js', () => ({
            processMessage,
            hasPermission: jest.fn().mockReturnValue(true),
        }));
        jest.unstable_mockModule('../../src/components/tts/ttsState.js', () => ({
            getTtsState: jest.fn().mockResolvedValue({ engineEnabled: true, mode: 'command', emoteMode: 'skip' }),
            getUserEmoteModePreference: jest.fn().mockResolvedValue(null),
        }));
        jest.unstable_mockModule('../../src/lib/ttsDispatch.js', () => ({ dispatchTtsEvent: jest.fn() }));
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

    const event = (text, firstFragmentText) => ({
        chatter_user_login: 'viewer',
        chatter_user_id: '1',
        message_id: 'm1',
        message: {
            text,
            fragments: [
                { type: 'text', text: firstFragmentText },
                { type: 'emote', text: 'Kappa', emote: { id: '25' } },
            ],
        },
    });

    it.each([
        ['!tts hi Kappa', '!tts hi '],
        ['!TTS hi Kappa', '!TTS hi '],
        ['!Tts hi Kappa', '!Tts hi '],
    ])('strips the prefix from the fragments for %s', async (text, first) => {
        await handleChatMessage(event(text, first), 'testchannel');

        expect(processMessage).toHaveBeenCalledTimes(1);
        const options = processMessage.mock.calls[0][3];
        expect(options.fragments).toEqual([
            { type: 'text', text: 'hi ' },
            { type: 'emote', text: 'Kappa', emote: { id: '25' } },
        ]);
    });

    it('leaves fragments alone for a message that is not a tts command', async () => {
        processMessage.mockResolvedValue(null);
        await handleChatMessage(event('!ttsfoo hi Kappa', '!ttsfoo hi '), 'testchannel');

        const options = processMessage.mock.calls[0][3];
        expect(options.fragments[0]).toEqual({ type: 'text', text: '!ttsfoo hi ' });
    });
});
