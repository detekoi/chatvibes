// tests/unit/notificationHandler.test.js
// Tests for EventSub notification handler

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

const { handleNotification } = await import('../../src/components/twitch/handlers/notificationHandler.js');

describe('notificationHandler', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('channel.subscribe event', () => {
        it('should generate TTS for regular subscription (is_gift: false)', async () => {
            const event = {
                user_name: 'TestUser',
                user_login: 'testuser',
                tier: '1000',
                is_gift: false
            };

            await handleNotification('channel.subscribe', event, 'testchannel');

            expect(mockPublishTtsEvent).toHaveBeenCalledWith(
                'testchannel',
                {
                    text: 'TestUser just subscribed (Tier 1)!',
                    user: 'TestUser',
                    type: 'event'
                },
                null
            );

            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.objectContaining({
                    channelName: 'testchannel',
                    user: 'TestUser',
                    tier: '1000'
                }),
                'New subscription event'
            );
        });

        it('should skip TTS for gift subscription (is_gift: true)', async () => {
            const event = {
                user_name: 'GiftRecipient',
                user_login: 'giftrecipient',
                tier: '1000',
                is_gift: true
            };

            await handleNotification('channel.subscribe', event, 'testchannel');

            // Should NOT publish TTS event
            expect(mockPublishTtsEvent).not.toHaveBeenCalled();

            // Should log debug message about skipping
            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({
                    channelName: 'testchannel',
                    user: 'GiftRecipient'
                }),
                'Skipping gift subscription - will be announced by channel.subscription.gift event'
            );

            // Should NOT log the subscription event
            expect(mockLogger.info).not.toHaveBeenCalled();
        });

        it('should handle subscription without is_gift field (legacy behavior)', async () => {
            const event = {
                user_name: 'TestUser',
                user_login: 'testuser',
                tier: '1000'
                // no is_gift field
            };

            await handleNotification('channel.subscribe', event, 'testchannel');

            // Should generate TTS (is_gift is undefined/falsy)
            expect(mockPublishTtsEvent).toHaveBeenCalledWith(
                'testchannel',
                {
                    text: 'TestUser just subscribed (Tier 1)!',
                    user: 'TestUser',
                    type: 'event'
                },
                null
            );
        });
    });

    describe('channel.subscription.gift event', () => {
        it('should generate TTS for gift subscription event', async () => {
            const event = {
                user_name: 'Gifter',
                user_login: 'gifter',
                tier: '1000',
                total: 1,
                is_anonymous: false
            };

            await handleNotification('channel.subscription.gift', event, 'testchannel');

            expect(mockPublishTtsEvent).toHaveBeenCalledWith(
                'testchannel',
                {
                    text: 'Gifter just gifted 1  Tier 1 sub!',
                    user: 'Gifter',
                    type: 'event'
                },
                null
            );
        });

        it('should handle anonymous gift subscription', async () => {
            const event = {
                tier: '1000',
                total: 5,
                is_anonymous: true
            };

            await handleNotification('channel.subscription.gift', event, 'testchannel');

            expect(mockPublishTtsEvent).toHaveBeenCalledWith(
                'testchannel',
                {
                    text: '5  Tier 1 gift subs from an anonymous gifter!',
                    user: 'anonymous_gifter',
                    type: 'event'
                },
                null
            );
        });

        it('should handle multiple gift subs', async () => {
            const event = {
                user_name: 'GenerousGifter',
                tier: '1000',
                total: 10,
                is_anonymous: false
            };

            await handleNotification('channel.subscription.gift', event, 'testchannel');

            expect(mockPublishTtsEvent).toHaveBeenCalledWith(
                'testchannel',
                {
                    text: 'GenerousGifter just gifted 10  Tier 1 subs!',
                    user: 'GenerousGifter',
                    type: 'event'
                },
                null
            );
        });
    });

    describe('other event types', () => {
        it('should handle resubscription event', async () => {
            const event = {
                user_name: 'Resubber',
                user_login: 'resubber',
                tier: '1000',
                cumulative_months: 12,
                message: { text: 'Love this stream!' }
            };

            await handleNotification('channel.subscription.message', event, 'testchannel');

            expect(mockPublishTtsEvent).toHaveBeenCalledWith(
                'testchannel',
                {
                    text: 'Resubber resubscribed for 12 months (Tier 1)! Love this stream!',
                    user: 'Resubber',
                    type: 'event'
                },
                null
            );
        });

        it('should handle raid event', async () => {
            const event = {
                from_broadcaster_user_name: 'Raider',
                from_broadcaster_user_login: 'raider',
                viewers: 42
            };

            await handleNotification('channel.raid', event, 'testchannel');

            expect(mockPublishTtsEvent).toHaveBeenCalledWith(
                'testchannel',
                {
                    text: 'Raider is raiding with 42 viewers!',
                    user: 'Raider',
                    type: 'event'
                },
                null
            );
        });

        it('should anonymize follow event by default (no ttsConfig)', async () => {
            const event = {
                user_name: 'NewFollower',
                user_login: 'newfollower'
            };

            await handleNotification('channel.follow', event, 'testchannel');

            expect(mockPublishTtsEvent).toHaveBeenCalledWith(
                'testchannel',
                {
                    text: 'Someone new just followed!',
                    user: 'anonymous_follower',
                    type: 'event'
                },
                null
            );
        });

        it('should anonymize follow event when anonymizeFollowers is true', async () => {
            const event = {
                user_name: 'NewFollower',
                user_login: 'newfollower'
            };

            await handleNotification('channel.follow', event, 'testchannel', { anonymizeFollowers: true });

            expect(mockPublishTtsEvent).toHaveBeenCalledWith(
                'testchannel',
                {
                    text: 'Someone new just followed!',
                    user: 'anonymous_follower',
                    type: 'event'
                },
                null
            );
        });

        it('should reveal follower name when anonymizeFollowers is false', async () => {
            const event = {
                user_name: 'NewFollower',
                user_login: 'newfollower'
            };

            await handleNotification('channel.follow', event, 'testchannel', { anonymizeFollowers: false });

            expect(mockPublishTtsEvent).toHaveBeenCalledWith(
                'testchannel',
                {
                    text: 'NewFollower just followed!',
                    user: 'NewFollower',
                    type: 'event'
                },
                null
            );
        });

        it('should handle cheer event', async () => {
            const event = {
                user_name: 'Cheerer',
                user_login: 'cheerer',
                bits: 100,
                is_anonymous: false
            };

            await handleNotification('channel.cheer', event, 'testchannel');

            expect(mockPublishTtsEvent).toHaveBeenCalledWith(
                'testchannel',
                {
                    text: 'Cheerer cheered 100 bits!',
                    user: 'Cheerer',
                    type: 'event'
                },
                null
            );
        });
    });
});
