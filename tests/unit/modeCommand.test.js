// tests/unit/modeCommand.test.js
// !tts mode <all|command|bits|highlight>: the chat switch for the TTS mode.

import { jest } from '@jest/globals';
import { getTranslator } from '../../src/i18n/index.js';

describe('!tts mode', () => {
    let enqueueMessage;
    let getTtsState;
    let setTtsState;
    let mode;

    const reply = () => enqueueMessage.mock.calls.at(-1)?.[1] ?? '';

    const context = (args) => ({
        channel: '#testchannel',
        user: { username: 'somemod', 'user-id': '777' },
        args,
        replyToId: 'msg-1',
        t: getTranslator('en'),
    });

    beforeEach(async () => {
        jest.resetModules();
        enqueueMessage = jest.fn();
        getTtsState = jest.fn().mockResolvedValue({ mode: 'command' });
        setTtsState = jest.fn().mockResolvedValue(true);

        jest.unstable_mockModule('../../src/lib/logger.js', () => ({
            default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        }));
        jest.unstable_mockModule('../../src/lib/chatSender.js', () => ({ enqueueMessage }));
        jest.unstable_mockModule('../../src/components/tts/ttsState.js', () => ({ getTtsState, setTtsState }));

        ({ default: mode } = await import('../../src/components/commands/tts/mode.js'));
    });

    it('reports the current mode and lists highlight among the options', async () => {
        await mode.execute(context([]));
        expect(reply()).toMatch(/command/);
        expect(reply()).toMatch(/highlight/);
        expect(setTtsState).not.toHaveBeenCalled();
    });

    it.each(['highlight', 'highlights', 'Highlighted', 'highlighted_only'])('maps "%s" to highlighted_only', async (arg) => {
        await mode.execute(context([arg]));
        expect(setTtsState).toHaveBeenCalledWith('testchannel', 'mode', 'highlighted_only');
        expect(reply()).toMatch(/highlighted_only/);
    });

    it.each(['bits', 'points', 'bits_points_only'])('maps "%s" to bits_points_only', async (arg) => {
        await mode.execute(context([arg]));
        expect(setTtsState).toHaveBeenCalledWith('testchannel', 'mode', 'bits_points_only');
    });

    it.each(['all', 'command'])('accepts "%s" as is', async (arg) => {
        await mode.execute(context([arg]));
        expect(setTtsState).toHaveBeenCalledWith('testchannel', 'mode', arg);
    });

    it('rejects anything else without writing', async () => {
        await mode.execute(context(['bogus']));
        expect(setTtsState).not.toHaveBeenCalled();
        expect(reply()).toMatch(/highlight/);
    });
});
