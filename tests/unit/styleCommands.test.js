// tests/unit/styleCommands.test.js
// !tts style <text|off> (a viewer's own style) and !tts defaultstyle <text|off> (the
// channel's). Both are built by styleCommand.js and differ in where they read and write.

import { jest } from '@jest/globals';
import { getTranslator } from '../../src/i18n/index.js';
import { STYLE_MAX_LENGTH } from '../../src/components/tts/styleBuilder.js';

describe('style commands', () => {
    let enqueueMessage;
    let ttsState;
    let logger;
    let style;
    let defaultStyle;

    const reply = () => enqueueMessage.mock.calls.at(-1)?.[1] ?? '';

    const context = (args) => ({
        channel: '#testchannel',
        user: { username: 'someviewer', 'user-id': '777' },
        args,
        replyToId: 'msg-1',
        t: getTranslator('en'),
    });

    beforeEach(async () => {
        jest.resetModules();
        enqueueMessage = jest.fn();
        logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
        ttsState = {
            getTtsState: jest.fn().mockResolvedValue({}),
            setTtsState: jest.fn().mockResolvedValue(true),
            getGlobalUserPreferences: jest.fn().mockResolvedValue({}),
            setGlobalUserPreference: jest.fn().mockResolvedValue(true),
            clearGlobalUserPreference: jest.fn().mockResolvedValue(true),
        };

        jest.unstable_mockModule('../../src/lib/logger.js', () => ({ default: logger }));
        jest.unstable_mockModule('../../src/lib/chatSender.js', () => ({ enqueueMessage }));
        jest.unstable_mockModule('../../src/components/tts/ttsState.js', () => ttsState);

        ({ default: style } = await import('../../src/components/commands/tts/style.js'));
        ({ default: defaultStyle } = await import('../../src/components/commands/tts/defaultStyle.js'));
    });

    describe('!tts style', () => {
        it('is open to everyone', () => {
            expect(style.name).toBe('style');
            expect(style.permission).toBe('everyone');
            expect(style.usage).toBe('!tts style <text|off>');
        });

        it('shows the current style with no arguments', async () => {
            ttsState.getGlobalUserPreferences.mockResolvedValue({ style: 'like a pirate' });

            await style.execute(context([]));

            expect(ttsState.getGlobalUserPreferences).toHaveBeenCalledWith('777');
            expect(reply()).toBe('Your current TTS style: like a pirate. Usage: !tts style <text|off>');
            expect(enqueueMessage).toHaveBeenCalledWith('#testchannel', expect.any(String), { replyToId: 'msg-1' });
            expect(ttsState.setGlobalUserPreference).not.toHaveBeenCalled();
        });

        it('says so when the viewer has no style', async () => {
            await style.execute(context([]));

            expect(reply()).toBe('You did not set a TTS style. The bot uses the channel default. Usage: !tts style <text|off>');
        });

        it('joins the words and stores them on the viewer', async () => {
            await style.execute(context(['like', 'a', 'pirate']));

            expect(ttsState.setGlobalUserPreference).toHaveBeenCalledWith('777', 'style', 'like a pirate', 'someviewer');
            expect(reply()).toBe('Your TTS style is now: like a pirate.');
            expect(ttsState.setTtsState).not.toHaveBeenCalled();
        });

        it('stores the cleaned text, not what was typed', async () => {
            await style.execute(context(['<whispering>', '', '{softly}']));

            expect(ttsState.setGlobalUserPreference).toHaveBeenCalledWith('777', 'style', 'whispering softly', 'someviewer');
            expect(reply()).toBe('Your TTS style is now: whispering softly.');
        });

        it.each(['off', 'reset', 'none', 'clear', 'OFF'])('removes the style for "%s"', async word => {
            await style.execute(context([word]));

            expect(ttsState.clearGlobalUserPreference).toHaveBeenCalledWith('777', 'style');
            expect(ttsState.setGlobalUserPreference).not.toHaveBeenCalled();
            expect(reply()).toBe('Your TTS style was removed. The bot uses the channel default.');
        });

        it('treats a clear word inside a longer style as text', async () => {
            await style.execute(context(['off', 'key']));

            expect(ttsState.clearGlobalUserPreference).not.toHaveBeenCalled();
            expect(ttsState.setGlobalUserPreference).toHaveBeenCalledWith('777', 'style', 'off key', 'someviewer');
        });

        it('refuses a style over the maximum length', async () => {
            await style.execute(context(['x'.repeat(STYLE_MAX_LENGTH + 1)]));

            expect(ttsState.setGlobalUserPreference).not.toHaveBeenCalled();
            expect(reply()).toBe(`That style is too long. Use ${STYLE_MAX_LENGTH} characters or fewer.`);
        });

        it('accepts a style of exactly the maximum length', async () => {
            const text = 'x'.repeat(STYLE_MAX_LENGTH);

            await style.execute(context([text]));

            expect(ttsState.setGlobalUserPreference).toHaveBeenCalledWith('777', 'style', text, 'someviewer');
        });

        it('writes nothing for text with nothing usable in it', async () => {
            await style.execute(context(['<>', '{}']));

            expect(ttsState.setGlobalUserPreference).not.toHaveBeenCalled();
            expect(reply()).toMatch(/You did not set a TTS style/);
        });

        it('refuses a style that holds a banned word of the channel', async () => {
            ttsState.getTtsState.mockResolvedValue({ bannedWords: ['Pirate'] });

            await style.execute(context(['like', 'a', 'pirate']));

            expect(ttsState.getTtsState).toHaveBeenCalledWith('testchannel');
            expect(ttsState.setGlobalUserPreference).not.toHaveBeenCalled();
            expect(reply()).toBe('The bot cannot use that style, because it contains a banned word.');
        });

        it('reports a failed write', async () => {
            ttsState.setGlobalUserPreference.mockResolvedValue(false);

            await style.execute(context(['whispering']));

            expect(reply()).toBe('The bot did not save your TTS style. Try again in a moment.');
        });

        it('reports a failed removal', async () => {
            ttsState.clearGlobalUserPreference.mockResolvedValue(false);

            await style.execute(context(['off']));

            expect(reply()).toBe('The bot did not save your TTS style. Try again in a moment.');
        });

        it('logs the style it set', async () => {
            await style.execute(context(['whispering']));

            expect(logger.info).toHaveBeenCalledWith(
                { channel: 'testchannel', user: 'someviewer', command: 'style', style: 'whispering' },
                expect.any(String)
            );
        });
    });

    describe('!tts defaultstyle', () => {
        it('is for moderators', () => {
            expect(defaultStyle.name).toBe('defaultstyle');
            expect(defaultStyle.permission).toBe('moderator');
            expect(defaultStyle.usage).toBe('!tts defaultstyle <text|off>');
        });

        it('shows the channel style with no arguments', async () => {
            ttsState.getTtsState.mockResolvedValue({ style: 'bored and slow' });

            await defaultStyle.execute(context([]));

            expect(ttsState.getTtsState).toHaveBeenCalledWith('testchannel');
            expect(reply()).toBe('Current default TTS style: bored and slow. Usage: !tts defaultstyle <text|off>');
        });

        it('says so when the channel has no style', async () => {
            await defaultStyle.execute(context([]));

            expect(reply()).toBe('This channel has no default TTS style. Usage: !tts defaultstyle <text|off>');
        });

        it('stores the style on the channel, not on the moderator', async () => {
            await defaultStyle.execute(context(['bored', 'and', 'slow']));

            expect(ttsState.setTtsState).toHaveBeenCalledWith('testchannel', 'style', 'bored and slow');
            expect(ttsState.setGlobalUserPreference).not.toHaveBeenCalled();
            expect(reply()).toBe('The default TTS style of the channel is now: bored and slow.');
        });

        it('removes the style by writing an empty one', async () => {
            await defaultStyle.execute(context(['off']));

            expect(ttsState.setTtsState).toHaveBeenCalledWith('testchannel', 'style', '');
            expect(reply()).toBe('The default TTS style of the channel was removed.');
        });

        it('refuses a style that holds a banned word', async () => {
            ttsState.getTtsState.mockResolvedValue({ bannedWords: ['slow'] });

            await defaultStyle.execute(context(['bored', 'and', 'SLOW']));

            expect(ttsState.setTtsState).not.toHaveBeenCalled();
            expect(reply()).toBe('The bot cannot use that style, because it contains a banned word.');
        });

        it('refuses a style over the maximum length', async () => {
            await defaultStyle.execute(context(['x'.repeat(STYLE_MAX_LENGTH), 'y']));

            expect(ttsState.setTtsState).not.toHaveBeenCalled();
            expect(reply()).toMatch(/too long/);
        });

        it('reports a failed write', async () => {
            ttsState.setTtsState.mockResolvedValue(false);

            await defaultStyle.execute(context(['whispering']));

            expect(reply()).toBe('The bot did not save the default TTS style. Try again in a moment.');
        });
    });
});
