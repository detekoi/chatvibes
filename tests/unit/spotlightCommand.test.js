// tests/unit/spotlightCommand.test.js
// !tts spotlight <text|off>: the streamer's guidance for spotlight mode.

import { jest } from '@jest/globals';
import { getTranslator } from '../../src/i18n/index.js';

describe('!tts spotlight', () => {
    let enqueueMessage;
    let getTtsState;
    let setTtsStateFields;
    let spotlight;

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
        getTtsState = jest.fn().mockResolvedValue({ mode: 'spotlight' });
        setTtsStateFields = jest.fn().mockResolvedValue(true);

        jest.unstable_mockModule('../../src/lib/logger.js', () => ({
            default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        }));
        jest.unstable_mockModule('../../src/lib/chatSender.js', () => ({ enqueueMessage }));
        jest.unstable_mockModule('../../src/components/tts/ttsState.js', () => ({ getTtsState, setTtsStateFields }));

        ({ default: spotlight } = await import('../../src/components/commands/tts/spotlight.js'));
    });

    it('is a moderator command', () => {
        expect(spotlight.permission).toBe('moderator');
        expect(spotlight.usage).toBe('!tts spotlight <text|off>');
    });

    it('says when no guidance is set', async () => {
        await spotlight.execute(context([]));
        expect(reply()).toMatch(/no spotlight guidance/);
        expect(reply()).toContain('!tts spotlight <text|off>');
        expect(setTtsStateFields).not.toHaveBeenCalled();
    });

    it('shows the current guidance', async () => {
        getTtsState.mockResolvedValue({ spotlightGuidance: 'prefer questions' });
        await spotlight.execute(context([]));
        expect(reply()).toContain('prefer questions');
    });

    it('sets the guidance, trimmed and with single spaces', async () => {
        await spotlight.execute(context(['prefer', '  questions ', 'about', 'the', 'game']));
        expect(setTtsStateFields).toHaveBeenCalledWith('testchannel', { spotlightGuidance: 'prefer questions about the game' });
        expect(reply()).toContain('prefer questions about the game');
    });

    it('accepts exactly 300 characters and refuses 301 without writing', async () => {
        await spotlight.execute(context(['a'.repeat(300)]));
        expect(setTtsStateFields).toHaveBeenCalledTimes(1);
        await spotlight.execute(context(['a'.repeat(301)]));
        expect(setTtsStateFields).toHaveBeenCalledTimes(1);
        expect(reply()).toMatch(/too long/);
        expect(reply()).toContain('300');
    });

    it.each(['off', 'OFF', 'reset', 'none', 'clear'])('"%s" clears it by writing an empty string, like defaultstyle', async (word) => {
        await spotlight.execute(context([word]));
        expect(setTtsStateFields).toHaveBeenCalledWith('testchannel', { spotlightGuidance: '' });
        expect(reply()).toMatch(/removed/);
    });

    it('reports a failed write', async () => {
        setTtsStateFields.mockResolvedValue(false);
        await spotlight.execute(context(['prefer', 'questions']));
        expect(reply()).toMatch(/did not save/);
        await spotlight.execute(context(['off']));
        expect(reply()).toMatch(/did not save/);
    });
});
