// tests/unit/tagsCommand.test.js
// !tts tags <off|on> <tag|all>: the chat switch for disabledSoundTags.

import { jest } from '@jest/globals';
import { getTranslator } from '../../src/i18n/index.js';
import { SOUND_TAG_NAMES } from '../../src/lib/textRewrite/soundTags.js';

describe('!tts tags', () => {
    let enqueueMessage;
    let getTtsState;
    let setTtsState;
    let tags;

    const reply = () => enqueueMessage.mock.calls.at(-1)?.[1] ?? '';
    const USAGE = '!tts tags <off|on> <tag|all>';

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

        ({ default: tags } = await import('../../src/components/commands/tts/tags.js'));
    });

    it('is for moderators', () => {
        expect(tags.name).toBe('tags');
        expect(tags.permission).toBe('moderator');
        expect(tags.usage).toBe(USAGE);
    });

    it('reports that every tag is on when the setting was never written', async () => {
        await tags.execute(context([]));

        expect(getTtsState).toHaveBeenCalledWith('testchannel');
        expect(reply()).toBe(`All sound tags are on. Usage: ${USAGE}`);
        expect(enqueueMessage).toHaveBeenCalledWith('#TestChannel', expect.any(String), { replyToId: 'msg-1' });
        expect(setTtsState).not.toHaveBeenCalled();
    });

    it('lists the tags that are off', async () => {
        getTtsState.mockResolvedValue({ disabledSoundTags: ['moan', 'scream'] });

        await tags.execute(context(['list']));

        expect(reply()).toBe(`Sound tags that are off: moan, scream. Usage: ${USAGE}`);
    });

    it('leaves unknown stored names out of the list', async () => {
        getTtsState.mockResolvedValue({ disabledSoundTags: ['moan', 'not-a-tag'] });

        await tags.execute(context([]));

        expect(reply()).toBe(`Sound tags that are off: moan. Usage: ${USAGE}`);
    });

    it.each([
        [['off']],
        [['on']],
        [['maybe', 'laugh']],
        [['laugh']],
    ])('shows the list and writes nothing for %j', async args => {
        await tags.execute(context(args));

        expect(setTtsState).not.toHaveBeenCalled();
        expect(reply()).toMatch(/^All sound tags are on\./);
    });

    it('turns one tag off', async () => {
        await tags.execute(context(['off', 'laugh']));

        expect(setTtsState).toHaveBeenCalledWith('testchannel', 'disabledSoundTags', ['laugh']);
        expect(reply()).toBe('The sound tag laugh is now off. The bot removes it from messages.');
    });

    it('takes the tag as a person types it and stores the canonical name', async () => {
        await tags.execute(context(['OFF', '<Laughs>']));
        expect(setTtsState).toHaveBeenLastCalledWith('testchannel', 'disabledSoundTags', ['laugh']);

        await tags.execute(context(['off', 'heavy', 'breathing']));
        expect(setTtsState).toHaveBeenLastCalledWith('testchannel', 'disabledSoundTags', ['heavy breath']);
        expect(reply()).toMatch(/sound tag heavy breath is now off/);
    });

    it.each([
        [['short-pause'], 'short pause'],
        [['long', 'pause'], 'long pause'],
        [['heavy_breath'], 'heavy breath'],
        [['throat', 'clearing'], 'throat-clearing'],
    ])('takes a two-word tag typed as %j', async (words, tag) => {
        await tags.execute(context(['off', ...words]));

        expect(setTtsState).toHaveBeenCalledWith('testchannel', 'disabledSoundTags', [tag]);
    });

    it('adds to the tags already off, in the order of the tag list', async () => {
        getTtsState.mockResolvedValue({ disabledSoundTags: ['scream', 'moan'] });

        await tags.execute(context(['off', 'laugh']));

        const stored = setTtsState.mock.calls[0][2];
        expect([...stored].sort()).toEqual(['laugh', 'moan', 'scream']);
        expect(stored).toEqual(SOUND_TAG_NAMES.filter(name => stored.includes(name)));
    });

    it('turns one tag back on and keeps the others off', async () => {
        getTtsState.mockResolvedValue({ disabledSoundTags: ['moan', 'scream'] });

        await tags.execute(context(['on', 'screams']));

        expect(setTtsState).toHaveBeenCalledWith('testchannel', 'disabledSoundTags', ['moan']);
        expect(reply()).toBe('The sound tag scream is now on.');
    });

    it('drops unknown stored names on the next write', async () => {
        getTtsState.mockResolvedValue({ disabledSoundTags: ['not-a-tag', 'moan'] });

        await tags.execute(context(['off', 'laugh']));

        expect(setTtsState.mock.calls[0][2]).not.toContain('not-a-tag');
    });

    it('turns every tag off', async () => {
        await tags.execute(context(['off', 'ALL']));

        expect(setTtsState).toHaveBeenCalledWith('testchannel', 'disabledSoundTags', SOUND_TAG_NAMES);
        expect(reply()).toBe('All sound tags are now off.');
    });

    it('turns every tag on', async () => {
        getTtsState.mockResolvedValue({ disabledSoundTags: ['moan', 'scream'] });

        await tags.execute(context(['on', 'all']));

        expect(setTtsState).toHaveBeenCalledWith('testchannel', 'disabledSoundTags', []);
        expect(reply()).toBe('All sound tags are now on.');
    });

    it('names the known tags for one it does not know, without writing', async () => {
        await tags.execute(context(['off', 'kazoo']));

        expect(setTtsState).not.toHaveBeenCalled();
        expect(reply()).toBe(`The bot does not know the sound tag kazoo. Known tags: ${SOUND_TAG_NAMES.join(', ')}.`);
    });

    it('reports a failed write', async () => {
        setTtsState.mockResolvedValue(false);

        await tags.execute(context(['off', 'laugh']));

        expect(reply()).toBe('The bot did not save that setting. Try again in a moment.');
    });

    it('treats a stored value that is not a list as nothing off', async () => {
        getTtsState.mockResolvedValue({ disabledSoundTags: 'laugh' });

        await tags.execute(context([]));

        expect(reply()).toMatch(/^All sound tags are on\./);
    });
});
