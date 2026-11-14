// tests/unit/defaultVoiceCommand.test.js
// !tts defaultvoice <voice_id|reset>: the channel's voice. Changing it also clears
// voiceStyle and voiceLanguage, the manner and the language that came with a mapped
// MiniMax voice.

import { jest } from '@jest/globals';
import { getTranslator } from '../../src/i18n/index.js';

describe('!tts defaultvoice', () => {
    let enqueueMessage;
    let getTtsState;
    let setTtsStateFields;
    let getAvailableVoices;
    let defaultVoice;

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
        getTtsState = jest.fn().mockResolvedValue({});
        setTtsStateFields = jest.fn().mockResolvedValue(true);
        // The shape ttsService returns: catalog objects, matched on `id`.
        getAvailableVoices = jest.fn().mockResolvedValue([
            { id: 'puck', name: 'Puck' },
            { id: 'kore', name: 'Kore' },
            { id: 'en-gb-storyteller-3', name: 'Kore' },
        ]);

        jest.unstable_mockModule('../../src/lib/logger.js', () => ({
            default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        }));
        jest.unstable_mockModule('../../src/lib/chatSender.js', () => ({ enqueueMessage }));
        jest.unstable_mockModule('../../src/components/tts/ttsState.js', () => ({ getTtsState, setTtsStateFields }));
        jest.unstable_mockModule('../../src/components/tts/ttsService.js', () => ({ getAvailableVoices }));
        jest.unstable_mockModule('../../src/components/tts/voiceResolver.js', () => ({ getDefaultVoiceId: () => 'puck' }));

        ({ default: defaultVoice } = await import('../../src/components/commands/tts/defaultVoice.js'));
    });

    it('is for moderators', () => {
        expect(defaultVoice.permission).toBe('moderator');
    });

    it('shows the voice of the channel', async () => {
        getTtsState.mockResolvedValue({ voiceId: 'kore' });

        await defaultVoice.execute(context([]));

        expect(reply()).toMatch(/default TTS voice for this channel is: kore\./);
        expect(setTtsStateFields).not.toHaveBeenCalled();
    });

    it('shows the system default when the channel stores no voice', async () => {
        await defaultVoice.execute(context([]));

        expect(reply()).toMatch(/default TTS voice for this channel is: puck\./);
    });

    it('stores the catalog ID for a voice typed in any letter case, and clears voiceStyle and voiceLanguage', async () => {
        await defaultVoice.execute(context(['EN-GB-Storyteller-3']));

        // One request, so that a failure cannot leave the new voice with the old manner.
        expect(setTtsStateFields.mock.calls).toEqual([
            ['testchannel', { voiceId: 'en-gb-storyteller-3', voiceStyle: '', voiceLanguage: '' }],
        ]);
        expect(reply()).toBe("The channel's default TTS voice has been set to: en-gb-storyteller-3.");
    });

    it('does not match a display name, which repeats across languages', async () => {
        await defaultVoice.execute(context(['Kore2']));
        expect(setTtsStateFields).not.toHaveBeenCalled();
        expect(reply()).toMatch(/^Invalid voice ID 'Kore2'\./);
    });

    it('refuses a MiniMax voice ID, which is not in the catalog', async () => {
        await defaultVoice.execute(context(['Friendly_Person']));

        expect(setTtsStateFields).not.toHaveBeenCalled();
        expect(reply()).toMatch(/^Invalid voice ID 'Friendly_Person'\./);
    });

    it.each(['reset', 'systemdefault', 'RESET'])('"%s" stores the system default and clears voiceStyle and voiceLanguage', async word => {
        await defaultVoice.execute(context([word]));

        expect(setTtsStateFields.mock.calls).toEqual([
            ['testchannel', { voiceId: 'puck', voiceStyle: '', voiceLanguage: '' }],
        ]);
        expect(reply()).toBe("The channel's default TTS voice has been reset to the system default: puck.");
        expect(getAvailableVoices).not.toHaveBeenCalled();
    });

    it('reports a failure when the voice was not saved', async () => {
        setTtsStateFields.mockResolvedValue(false);

        await defaultVoice.execute(context(['kore']));

        expect(setTtsStateFields).toHaveBeenCalledTimes(1);
        expect(reply()).toBe("Could not set the channel's default TTS voice to kore at this time.");
    });

    it('reports a failed reset without touching voiceStyle or voiceLanguage', async () => {
        setTtsStateFields.mockResolvedValue(false);

        await defaultVoice.execute(context(['reset']));

        expect(setTtsStateFields).toHaveBeenCalledTimes(1);
        expect(reply()).toBe("Could not reset the channel's default TTS voice at this time.");
    });

    it('says so when the voice list is empty', async () => {
        getAvailableVoices.mockResolvedValue([]);

        await defaultVoice.execute(context(['kore']));

        expect(setTtsStateFields).not.toHaveBeenCalled();
        expect(reply()).toMatch(/Could not retrieve the list of available voices/);
    });
});
