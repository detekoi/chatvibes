// tests/unit/pronounceCommand.test.js
// Unit tests for !tts pronounce and !tts profanity.

import { jest } from '@jest/globals';

describe('TTS pronunciation commands', () => {
    let enqueueMessage;
    let ttsStateMock;
    let pronounce;
    let profanity;

    /** Last message the command sent back to chat. */
    const reply = () => enqueueMessage.mock.calls.at(-1)?.[1] ?? '';

    const context = (args, username = 'somemod') => ({
        channel: '#testchannel',
        user: { username },
        args,
        replyToId: 'msg-1',
    });

    beforeEach(async () => {
        jest.resetModules();
        enqueueMessage = jest.fn();

        ttsStateMock = {
            getTtsState: jest.fn().mockResolvedValue({
                pronunciations: {},
                languageBoost: 'English',
                profanityFilterEnabled: false,
            }),
            setPronunciation: jest.fn().mockResolvedValue(true),
            removePronunciation: jest.fn().mockResolvedValue(true),
            clearPronunciations: jest.fn().mockResolvedValue(true),
            setTtsState: jest.fn().mockResolvedValue(true),
        };

        jest.unstable_mockModule('../../src/lib/chatSender.js', () => ({ enqueueMessage }));
        jest.unstable_mockModule('../../src/components/tts/ttsState.js', () => ttsStateMock);
        jest.unstable_mockModule('../../src/lib/logger.js', () => ({
            default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        }));

        pronounce = (await import('../../src/components/commands/tts/pronounce.js')).default;
        profanity = (await import('../../src/components/commands/tts/profanity.js')).default;
    });

    describe('!tts pronounce', () => {
        it('is moderator-gated', () => {
            expect(pronounce.permission).toBe('moderator');
        });

        it('shows usage with no arguments', async () => {
            await pronounce.execute(context([]));
            expect(reply()).toMatch(/Usage/);
        });

        it('adds an entry', async () => {
            await pronounce.execute(context(['wcat', '=', 'wildcat']));
            expect(ttsStateMock.setPronunciation).toHaveBeenCalledWith('testchannel', 'wcat', 'wildcat');
            expect(reply()).toContain('wildcat');
        });

        it('normalizes the key and value', async () => {
            await pronounce.execute(context(['  WCat  ', '=', '  wild   cat  ']));
            expect(ttsStateMock.setPronunciation).toHaveBeenCalledWith('testchannel', 'wcat', 'wild cat');
        });

        it('rejects a key containing a dot', async () => {
            await pronounce.execute(context(['a.b', '=', 'ay bee']));
            expect(ttsStateMock.setPronunciation).not.toHaveBeenCalled();
            expect(reply()).toMatch(/cannot be used/);
        });

        it('rejects an empty spoken form', async () => {
            // This would let a message reduce to "", which callers drop silently.
            await pronounce.execute(context(['wcat', '=', '']));
            expect(ttsStateMock.setPronunciation).not.toHaveBeenCalled();
            expect(reply()).toMatch(/cannot be empty/);
        });

        it('rejects a link as the spoken form', async () => {
            await pronounce.execute(context(['site', '=', 'go to example.com']));
            expect(ttsStateMock.setPronunciation).not.toHaveBeenCalled();
            expect(reply()).toMatch(/link/);
        });

        it('shows usage when there is no equals sign', async () => {
            await pronounce.execute(context(['wcat', 'wildcat']));
            expect(ttsStateMock.setPronunciation).not.toHaveBeenCalled();
            expect(reply()).toMatch(/Usage/);
        });

        it('refuses a new entry once the cap is reached', async () => {
            const full = {};
            for (let i = 0; i < 100; i++) full[`word${i}`] = 'thing';
            ttsStateMock.getTtsState.mockResolvedValue({ pronunciations: full });

            await pronounce.execute(context(['brandnew', '=', 'brand new']));
            expect(ttsStateMock.setPronunciation).not.toHaveBeenCalled();
            expect(reply()).toMatch(/100 custom pronunciations/);
        });

        it('still allows updating an existing entry at the cap', async () => {
            const full = {};
            for (let i = 0; i < 100; i++) full[`word${i}`] = 'thing';
            ttsStateMock.getTtsState.mockResolvedValue({ pronunciations: full });

            await pronounce.execute(context(['word5', '=', 'updated']));
            expect(ttsStateMock.setPronunciation).toHaveBeenCalledWith('testchannel', 'word5', 'updated');
        });

        it('does not let "constructor" slip past the cap', async () => {
            // It is a legal match key and an Object.prototype member, so an `in`
            // check would report it as already present and skip the cap.
            const full = {};
            for (let i = 0; i < 100; i++) full[`word${i}`] = 'thing';
            ttsStateMock.getTtsState.mockResolvedValue({ pronunciations: full });

            await pronounce.execute(context(['constructor', '=', 'con struct or']));
            expect(ttsStateMock.setPronunciation).not.toHaveBeenCalled();
            expect(reply()).toMatch(/100 custom pronunciations/);
        });

        it('refuses to remove "constructor" when it was never set', async () => {
            await pronounce.execute(context(['remove', 'constructor']));
            expect(ttsStateMock.removePronunciation).not.toHaveBeenCalled();
            expect(reply()).toMatch(/not a custom pronunciation/);
        });

        it('adds "constructor" normally when under the cap', async () => {
            await pronounce.execute(context(['constructor', '=', 'con struct or']));
            expect(ttsStateMock.setPronunciation)
                .toHaveBeenCalledWith('testchannel', 'constructor', 'con struct or');
        });

        it('lists custom entries', async () => {
            ttsStateMock.getTtsState.mockResolvedValue({ pronunciations: { wcat: 'wildcat' } });
            await pronounce.execute(context(['list']));
            expect(reply()).toContain('wcat -> wildcat');
        });

        it('marks disabled built-ins in the list', async () => {
            ttsStateMock.getTtsState.mockResolvedValue({ pronunciations: { lfg: '' } });
            await pronounce.execute(context(['list']));
            expect(reply()).toContain('lfg (off)');
        });

        it('truncates a long list rather than exceeding the 500-char chat limit', async () => {
            const many = {};
            for (let i = 0; i < 30; i++) many[`word${i}`] = `thing ${i}`;
            ttsStateMock.getTtsState.mockResolvedValue({ pronunciations: many });

            await pronounce.execute(context(['list']));
            expect(reply()).toMatch(/and 20 more/);
        });

        it('says so when there are no custom entries', async () => {
            await pronounce.execute(context(['list']));
            expect(reply()).toMatch(/No custom pronunciations/);
        });

        it('removes an entry', async () => {
            ttsStateMock.getTtsState.mockResolvedValue({ pronunciations: { wcat: 'wildcat' } });
            await pronounce.execute(context(['remove', 'wcat']));
            expect(ttsStateMock.removePronunciation).toHaveBeenCalledWith('testchannel', 'wcat');
        });

        it('does not remove something that was never set', async () => {
            await pronounce.execute(context(['remove', 'nothing']));
            expect(ttsStateMock.removePronunciation).not.toHaveBeenCalled();
            expect(reply()).toMatch(/not a custom pronunciation/);
        });

        it('mentions the built-in coming back after a removal', async () => {
            ttsStateMock.getTtsState.mockResolvedValue({ pronunciations: { lfg: 'custom thing' } });
            await pronounce.execute(context(['remove', 'lfg']));
            expect(reply()).toMatch(/built-in is back/);
        });

        it('switches off a built-in by storing an empty value', async () => {
            await pronounce.execute(context(['off', 'lfg']));
            expect(ttsStateMock.setPronunciation).toHaveBeenCalledWith('testchannel', 'lfg', '');
        });

        it('refuses to switch off something that is not a built-in', async () => {
            await pronounce.execute(context(['off', 'notabuiltin']));
            expect(ttsStateMock.setPronunciation).not.toHaveBeenCalled();
            expect(reply()).toMatch(/not a built-in/);
        });

        it('previews an expansion without speaking it', async () => {
            await pronounce.execute(context(['test', 'lfg', 'everyone']));
            expect(reply()).toContain("let's fucking go everyone");
        });

        it('says when a preview changes nothing', async () => {
            await pronounce.execute(context(['test', 'hello there']));
            expect(reply()).toMatch(/No change/);
        });

        it('restricts clear to the broadcaster', async () => {
            await pronounce.execute(context(['clear'], 'somemod'));
            expect(ttsStateMock.clearPronunciations).not.toHaveBeenCalled();
            expect(reply()).toMatch(/Only the broadcaster/);
        });

        it('lets the broadcaster clear', async () => {
            await pronounce.execute(context(['clear'], 'testchannel'));
            expect(ttsStateMock.clearPronunciations).toHaveBeenCalledWith('testchannel');
        });

        it('reports a storage failure instead of claiming success', async () => {
            ttsStateMock.setPronunciation.mockResolvedValue(false);
            await pronounce.execute(context(['wcat', '=', 'wildcat']));
            expect(reply()).toMatch(/Could not save/);
        });

        it('does not leak an exception to chat', async () => {
            ttsStateMock.getTtsState.mockRejectedValue(new Error('firestore down'));
            await pronounce.execute(context(['list']));
            expect(reply()).toMatch(/went wrong/);
        });
    });

    describe('!tts profanity', () => {
        it('is moderator-gated', () => {
            expect(profanity.permission).toBe('moderator');
        });

        it('reports status when off', async () => {
            await profanity.execute(context(['status']));
            expect(reply()).toMatch(/OFF/);
        });

        it('defaults to status with no arguments', async () => {
            await profanity.execute(context([]));
            expect(reply()).toMatch(/Profanity filter/);
        });

        it('turns the filter on', async () => {
            await profanity.execute(context(['on']));
            expect(ttsStateMock.setTtsState).toHaveBeenCalledWith('testchannel', 'profanityFilterEnabled', true);
        });

        it('turns the filter off', async () => {
            ttsStateMock.getTtsState.mockResolvedValue({ languageBoost: 'English', profanityFilterEnabled: true });
            await profanity.execute(context(['off']));
            expect(ttsStateMock.setTtsState).toHaveBeenCalledWith('testchannel', 'profanityFilterEnabled', false);
        });

        // "on" reads as if it turns profanity on. These verbs say what happens.
        it.each(['block', 'filter', 'censor', 'clean', 'enable'])('%s turns the filter on', async (verb) => {
            await profanity.execute(context([verb]));
            expect(ttsStateMock.setTtsState).toHaveBeenCalledWith('testchannel', 'profanityFilterEnabled', true);
        });

        it.each(['allow', 'unfilter', 'raw', 'disable'])('%s turns the filter off', async (verb) => {
            ttsStateMock.getTtsState.mockResolvedValue({ languageBoost: 'English', profanityFilterEnabled: true });
            await profanity.execute(context([verb]));
            expect(ttsStateMock.setTtsState).toHaveBeenCalledWith('testchannel', 'profanityFilterEnabled', false);
        });

        it('accepts a verb in any case', async () => {
            await profanity.execute(context(['BLOCK']));
            expect(ttsStateMock.setTtsState).toHaveBeenCalledWith('testchannel', 'profanityFilterEnabled', true);
        });

        it('states the effect, not just the state, when switching on', async () => {
            await profanity.execute(context(['block']));
            expect(reply()).toMatch(/softened before they are spoken/);
        });

        it('states the effect, not just the state, when switching off', async () => {
            ttsStateMock.getTtsState.mockResolvedValue({ languageBoost: 'English', profanityFilterEnabled: true });
            await profanity.execute(context(['allow']));
            expect(reply()).toMatch(/read as written/);
        });

        it('does not rewrite the setting when it is already correct', async () => {
            ttsStateMock.getTtsState.mockResolvedValue({ languageBoost: 'English', profanityFilterEnabled: true });
            await profanity.execute(context(['on']));
            expect(ttsStateMock.setTtsState).not.toHaveBeenCalled();
            expect(reply()).toMatch(/already on/);
        });

        it('warns that auto means the English list', async () => {
            // Otherwise a non-English channel reads this as the feature being broken.
            ttsStateMock.getTtsState.mockResolvedValue({ languageBoost: 'auto', profanityFilterEnabled: false });
            await profanity.execute(context(['status']));
            expect(reply()).toMatch(/auto/);
        });

        it('names the language in use', async () => {
            ttsStateMock.getTtsState.mockResolvedValue({ languageBoost: 'Spanish', profanityFilterEnabled: true });
            await profanity.execute(context(['status']));
            expect(reply()).toMatch(/Spanish/);
        });

        it('flags limited coverage', async () => {
            ttsStateMock.getTtsState.mockResolvedValue({ languageBoost: 'Tamil', profanityFilterEnabled: true });
            await profanity.execute(context(['status']));
            expect(reply()).toMatch(/limited coverage/);
        });

        it('shows usage for an unknown sub-action', async () => {
            await profanity.execute(context(['maybe']));
            expect(reply()).toMatch(/Usage/);
        });
    });
});
