// tests/unit/redemptionAnnouncement.test.js
// Tests for Channel Points redemption announcement handler

import { jest } from '@jest/globals';

// Mock dependencies before imports
const mockDispatchTtsEvent = jest.fn().mockResolvedValue(undefined);
const mockGetSharedSessionInfo = jest.fn().mockResolvedValue(null);
const mockLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
};

// Handlers now route through ttsDispatch, which decides between enqueueing locally
// and publishing to Pub/Sub. Mocking at that boundary keeps these tests where they
// were — asserting what the handler emits — without dragging in the web server graph.
jest.unstable_mockModule('../../src/lib/ttsDispatch.js', () => ({
    dispatchTtsEvent: mockDispatchTtsEvent
}));

jest.unstable_mockModule('../../src/components/twitch/eventUtils.js', () => ({
    getSharedSessionInfo: mockGetSharedSessionInfo
}));

jest.unstable_mockModule('../../src/lib/logger.js', () => ({
    default: mockLogger
}));

// Mock modules used by handleChannelPointsRedemption that we don't need for announcement tests
const mockAddRedemption = jest.fn();
const mockGetRedemption = jest.fn().mockReturnValue(null);
const mockRemoveRedemption = jest.fn();
jest.unstable_mockModule('../../src/components/twitch/redemptionCache.js', () => ({
    addRedemption: mockAddRedemption,
    getRedemption: mockGetRedemption,
    removeRedemption: mockRemoveRedemption
}));

jest.unstable_mockModule('../../src/lib/allowList.js', () => ({
    isChannelAllowed: jest.fn().mockReturnValue(true),
    isChannelActive: jest.fn().mockReturnValue(true)
}));

const mockGetTtsState = jest.fn().mockResolvedValue({});
jest.unstable_mockModule('../../src/components/tts/ttsState.js', () => ({
    getTtsState: mockGetTtsState,
    getUserEmoteModePreference: jest.fn().mockResolvedValue(null)
}));

jest.unstable_mockModule('../../src/lib/urlProcessor.js', () => ({
    processMessageUrls: jest.fn((text) => text),
    // The rewrite engine imports this to mask URL spans before matching.
    URL_REGEX: /(https?:\/\/\S+|\b\w+\.[a-z]{2,}\b)/gi,
}));

// Mock formatTtsText — pass through by default, can be overridden per test
const mockFormatTtsText = jest.fn(async (text) => text);
jest.unstable_mockModule('../../src/lib/formatTtsText.js', () => ({
    formatTtsText: mockFormatTtsText
}));

// Mock redemptionFragmentCache
const mockConsumeFragments = jest.fn().mockReturnValue(null);
jest.unstable_mockModule('../../src/components/twitch/redemptionFragmentCache.js', () => ({
    consumeFragments: mockConsumeFragments,
    storeFragments: jest.fn()
}));

const { handleRedemptionAnnouncement, handleChannelPointsRedemption } = await import('../../src/components/twitch/handlers/redemptionHandler.js');

describe('handleChannelPointsRedemption fragment cache', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockConsumeFragments.mockReturnValue(null);
        mockGetTtsState.mockResolvedValue({
            engineEnabled: true,
            channelPoints: { enabled: true, rewardId: 'tts-reward' }
        });
    });

    it('should look up stashed fragments with the documented argument order', async () => {
        await handleChannelPointsRedemption(
            'channel.channel_points_custom_reward_redemption.add',
            {
                id: 'redemption-9',
                broadcaster_user_id: '111',
                broadcaster_user_login: 'testchannel',
                user_login: 'testuser',
                user_id: '4242',
                reward: { id: 'tts-reward' },
                user_input: 'hello',
                status: 'unfulfilled'
            }
        );

        // storeFragments keys on (rewardId, userId, channelLogin) — a transposed
        // lookup here silently missed the cache on every manual-approval redemption.
        expect(mockConsumeFragments).toHaveBeenCalledWith('tts-reward', '4242', 'testchannel');
    });
});

