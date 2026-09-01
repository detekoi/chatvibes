// tests/unit/readCommandsCommand.test.js
// !tts readcommands <on|off>: the chat switch for readCommandMessages.

import { jest } from '@jest/globals';
import { getTranslator } from '../../src/i18n/index.js';

describe('!tts readcommands', () => {
    let enqueueMessage;
    let getTtsState;
    let setTtsState;
    let readCommands;

    const reply = () => enqueueMessage.mock.calls.at(-1)?.[1] ?? '';

    const context = (args) => ({
        channel: '#TestChannel',
        user: { username: 'somemod', 'user-id': '777' },
        args,
        replyToId: 'msg-1',
        t: getTranslator('en'),
    });

    beforeEach(async () => {
        jest.resetModules();
        enqueueMessage = jest.fn();
        getTtsState = jest.fn().mockResolvedValue({});
        setTtsState = jest.fn().mockResolvedValue(true);

        jest.unstable_mockModule('../../src/lib/logger.js', () => ({
            default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        }));
        jest.unstable_mockModule('../../src/lib/chatSender.js', () => ({ enqueueMessage }));
        jest.unstable_mockModule('../../src/components/tts/ttsState.js', () => ({ getTtsState, setTtsState }));

        ({ default: readCommands } = await import('../../src/components/commands/tts/readCommands.js'));
    });

    it('reports ON when the setting was never written', async () => {
        await readCommands.execute(context([]));
        expect(reply()).toMatch(/currently ON/);
        expect(setTtsState).not.toHaveBeenCalled();
    });

    it('reports OFF when the channel switched it off', async () => {
        getTtsState.mockResolvedValue({ readCommandMessages: false });
        await readCommands.execute(context(['status']));
        expect(reply()).toMatch(/currently OFF/);
    });

    it('writes false for "off" and confirms', async () => {
        await readCommands.execute(context(['OFF']));
        expect(setTtsState).toHaveBeenCalledWith('testchannel', 'readCommandMessages', false);
        expect(reply()).toMatch(/turned OFF/);
        expect(reply()).toMatch(/!tts still works/);
    });

    it('writes true for "on"', async () => {
        await readCommands.execute(context(['on']));
        expect(setTtsState).toHaveBeenCalledWith('testchannel', 'readCommandMessages', true);
        expect(reply()).toMatch(/turned ON/);
    });

    it('rejects anything else without writing', async () => {
        await readCommands.execute(context(['maybe']));
        expect(setTtsState).not.toHaveBeenCalled();
        expect(reply()).toMatch(/Use 'on' or 'off'/);
    });

    it('reports a failed write', async () => {
        setTtsState.mockResolvedValue(false);
        await readCommands.execute(context(['off']));
        expect(reply()).toMatch(/Could not change/);
    });
});
