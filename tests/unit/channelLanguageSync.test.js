// tests/unit/channelLanguageSync.test.js
// This is the only thing in the bot that changes a channel's settings without
// anyone asking it to, so most of these cases are about what it must NOT do.

import { jest } from '@jest/globals';

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../../src/lib/logger.js', () => ({ default: mockLogger }));

const mockAllowList = { getActiveChannels: jest.fn() };
jest.unstable_mockModule('../../src/lib/allowList.js', () => mockAllowList);

const mockHelix = { getChannelInformation: jest.fn() };
jest.unstable_mockModule('../../src/components/twitch/helixClient.js', () => mockHelix);

const mockTtsState = { getStoredLanguageBoost: jest.fn(), setChannelDefaultLanguage: jest.fn() };
jest.unstable_mockModule('../../src/components/tts/ttsState.js', () => mockTtsState);

const { syncChannelLanguages, startChannelLanguageSync, stopChannelLanguageSync } =
    await import('../../src/lib/channelLanguageSync.js');

const channel = (id, name) => ({ broadcasterId: id, channelName: name });
const helixRow = (id, lang) => ({ broadcaster_id: id, broadcaster_language: lang });

beforeEach(() => {
    jest.clearAllMocks();
    mockTtsState.setChannelDefaultLanguage.mockResolvedValue(true);
});

afterEach(() => stopChannelLanguageSync());

describe('writing a detected language', () => {
    test('sets the language when the channel is still on auto', async () => {
        mockAllowList.getActiveChannels.mockReturnValue([channel('1', 'streamer')]);
        mockHelix.getChannelInformation.mockResolvedValue([helixRow('1', 'es')]);
        mockTtsState.getStoredLanguageBoost.mockResolvedValue('auto');

        await expect(syncChannelLanguages()).resolves.toEqual({ checked: 1, updated: 1, skipped: 0 });
        expect(mockTtsState.setChannelDefaultLanguage).toHaveBeenCalledWith('streamer', 'Spanish');
    });

    test('sets the language when the channel has none at all', async () => {
        mockAllowList.getActiveChannels.mockReturnValue([channel('1', 'streamer')]);
        mockHelix.getChannelInformation.mockResolvedValue([helixRow('1', 'de')]);
        mockTtsState.getStoredLanguageBoost.mockResolvedValue(null);

        await syncChannelLanguages();
        expect(mockTtsState.setChannelDefaultLanguage).toHaveBeenCalledWith('streamer', 'German');
    });

    test('maps Cantonese, whose Twitch code and TTS value share no spelling', async () => {
        mockAllowList.getActiveChannels.mockReturnValue([channel('1', 'streamer')]);
        mockHelix.getChannelInformation.mockResolvedValue([helixRow('1', 'zh-hk')]);
        mockTtsState.getStoredLanguageBoost.mockResolvedValue('auto');

        await syncChannelLanguages();
        expect(mockTtsState.setChannelDefaultLanguage).toHaveBeenCalledWith('streamer', 'Chinese,Yue');
    });

    test('logs every write at info, because a silent one is untraceable in production', async () => {
        mockAllowList.getActiveChannels.mockReturnValue([channel('1', 'streamer')]);
        mockHelix.getChannelInformation.mockResolvedValue([helixRow('1', 'ja')]);
        mockTtsState.getStoredLanguageBoost.mockResolvedValue('auto');

        await syncChannelLanguages();
        expect(mockLogger.info).toHaveBeenCalledWith(
            expect.objectContaining({ channel: 'streamer', languageBoost: 'Japanese' }),
            expect.stringContaining('set TTS language'),
        );
    });
});

describe('never overwriting a deliberate choice', () => {
    test.each(['Spanish', 'English', 'Chinese,Yue'])('leaves an explicit %s alone', async (existing) => {
        mockAllowList.getActiveChannels.mockReturnValue([channel('1', 'streamer')]);
        mockHelix.getChannelInformation.mockResolvedValue([helixRow('1', 'fr')]);
        mockTtsState.getStoredLanguageBoost.mockResolvedValue(existing);

        await expect(syncChannelLanguages()).resolves.toEqual({ checked: 1, updated: 0, skipped: 1 });
        expect(mockTtsState.setChannelDefaultLanguage).not.toHaveBeenCalled();
    });

    test.each(['auto', 'Automatic', 'None'])('treats the legacy value %s as no choice', async (value) => {
        mockAllowList.getActiveChannels.mockReturnValue([channel('1', 'streamer')]);
        mockHelix.getChannelInformation.mockResolvedValue([helixRow('1', 'it')]);
        mockTtsState.getStoredLanguageBoost.mockResolvedValue(value);

        await syncChannelLanguages();
        expect(mockTtsState.setChannelDefaultLanguage).toHaveBeenCalledWith('streamer', 'Italian');
    });
});