describe('handleRedemptionAnnouncement', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockConsumeFragments.mockReturnValue(null);
        mockGetRedemption.mockReturnValue(null);
    });

    // No announceUnfulfilledRedemptions field, which is what a config written
    // before the setting existed looks like — it reads as on.
    const defaultTtsConfig = {
        engineEnabled: true,
        speakRedemptionEvents: true
    };

    // The opted-out channel: announcement waits for the streamer to accept.
    const deferredTtsConfig = { ...defaultTtsConfig, announceUnfulfilledRedemptions: false };

    it('should announce reward with user input text after formatting', async () => {
        mockFormatTtsText.mockResolvedValueOnce('drink some water!');
        const event = {
            user_name: 'TestUser',
            user_login: 'testuser',
            reward: { id: 'reward-123', title: 'Hydrate' },
            user_input: 'drink some water!',
            status: 'fulfilled'
        };

        await handleRedemptionAnnouncement(
            'channel.channel_points_custom_reward_redemption.add',
            event,
            'testchannel',
            defaultTtsConfig
        );

        expect(mockFormatTtsText).toHaveBeenCalledWith(
            'drink some water!',
            null,
            expect.objectContaining({ emoteMode: 'describe', readFullUrls: false })
        );
        expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
            'testchannel',
            expect.objectContaining({
                text: 'TestUser redeemed Hydrate: drink some water!',
                user: 'TestUser',
            }),
            null
        );
    });

    it('should announce reward without user input', async () => {
        const event = {
            user_name: 'TestUser',
            user_login: 'testuser',
            reward: { id: 'reward-456', title: 'Do 10 Pushups' },
            user_input: '',
            status: 'fulfilled'
        };

        await handleRedemptionAnnouncement(
            'channel.channel_points_custom_reward_redemption.add',
            event,
            'testchannel',
            defaultTtsConfig
        );

        expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
            'testchannel',
            {
                text: 'TestUser redeemed Do 10 Pushups',
                user: 'TestUser',
                type: 'event'
            },
            null
        );
    });

    it('should skip configured TTS reward to avoid double-announcing', async () => {
        const ttsConfig = {
            ...defaultTtsConfig,
            channelPoints: { rewardId: 'tts-reward-id' }
        };

        const event = {
            user_name: 'TestUser',
            reward: { id: 'tts-reward-id', title: 'TTS Message' },
            user_input: 'hello world',
            status: 'fulfilled'
        };

        await handleRedemptionAnnouncement(
            'channel.channel_points_custom_reward_redemption.add',
            event,
            'testchannel',
            ttsConfig
        );

        expect(mockDispatchTtsEvent).not.toHaveBeenCalled();
        expect(mockLogger.debug).toHaveBeenCalledWith(
            expect.objectContaining({ channelLogin: 'testchannel', rewardId: 'tts-reward-id' }),
            'Skipping redemption announcement for configured TTS reward'
        );
    });

    it('should skip configured TTS reward using legacy channelPointRewardId', async () => {
        const ttsConfig = {
            ...defaultTtsConfig,
            channelPointRewardId: 'legacy-tts-reward-id'
        };

        const event = {
            user_name: 'TestUser',
            reward: { id: 'legacy-tts-reward-id', title: 'TTS Message' },
            user_input: 'hello world',
            status: 'fulfilled'
        };

        await handleRedemptionAnnouncement(
            'channel.channel_points_custom_reward_redemption.add',
            event,
            'testchannel',
            ttsConfig
        );

        expect(mockDispatchTtsEvent).not.toHaveBeenCalled();
    });

    it('should announce a queued redemption on approval when opted out', async () => {
        mockFormatTtsText.mockResolvedValueOnce('play despacito');
        const event = {
            id: 'redemption-1',
            user_name: 'TestUser',
            user_login: 'testuser',
            reward: { id: 'reward-123', title: 'Song Request' },
            user_input: 'play despacito',
            status: 'fulfilled'
        };

        await handleRedemptionAnnouncement(
            'channel.channel_points_custom_reward_redemption.update',
            event,
            'testchannel',
            deferredTtsConfig
        );

        expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
            'testchannel',
            expect.objectContaining({ text: 'TestUser redeemed Song Request: play despacito' }),
            null
        );
    });

    it('should not announce the same redemption twice', async () => {
        const event = {
            id: 'redemption-dup',
            user_name: 'TestUser',
            user_login: 'testuser',
            reward: { id: 'reward-123', title: 'Hydrate' },
            user_input: '',
            status: 'fulfilled'
        };

        // Guards against Twitch emitting .update alongside .add for skip-queue rewards
        await handleRedemptionAnnouncement(
            'channel.channel_points_custom_reward_redemption.add', event, 'testchannel', deferredTtsConfig);
        await handleRedemptionAnnouncement(
            'channel.channel_points_custom_reward_redemption.update', event, 'testchannel', deferredTtsConfig);

        expect(mockDispatchTtsEvent).toHaveBeenCalledTimes(1);
    });

    it('should not announce a redemption that was canceled instead of approved', async () => {
        const event = {
            id: 'redemption-2',
            user_name: 'TestUser',
            user_login: 'testuser',
            reward: { id: 'reward-123', title: 'Song Request' },
            user_input: 'play despacito',
            status: 'canceled'
        };

        await handleRedemptionAnnouncement(
            'channel.channel_points_custom_reward_redemption.update',
            event,
            'testchannel',
            deferredTtsConfig
        );

        expect(mockDispatchTtsEvent).not.toHaveBeenCalled();
        expect(mockRemoveRedemption).toHaveBeenCalledWith('redemption-2');
    });

    it('should stash a pending redemption instead of announcing it when opted out', async () => {
        mockConsumeFragments.mockReturnValue([{ type: 'text', text: 'play despacito' }]);
        const event = {
            id: 'redemption-3',
            user_name: 'TestUser',
            user_login: 'testuser',
            user_id: '4242',
            reward: { id: 'reward-123', title: 'Song Request' },
            user_input: 'play despacito',
            status: 'unfulfilled'
        };

        await handleRedemptionAnnouncement(
            'channel.channel_points_custom_reward_redemption.add',
            event,
            'testchannel',
            deferredTtsConfig
        );

        expect(mockDispatchTtsEvent).not.toHaveBeenCalled();
        // Fragments are stashed on the 24h cache so they survive until approval
        expect(mockAddRedemption).toHaveBeenCalledWith(
            'redemption-3', 'play despacito', 'testuser', 'testchannel', 'reward-123', '4242',
            [{ type: 'text', text: 'play despacito' }]
        );
        expect(mockConsumeFragments).toHaveBeenCalledWith('reward-123', '4242', 'testchannel');
    });

    it('should reuse stashed fragments when announcing on approval when opted out', async () => {
        const stashed = [{ type: 'emote', text: 'Kappa' }];
        mockConsumeFragments.mockReturnValue(null);
        mockGetRedemption.mockReturnValue({ fragments: stashed });
        mockFormatTtsText.mockResolvedValueOnce('(a sarcastic face emote)');

        await handleRedemptionAnnouncement(
            'channel.channel_points_custom_reward_redemption.update',
            {
                id: 'redemption-4',
                user_name: 'TestUser',
                user_login: 'testuser',
                reward: { id: 'reward-123', title: 'Song Request' },
                user_input: 'Kappa',
                status: 'fulfilled'
            },
            'testchannel',
            deferredTtsConfig
        );

        expect(mockFormatTtsText).toHaveBeenCalledWith('Kappa', stashed, expect.any(Object));
        expect(mockDispatchTtsEvent).toHaveBeenCalled();
    });

    it('should not touch the redemption cache for the configured TTS reward', async () => {
        await handleRedemptionAnnouncement(
            'channel.channel_points_custom_reward_redemption.add',
            {
                id: 'redemption-5',
                user_name: 'TestUser',
                user_login: 'testuser',
                reward: { id: 'tts-reward', title: 'TTS' },
                user_input: 'hello',
                status: 'unfulfilled'
            },
            'testchannel',
            { ...defaultTtsConfig, channelPoints: { rewardId: 'tts-reward' } }
        );

        expect(mockDispatchTtsEvent).not.toHaveBeenCalled();
        // handleChannelPointsRedemption owns this reward's cache entries — clobbering
        // them here would destroy the fragments it just stashed.
        expect(mockAddRedemption).not.toHaveBeenCalled();
        expect(mockConsumeFragments).not.toHaveBeenCalled();
    });

    it('should handle missing reward title gracefully', async () => {
        const event = {
            user_name: 'TestUser',
            reward: { id: 'reward-123' },
            user_input: '',
            status: 'fulfilled'
        };

        await handleRedemptionAnnouncement(
            'channel.channel_points_custom_reward_redemption.add',
            event,
            'testchannel',
            defaultTtsConfig
        );

        expect(mockDispatchTtsEvent).not.toHaveBeenCalled();
    });

    it('should trim whitespace from user input', async () => {
        mockFormatTtsText.mockResolvedValueOnce('hello world');
        const event = {
            user_name: 'TestUser',
            user_login: 'testuser',
            reward: { id: 'reward-123', title: 'Say Something' },
            user_input: '   hello world   ',
            status: 'fulfilled'
        };

        await handleRedemptionAnnouncement(
            'channel.channel_points_custom_reward_redemption.add',
            event,
            'testchannel',
            defaultTtsConfig
        );

        expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
            'testchannel',
            expect.objectContaining({
                text: 'TestUser redeemed Say Something: hello world',
                user: 'TestUser',
            }),
            null
        );
    });

    it('should NOT announce unfulfilled redemptions when opted out (pending approval)', async () => {
        const event = {
            user_name: 'TestUser',
            user_login: 'testuser',
            reward: { id: 'reward-789', title: 'Song Request' },
            user_input: 'play despacito',
            status: 'unfulfilled'
        };

        await handleRedemptionAnnouncement(
            'channel.channel_points_custom_reward_redemption.add',
            event,
            'testchannel',
            deferredTtsConfig
        );

        expect(mockDispatchTtsEvent).not.toHaveBeenCalled();
    });

    describe('announceUnfulfilledRedemptions', () => {
        // A reward that does not skip Twitch's request queue lands as .add + unfulfilled.
        // On — the default — it is announced then rather than when the streamer accepts it.
        const eagerTtsConfig = {
            engineEnabled: true,
            speakRedemptionEvents: true,
            announceUnfulfilledRedemptions: true
        };

        it('should announce an unfulfilled redemption as soon as it lands', async () => {
            const event = {
                id: 'redemption-eager-1',
                user_name: 'TestUser',
                user_login: 'testuser',
                reward: { id: 'reward-789', title: 'Laundry Day' },
                user_input: '',
                status: 'unfulfilled'
            };

            await handleRedemptionAnnouncement(
                'channel.channel_points_custom_reward_redemption.add',
                event,
                'testchannel',
                eagerTtsConfig
            );

            expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
                'testchannel',
                expect.objectContaining({ text: 'TestUser redeemed Laundry Day' }),
                null
            );
            // Nothing is waiting on approval, so nothing needs stashing.
            expect(mockAddRedemption).not.toHaveBeenCalled();
        });

        it('should not announce again when the streamer later approves it', async () => {
            const event = {
                id: 'redemption-eager-2',
                user_name: 'TestUser',
                user_login: 'testuser',
                reward: { id: 'reward-789', title: 'Laundry Day' },
                user_input: '',
                status: 'fulfilled'
            };

            // The .add already spoke it. wasAnnounced would not catch this on a different
            // instance, so the update must be suppressed by the mode itself.
            await handleRedemptionAnnouncement(
                'channel.channel_points_custom_reward_redemption.update',
                event,
                'testchannel',
                eagerTtsConfig
            );

            expect(mockDispatchTtsEvent).not.toHaveBeenCalled();
        });

        it('should stay silent on the approval of a redemption it announced on add', async () => {
            const add = {
                id: 'redemption-eager-3',
                user_name: 'TestUser',
                user_login: 'testuser',
                reward: { id: 'reward-789', title: 'Laundry Day' },
                user_input: 'fold them too',
                status: 'unfulfilled'
            };

            await handleRedemptionAnnouncement(
                'channel.channel_points_custom_reward_redemption.add', add, 'testchannel', eagerTtsConfig
            );
            await handleRedemptionAnnouncement(
                'channel.channel_points_custom_reward_redemption.update',
                { ...add, status: 'fulfilled' },
                'testchannel',
                eagerTtsConfig
            );

            expect(mockDispatchTtsEvent).toHaveBeenCalledTimes(1);
        });

        it('should announce on add for a config that predates the setting', async () => {
            // The reported symptom came from channels whose stored config has no such
            // field, so the absent case has to land on announcing, not on deferring.
            const event = {
                id: 'redemption-legacy-1',
                user_name: 'TestUser',
                user_login: 'testuser',
                reward: { id: 'reward-789', title: 'Laundry Day' },
                user_input: '',
                status: 'unfulfilled'
            };

            await handleRedemptionAnnouncement(
                'channel.channel_points_custom_reward_redemption.add',
                event,
                'testchannel',
                defaultTtsConfig
            );

            expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
                'testchannel',
                expect.objectContaining({ text: 'TestUser redeemed Laundry Day' }),
                null
            );
        });

        it('should defer when the channel has opted out', async () => {
            const event = {
                id: 'redemption-deferred-1',
                user_name: 'TestUser',
                user_login: 'testuser',
                reward: { id: 'reward-789', title: 'Laundry Day' },
                user_input: '',
                status: 'unfulfilled'
            };

            await handleRedemptionAnnouncement(
                'channel.channel_points_custom_reward_redemption.add',
                event,
                'testchannel',
                deferredTtsConfig
            );

            expect(mockDispatchTtsEvent).not.toHaveBeenCalled();
            expect(mockAddRedemption).toHaveBeenCalled();
        });
    });

    describe('mutedRewardIds', () => {
        const mutedConfig = {
            ...defaultTtsConfig,
            mutedRewardIds: { 'reward-horn': { title: 'Air Horn', by: 'twitch:1', at: null } },
        };
        const hornEvent = (status) => ({
            id: 'redemption-horn',
            user_name: 'TestUser',
            user_login: 'testuser',
            user_id: '4242',
            reward: { id: 'reward-horn', title: 'Air Horn' },
            user_input: '',
            status,
        });

        it('stays silent for a muted reward that skips the queue', async () => {
            await handleRedemptionAnnouncement(
                'channel.channel_points_custom_reward_redemption.add', hornEvent('fulfilled'), 'testchannel', mutedConfig
            );
            expect(mockDispatchTtsEvent).not.toHaveBeenCalled();
        });

        it('neither stashes nor later announces a muted reward on the deferred path', async () => {
            const deferredMuted = { ...mutedConfig, announceUnfulfilledRedemptions: false };
            await handleRedemptionAnnouncement(
                'channel.channel_points_custom_reward_redemption.add', hornEvent('unfulfilled'), 'testchannel', deferredMuted
            );
            expect(mockAddRedemption).not.toHaveBeenCalled();
            await handleRedemptionAnnouncement(
                'channel.channel_points_custom_reward_redemption.update', hornEvent('fulfilled'), 'testchannel', deferredMuted
            );
            expect(mockDispatchTtsEvent).not.toHaveBeenCalled();
        });

        it('still announces every other reward', async () => {
            const event = { ...hornEvent('fulfilled'), id: 'redemption-other', reward: { id: 'reward-other', title: 'Hydrate' } };
            await handleRedemptionAnnouncement(
                'channel.channel_points_custom_reward_redemption.add', event, 'testchannel', mutedConfig
            );
            expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
                'testchannel', expect.objectContaining({ text: 'TestUser redeemed Hydrate' }), null
            );
        });
    });

    it('drops the stashed entry when an ignored user\'s deferred redemption is approved', async () => {
        const ignoredConfig = {
            ...deferredTtsConfig,
            ignoredUserIds: { 'twitch:4242': { label: 'Ignored', source: 'moderator', by: null, at: null } },
        };
        const event = {
            id: 'redemption-ignored',
            user_name: 'TestUser',
            user_login: 'testuser',
            user_id: '4242',
            reward: { id: 'reward-123', title: 'Hydrate' },
            user_input: '',
            status: 'fulfilled',
        };
        await handleRedemptionAnnouncement(
            'channel.channel_points_custom_reward_redemption.update', event, 'testchannel', ignoredConfig
        );
        expect(mockDispatchTtsEvent).not.toHaveBeenCalled();
        expect(mockRemoveRedemption).toHaveBeenCalledWith('redemption-ignored');
    });

    it('should use fallback name when user_name is missing', async () => {
        const event = {
            reward: { id: 'reward-123', title: 'Hydrate' },
            user_input: '',
            status: 'fulfilled'
        };

        await handleRedemptionAnnouncement(
            'channel.channel_points_custom_reward_redemption.add',
            event,
            'testchannel',
            defaultTtsConfig
        );

        expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
            'testchannel',
            {
                text: 'Someone redeemed Hydrate',
                user: 'Someone',
                type: 'event'
            },
            null
        );
    });

    it('should skip TTS when user is on the ignore list', async () => {
        const event = {
            user_name: 'SpamBot',
            user_login: 'spambot',
            user_id: '99999',
            reward: { id: 'reward-123', title: 'Hydrate' },
            user_input: 'spam message',
            status: 'fulfilled'
        };
        const ttsConfig = { ...defaultTtsConfig, ignoredUserIds: { 'twitch:99999': 'SpamBot' } };

        await handleRedemptionAnnouncement(
            'channel.channel_points_custom_reward_redemption.add',
            event,
            'testchannel',
            ttsConfig
        );

        expect(mockDispatchTtsEvent).not.toHaveBeenCalled();
        expect(mockFormatTtsText).not.toHaveBeenCalled();
    });

    it('should announce redemption but omit user_input containing banned word', async () => {
        const event = {
            user_name: 'viewer23',
            user_login: 'viewer23',
            reward: { id: 'reward-123', title: 'Say Something' },
            user_input: 'check out badword link',
            status: 'fulfilled'
        };
        const ttsConfig = { ...defaultTtsConfig, bannedWords: ['badword'] };

        await handleRedemptionAnnouncement(
            'channel.channel_points_custom_reward_redemption.add',
            event,
            'testchannel',
            ttsConfig
        );

        expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
            'testchannel',
            expect.objectContaining({ text: 'viewer23 redeemed Say Something' }),
            null
        );
        expect(mockFormatTtsText).not.toHaveBeenCalled();
    });
});
