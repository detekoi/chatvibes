// tests/unit/redemptionAnnouncement.test.js
// Tests for Channel Points redemption announcement handler

import { jest } from '@jest/globals';

// Mock dependencies before imports
const mockPublishTtsEvent = jest.fn().mockResolvedValue(undefined);
const mockGetSharedSessionInfo = jest.fn().mockResolvedValue(null);
const mockLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
};

jest.unstable_mockModule('../../src/lib/pubsub.js', () => ({
    publishTtsEvent: mockPublishTtsEvent
}));

jest.unstable_mockModule('../../src/components/twitch/eventUtils.js', () => ({
    getSharedSessionInfo: mockGetSharedSessionInfo
}));

jest.unstable_mockModule('../../src/lib/logger.js', () => ({
    default: mockLogger
}));

// Mock modules used by handleChannelPointsRedemption that we don't need for announcement tests
jest.unstable_mockModule('../../src/components/twitch/redemptionCache.js', () => ({
    addRedemption: jest.fn(),
    getRedemption: jest.fn(),
    removeRedemption: jest.fn()
}));

jest.unstable_mockModule('../../src/lib/allowList.js', () => ({
    isChannelAllowed: jest.fn().mockResolvedValue(true)
}));

jest.unstable_mockModule('../../src/components/tts/ttsState.js', () => ({
    getTtsState: jest.fn().mockResolvedValue({})
}));

jest.unstable_mockModule('../../src/lib/urlProcessor.js', () => ({
    processMessageUrls: jest.fn((text) => text)
}));

// Mock formatTtsText — pass through by default, can be overridden per test
const mockFormatTtsText = jest.fn(async (text) => text);
jest.unstable_mockModule('../../src/lib/formatTtsText.js', () => ({
    formatTtsText: mockFormatTtsText
}));

const { handleRedemptionAnnouncement } = await import('../../src/components/twitch/handlers/redemptionHandler.js');

describe('handleRedemptionAnnouncement', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    const defaultTtsConfig = {
        engineEnabled: true,
        speakRedemptionEvents: true
    };

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
        expect(mockPublishTtsEvent).toHaveBeenCalledWith(
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

        expect(mockPublishTtsEvent).toHaveBeenCalledWith(
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

        expect(mockPublishTtsEvent).not.toHaveBeenCalled();
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

        expect(mockPublishTtsEvent).not.toHaveBeenCalled();
    });

    it('should ignore redemption.update events', async () => {
        const event = {
            user_name: 'TestUser',
            reward: { id: 'reward-123', title: 'Hydrate' },
            user_input: '',
            status: 'fulfilled'
        };

        await handleRedemptionAnnouncement(
            'channel.channel_points_custom_reward_redemption.update',
            event,
            'testchannel',
            defaultTtsConfig
        );

        expect(mockPublishTtsEvent).not.toHaveBeenCalled();
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

        expect(mockPublishTtsEvent).not.toHaveBeenCalled();
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

        expect(mockPublishTtsEvent).toHaveBeenCalledWith(
            'testchannel',
            expect.objectContaining({
                text: 'TestUser redeemed Say Something: hello world',
                user: 'TestUser',
            }),
            null
        );
    });

    it('should announce unfulfilled redemptions (pending approval)', async () => {
        mockFormatTtsText.mockResolvedValueOnce('play despacito');
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
            defaultTtsConfig
        );

        expect(mockPublishTtsEvent).toHaveBeenCalledWith(
            'testchannel',
            expect.objectContaining({
                text: 'TestUser redeemed Song Request: play despacito',
                user: 'TestUser',
            }),
            null
        );
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

        expect(mockPublishTtsEvent).toHaveBeenCalledWith(
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
            reward: { id: 'reward-123', title: 'Hydrate' },
            user_input: 'spam message',
            status: 'fulfilled'
        };
        const ttsConfig = { ...defaultTtsConfig, ignoredUsers: ['spambot'] };

        await handleRedemptionAnnouncement(
            'channel.channel_points_custom_reward_redemption.add',
            event,
            'testchannel',
            ttsConfig
        );

        expect(mockPublishTtsEvent).not.toHaveBeenCalled();
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

        expect(mockPublishTtsEvent).toHaveBeenCalledWith(
            'testchannel',
            expect.objectContaining({ text: 'viewer23 redeemed Say Something' }),
            null
        );
        expect(mockFormatTtsText).not.toHaveBeenCalled();
    });
});