describe('Twitch languages with no TTS equivalent', () => {
    test.each(['other', 'asl', '', null, 'xx'])('leaves the channel on auto for %s', async (lang) => {
        mockAllowList.getActiveChannels.mockReturnValue([channel('1', 'streamer')]);
        mockHelix.getChannelInformation.mockResolvedValue([helixRow('1', lang)]);
        mockTtsState.getStoredLanguageBoost.mockResolvedValue('auto');

        await syncChannelLanguages();
        expect(mockTtsState.setChannelDefaultLanguage).not.toHaveBeenCalled();
    });
});

describe('robustness', () => {
    test('batches in hundreds, because Helix rejects more than 100 ids', async () => {
        const many = Array.from({ length: 250 }, (_, i) => channel(String(i), `c${i}`));
        mockAllowList.getActiveChannels.mockReturnValue(many);
        mockHelix.getChannelInformation.mockResolvedValue([]);

        await syncChannelLanguages();
        expect(mockHelix.getChannelInformation).toHaveBeenCalledTimes(3);
        expect(mockHelix.getChannelInformation.mock.calls[0][0]).toHaveLength(100);
        expect(mockHelix.getChannelInformation.mock.calls[2][0]).toHaveLength(50);
    });

    test('a failing Helix batch does not abort the remaining batches', async () => {
        const many = Array.from({ length: 150 }, (_, i) => channel(String(i), `c${i}`));
        mockAllowList.getActiveChannels.mockReturnValue(many);
        mockHelix.getChannelInformation
            .mockRejectedValueOnce(new Error('helix down'))
            .mockResolvedValueOnce([helixRow('100', 'pt')]);
        mockTtsState.getStoredLanguageBoost.mockResolvedValue('auto');

        await expect(syncChannelLanguages()).resolves.toEqual({ checked: 1, updated: 1, skipped: 0 });
        expect(mockTtsState.setChannelDefaultLanguage).toHaveBeenCalledWith('c100', 'Portuguese');
    });

    test('ignores a Helix row for a channel it did not ask about', async () => {
        mockAllowList.getActiveChannels.mockReturnValue([channel('1', 'streamer')]);
        mockHelix.getChannelInformation.mockResolvedValue([helixRow('999', 'es')]);
        mockTtsState.getStoredLanguageBoost.mockResolvedValue('auto');

        await expect(syncChannelLanguages()).resolves.toEqual({ checked: 0, updated: 0, skipped: 0 });
        expect(mockTtsState.setChannelDefaultLanguage).not.toHaveBeenCalled();
    });

    test('a config read failure skips that channel without failing the pass', async () => {
        mockAllowList.getActiveChannels.mockReturnValue([channel('1', 'a'), channel('2', 'b')]);
        mockHelix.getChannelInformation.mockResolvedValue([helixRow('1', 'es'), helixRow('2', 'es')]);
        mockTtsState.getStoredLanguageBoost
            .mockRejectedValueOnce(new Error('firestore down'))
            .mockResolvedValueOnce('auto');

        await syncChannelLanguages();
        expect(mockTtsState.setChannelDefaultLanguage).toHaveBeenCalledTimes(1);
        expect(mockTtsState.setChannelDefaultLanguage).toHaveBeenCalledWith('b', 'Spanish');
    });

    test('a read that cannot confirm the stored value never triggers a write', async () => {
        // The original bug: this went through getTtsState, which swallows a
        // Firestore error and returns defaults with languageBoost 'auto'. A
        // channel that had explicitly chosen Spanish then looked unset, and a
        // transient outage would overwrite it permanently.
        mockAllowList.getActiveChannels.mockReturnValue([channel('1', 'streamer')]);
        mockHelix.getChannelInformation.mockResolvedValue([helixRow('1', 'fr')]);
        mockTtsState.getStoredLanguageBoost.mockRejectedValue(new Error('firestore down'));

        await syncChannelLanguages();
        expect(mockTtsState.setChannelDefaultLanguage).not.toHaveBeenCalled();
    });

    test('calls Helix at all only when there is something to ask about', async () => {
        mockAllowList.getActiveChannels.mockReturnValue([]);
        await expect(syncChannelLanguages()).resolves.toEqual({ checked: 0, updated: 0, skipped: 0 });
        expect(mockHelix.getChannelInformation).not.toHaveBeenCalled();
    });
});

describe('scheduling', () => {
    test('starting twice does not create a second timer', async () => {
        mockAllowList.getActiveChannels.mockReturnValue([]);
        startChannelLanguageSync();
        startChannelLanguageSync();
        expect(mockLogger.info).toHaveBeenCalledWith(expect.anything(), 'Channel language sync started');
        expect(mockLogger.info.mock.calls.filter(c => c[1] === 'Channel language sync started')).toHaveLength(1);
    });

    test('stopping when never started is harmless', () => {
        expect(() => stopChannelLanguageSync()).not.toThrow();
    });
});
