// tests/unit/ttsSayMode.test.js
// "!tts <text>" and the TTS mode.
//
// bits_points_only mode exists so that speech is something a viewer pays for
// with a cheer or a channel point redemption. The say handler used to check
// engineEnabled and ttsPermissionLevel but never the mode, so a "pay to speak"
// channel still spoke every free "!tts hello". It now stays silent there and
// keeps speaking in all and command mode. The YouTube path is pinned to the
// same behaviour in ytChatCommand.test.js.

import { jest } from '@jest/globals';

describe('!tts say: TTS mode', () => {
    let say;
    let getTtsState;
    let dispatchTtsEvent;
    let enqueueMessage;

    const baseConfig = { engineEnabled: true, ttsPermissionLevel: 'everyone' };

    const context = () => ({
        channel: '#chan',
        user: { username: 'viewer', 'user-id': '1' },
        args: ['hello', 'there'],
        replyToId: 'msg-1',
        t: (key) => key,
    });

    beforeEach(async () => {
        jest.resetModules();
        getTtsState = jest.fn();
        dispatchTtsEvent = jest.fn().mockResolvedValue(true);
        enqueueMessage = jest.fn();

        jest.unstable_mockModule('../../src/lib/logger.js', () => ({
            default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        }));
        jest.unstable_mockModule('../../src/components/tts/ttsState.js', () => ({ getTtsState }));
        jest.unstable_mockModule('../../src/lib/chatSender.js', () => ({ enqueueMessage }));
        jest.unstable_mockModule('../../src/lib/ttsDispatch.js', () => ({ dispatchTtsEvent }));
        jest.unstable_mockModule('../../src/lib/emotes/index.js', () => ({
            isGeminiAvailable: () => false,
            describeEmoteFromUrl: jest.fn(),
            processMessageWithEmoteDescriptions: jest.fn(),
        }));

        ({ default: say } = await import('../../src/components/commands/tts/say.js'));
    });

    it('speaks in command mode', async () => {
        getTtsState.mockResolvedValue({ ...baseConfig, mode: 'command' });
        await say.execute(context());
        expect(dispatchTtsEvent).toHaveBeenCalledTimes(1);
        expect(dispatchTtsEvent.mock.calls[0][1]).toMatchObject({ text: 'hello there', user: 'viewer' });
    });

    it('speaks in all mode', async () => {
        getTtsState.mockResolvedValue({ ...baseConfig, mode: 'all' });
        await say.execute(context());
        expect(dispatchTtsEvent).toHaveBeenCalledTimes(1);
    });

    it('stays silent in bits_points_only mode, without a chat reply', async () => {
        getTtsState.mockResolvedValue({ ...baseConfig, mode: 'bits_points_only' });
        await say.execute(context());
        expect(dispatchTtsEvent).not.toHaveBeenCalled();
        expect(enqueueMessage).not.toHaveBeenCalled();
    });

    it('still refuses when the engine is off, whatever the mode', async () => {
        getTtsState.mockResolvedValue({ ...baseConfig, mode: 'bits_points_only', engineEnabled: false });
        await say.execute(context());
        expect(dispatchTtsEvent).not.toHaveBeenCalled();
        expect(enqueueMessage).toHaveBeenCalledWith('#chan', 'cmd.say.disabled', { replyToId: 'msg-1' });
    });
});
