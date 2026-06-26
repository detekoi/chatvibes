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

// Mock formatTtsText — pass through by default, can be overridden per test
const mockFormatTtsText = jest.fn(async (text) => text);
jest.unstable_mockModule('../../src/lib/formatTtsText.js', () => ({
    formatTtsText: mockFormatTtsText
}));

const mockPronounService = {
    getUserPronouns: jest.fn().mockResolvedValue({
        Subject: 'They',
        subject: 'they',
        Object: 'Them',
        object: 'them',
        Possessive: 'Their',
        possessive: 'their',
        Reflexive: 'Themself',
        reflexive: 'themself'
    })
};
jest.unstable_mockModule('../../src/lib/pronounService.js', () => ({
    pronounService: mockPronounService
}));

const { handleNotification, WATCH_STREAK_TYPE } = await import('../../src/components/twitch/handlers/notificationHandler.js');

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
                    text: 'Gifter just gifted 1 Tier 1 sub!',
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
                    text: '5 Tier 1 gift subs from an anonymous gifter!',
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
                    text: 'GenerousGifter just gifted 10 Tier 1 subs!',
                    user: 'GenerousGifter',
                    type: 'event'
                },
                null
            );
        });
    });

    describe('other event types', () => {
        it('should handle resubscription event with formatted message', async () => {
            mockFormatTtsText.mockResolvedValueOnce('Love this stream!');
            const event = {
                user_name: 'Resubber',
                user_login: 'resubber',
                tier: '1000',
                cumulative_months: 12,
                message: { text: 'Love this stream!' }
            };

            await handleNotification('channel.subscription.message', event, 'testchannel');

            expect(mockFormatTtsText).toHaveBeenCalledWith(
                'Love this stream!',
                null,
                expect.objectContaining({ emoteMode: 'describe', readFullUrls: false })
            );
            expect(mockPublishTtsEvent).toHaveBeenCalledWith(
                'testchannel',
                expect.objectContaining({
                    text: 'Resubber resubscribed for 12 months (Tier 1)! Love this stream!',
                    user: 'Resubber',
                }),
                null
            );
        });

        it('should skip resub TTS when user is on the ignore list', async () => {
            const event = {
                user_name: 'SpamBot',
                user_login: 'spambot',
                tier: '1000',
                cumulative_months: 6,
                message: { text: 'spam message' }
            };
            const ttsConfig = { ignoredUsers: ['spambot'], engineEnabled: true };

            await handleNotification('channel.subscription.message', event, 'testchannel', ttsConfig);

            expect(mockPublishTtsEvent).not.toHaveBeenCalled();
            expect(mockFormatTtsText).not.toHaveBeenCalled();
        });

        it('should announce resub but omit message containing banned word', async () => {
            const event = {
                user_name: 'viewer23',
                user_login: 'viewer23',
                tier: '1000',
                cumulative_months: 3,
                message: { text: 'check out badword link' }
            };
            const ttsConfig = { bannedWords: ['badword'], engineEnabled: true };

            await handleNotification('channel.subscription.message', event, 'testchannel', ttsConfig);

            expect(mockPublishTtsEvent).toHaveBeenCalledWith(
                'testchannel',
                expect.objectContaining({ text: 'viewer23 resubscribed for 3 months (Tier 1)!' }),
                null
            );
            expect(mockFormatTtsText).not.toHaveBeenCalled();
        });

        it('should skip new sub TTS when user is on the ignore list', async () => {
            const event = {
                user_name: 'SpamBot',
                user_login: 'spambot',
                tier: '1000',
                is_gift: false
            };
            const ttsConfig = { ignoredUsers: ['spambot'], engineEnabled: true };

            await handleNotification('channel.subscribe', event, 'testchannel', ttsConfig);

            expect(mockPublishTtsEvent).not.toHaveBeenCalled();
        });

        it('should skip cheer TTS when non-anonymous user is on the ignore list', async () => {
            const event = {
                user_name: 'SpamBot',
                user_login: 'spambot',
                bits: 100,
                is_anonymous: false
            };
            const ttsConfig = { ignoredUsers: ['spambot'], engineEnabled: true };

            await handleNotification('channel.cheer', event, 'testchannel', ttsConfig);

            expect(mockPublishTtsEvent).not.toHaveBeenCalled();
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

    describe('watch_streak event', () => {
        it('should generate TTS for watch streak event without message', async () => {
            const event = {
                chatter_user_name: 'viewer23',
                chatter_user_login: 'viewer23',
                chatter_user_id: '49912639',
                notice_type: 'watch_streak',
                watch_streak: { streak_count: 5, channel_points_awarded: 450 },
            };

            await handleNotification(WATCH_STREAK_TYPE, event, 'testchannel');

            expect(mockPublishTtsEvent).toHaveBeenCalledWith(
                'testchannel',
                { text: 'viewer23 is on a 5 stream watch streak!', user: 'viewer23', userId: '49912639', type: 'event' },
                null
            );
            expect(mockFormatTtsText).not.toHaveBeenCalled();
            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.objectContaining({ channelName: 'testchannel', user: 'viewer23', streakCount: 5, message: null }),
                'Watch streak event'
            );
        });

        it('should include the attached chat message in TTS after formatting', async () => {
            mockFormatTtsText.mockResolvedValueOnce('10!');
            const event = {
                chatter_user_name: 'turboicehusky',
                chatter_user_login: 'turboicehusky',
                chatter_user_id: '12345678',
                notice_type: 'watch_streak',
                watch_streak: { streak_count: 10, channel_points_awarded: 450 },
                message: { text: '10!', fragments: [{ type: 'text', text: '10!' }] }
            };

            await handleNotification(WATCH_STREAK_TYPE, event, 'testchannel');

            expect(mockFormatTtsText).toHaveBeenCalledWith(
                '10!',
                [{ type: 'text', text: '10!' }],
                expect.objectContaining({ emoteMode: 'describe', readFullUrls: false })
            );
            expect(mockPublishTtsEvent).toHaveBeenCalledWith(
                'testchannel',
                { text: 'turboicehusky is on a 10 stream watch streak! They said: 10!', user: 'turboicehusky', userId: '12345678', type: 'event' },
                null
            );
            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.objectContaining({ user: 'turboicehusky', streakCount: 10, message: '10!' }),
                'Watch streak event'
            );
        });

        it('should skip TTS entirely when user is on the ignore list', async () => {
            const event = {
                chatter_user_name: 'SpamBot',
                chatter_user_login: 'spambot',
                chatter_user_id: '99999',
                notice_type: 'watch_streak',
                watch_streak: { streak_count: 3 },
                message: { text: 'buy stuff at spam.example.com' }
            };
            const ttsConfig = { ignoredUsers: ['spambot'], engineEnabled: true };

            await handleNotification(WATCH_STREAK_TYPE, event, 'testchannel', ttsConfig);

            expect(mockPublishTtsEvent).not.toHaveBeenCalled();
            expect(mockFormatTtsText).not.toHaveBeenCalled();
        });

        it('should announce streak but omit message containing banned word', async () => {
            const event = {
                chatter_user_name: 'viewer23',
                chatter_user_login: 'viewer23',
                chatter_user_id: '49912639',
                notice_type: 'watch_streak',
                watch_streak: { streak_count: 7 },
                message: { text: 'check out badword stream' }
            };
            const ttsConfig = { bannedWords: ['badword'], engineEnabled: true };

            await handleNotification(WATCH_STREAK_TYPE, event, 'testchannel', ttsConfig);

            // Still announces the streak, but without the user's message
            expect(mockPublishTtsEvent).toHaveBeenCalledWith(
                'testchannel',
                expect.objectContaining({ text: 'viewer23 is on a 7 stream watch streak!' }),
                null
            );
            expect(mockFormatTtsText).not.toHaveBeenCalled();
        });

        it('should pass ttsConfig options to formatTtsText', async () => {
            mockFormatTtsText.mockResolvedValueOnce('twitch.tv');
            const event = {
                chatter_user_name: 'viewer23',
                chatter_user_login: 'viewer23',
                chatter_user_id: '49912639',
                notice_type: 'watch_streak',
                watch_streak: { streak_count: 4 },
                message: { text: 'https://twitch.tv/somechannel', fragments: [{ type: 'text', text: 'https://twitch.tv/somechannel' }] }
            };
            const ttsConfig = { emoteMode: 'skip', readFullUrls: true, engineEnabled: true };

            await handleNotification(WATCH_STREAK_TYPE, event, 'testchannel', ttsConfig);

            expect(mockFormatTtsText).toHaveBeenCalledWith(
                'https://twitch.tv/somechannel',
                [{ type: 'text', text: 'https://twitch.tv/somechannel' }],
                { emoteMode: 'skip', channelEmoteMode: 'skip', readFullUrls: true }
            );
            expect(mockPublishTtsEvent).toHaveBeenCalledWith(
                'testchannel',
                expect.objectContaining({ text: 'viewer23 is on a 4 stream watch streak! They said: twitch.tv' }),
                null
            );
        });

        it('should fall back to "Someone" when chatter_user_name is missing', async () => {
            const event = {
                chatter_user_id: '49912639',
                notice_type: 'watch_streak',
                watch_streak: { streak_count: 3, channel_points_awarded: 300 }
            };

            await handleNotification(WATCH_STREAK_TYPE, event, 'testchannel');

            expect(mockPublishTtsEvent).toHaveBeenCalledWith(
                'testchannel',
                { text: 'Someone is on a 3 stream watch streak!', user: 'Someone', userId: '49912639', type: 'event' },
                null
            );
        });

        it('should skip TTS when watch_streak data is null', async () => {
            const event = {
                chatter_user_name: 'viewer23',
                chatter_user_login: 'viewer23',
                chatter_user_id: '49912639',
                notice_type: 'watch_streak',
                watch_streak: null
            };

            await handleNotification(WATCH_STREAK_TYPE, event, 'testchannel');

            expect(mockPublishTtsEvent).not.toHaveBeenCalled();
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({ channelName: 'testchannel', user: 'viewer23' }),
                expect.stringContaining('invalid streak_count')
            );
        });

        it('should skip TTS when streak_count is zero', async () => {
            const event = {
                chatter_user_name: 'viewer23',
                chatter_user_login: 'viewer23',
                chatter_user_id: '49912639',
                notice_type: 'watch_streak',
                watch_streak: { streak_count: 0 }
            };

            await handleNotification(WATCH_STREAK_TYPE, event, 'testchannel');

            expect(mockPublishTtsEvent).not.toHaveBeenCalled();
        });
    });
});
