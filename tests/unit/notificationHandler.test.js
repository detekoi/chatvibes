// tests/unit/notificationHandler.test.js
// Tests for EventSub notification handler

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

const { handleNotification, WATCH_STREAK_TYPE, SUB_GIFT_TYPE, COMMUNITY_SUB_GIFT_TYPE } = await import('../../src/components/twitch/handlers/notificationHandler.js');

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

            expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
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
            expect(mockDispatchTtsEvent).not.toHaveBeenCalled();

            // Should log debug message about skipping
            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({
                    channelName: 'testchannel',
                    user: 'GiftRecipient'
                }),
                'Skipping gift subscription - will be announced by its sub_gift chat notification'
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
            expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
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
        it('should skip TTS - superseded by the chat notification that names the recipient', async () => {
            const event = {
                user_name: 'Gifter',
                user_login: 'gifter',
                tier: '1000',
                total: 1,
                is_anonymous: false
            };

            await handleNotification('channel.subscription.gift', event, 'testchannel');

            expect(mockDispatchTtsEvent).not.toHaveBeenCalled();
        });
    });

    describe('sub_gift chat notification', () => {
        it('should name the recipient of a single gift sub', async () => {
            const event = {
                notice_type: 'sub_gift',
                chatter_user_name: 'Gifter',
                chatter_user_login: 'gifter',
                chatter_user_id: '123',
                chatter_is_anonymous: false,
                sub_gift: {
                    duration_months: 1,
                    recipient_user_name: 'Progamer6006',
                    recipient_user_login: 'progamer6006',
                    recipient_user_id: '456',
                    sub_tier: '1000',
                    community_gift_id: null
                }
            };

            await handleNotification(SUB_GIFT_TYPE, event, 'testchannel');

            expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
                'testchannel',
                {
                    text: 'Gifter just gifted a Tier 1 sub to Progamer6006!',
                    user: 'Gifter',
                    userId: '123',
                    type: 'event'
                },
                null
            );
        });

        it('should announce the tier of a higher-tier gift', async () => {
            const event = {
                notice_type: 'sub_gift',
                chatter_user_name: 'Gifter',
                chatter_user_id: '123',
                sub_gift: { recipient_user_name: 'Recipient', sub_tier: '3000' }
            };

            await handleNotification(SUB_GIFT_TYPE, event, 'testchannel');

            expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
                'testchannel',
                expect.objectContaining({ text: 'Gifter just gifted a Tier 3 sub to Recipient!' }),
                null
            );
        });

        it('should handle an anonymous gifter', async () => {
            const event = {
                notice_type: 'sub_gift',
                chatter_is_anonymous: true,
                chatter_user_name: 'AnAnonymousGifter',
                chatter_user_id: '274598607',
                sub_gift: { recipient_user_name: 'Recipient', sub_tier: '1000' }
            };

            await handleNotification(SUB_GIFT_TYPE, event, 'testchannel');

            expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
                'testchannel',
                {
                    text: 'An anonymous gifter just gifted a Tier 1 sub to Recipient!',
                    user: 'anonymous_gifter',
                    type: 'event'
                },
                null
            );
        });

        it('should skip TTS when the gifter is on the ignore list', async () => {
            const event = {
                notice_type: 'sub_gift',
                chatter_user_name: 'Gifter',
                chatter_user_login: 'gifter',
                chatter_user_id: '4001',
                sub_gift: { recipient_user_name: 'Recipient', sub_tier: '1000' }
            };

            await handleNotification(SUB_GIFT_TYPE, event, 'testchannel', { ignoredUserIds: { 'twitch:4001': 'Gifter' } });

            expect(mockDispatchTtsEvent).not.toHaveBeenCalled();
        });

        it('should still announce an anonymous gift when the ignore list is set', async () => {
            const event = {
                notice_type: 'sub_gift',
                chatter_is_anonymous: true,
                chatter_user_name: 'AnAnonymousGifter',
                chatter_user_id: '4002',
                sub_gift: { recipient_user_name: 'Recipient', sub_tier: '1000' }
            };

            await handleNotification(SUB_GIFT_TYPE, event, 'testchannel', { ignoredUserIds: { 'twitch:4002': 'AnAnonymousGifter' } });

            expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
                'testchannel',
                expect.objectContaining({ text: 'An anonymous gifter just gifted a Tier 1 sub to Recipient!' }),
                null
            );
        });

        it('should skip TTS when the notice carries no recipient', async () => {
            const event = {
                notice_type: 'sub_gift',
                chatter_user_name: 'Gifter',
                sub_gift: { sub_tier: '1000' }
            };

            await handleNotification(SUB_GIFT_TYPE, event, 'testchannel');

            expect(mockDispatchTtsEvent).not.toHaveBeenCalled();
        });

        it('should omit the tier when sub_tier is missing or unrecognised', async () => {
            const event = {
                notice_type: 'sub_gift',
                chatter_user_name: 'Gifter',
                sub_gift: { recipient_user_name: 'Recipient' }
            };

            await handleNotification(SUB_GIFT_TYPE, event, 'testchannel');

            expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
                'testchannel',
                expect.objectContaining({ text: 'Gifter just gifted a sub to Recipient!' }),
                null
            );
        });
    });

    describe('community_sub_gift chat notification', () => {
        it('should announce the count without naming recipients', async () => {
            const event = {
                notice_type: 'community_sub_gift',
                chatter_user_name: 'GenerousGifter',
                chatter_user_id: '123',
                community_sub_gift: { id: 'abc', total: 10, sub_tier: '1000' }
            };

            await handleNotification(COMMUNITY_SUB_GIFT_TYPE, event, 'testchannel');

            expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
                'testchannel',
                {
                    text: 'GenerousGifter just gifted 10 Tier 1 subs!',
                    user: 'GenerousGifter',
                    userId: '123',
                    type: 'event'
                },
                null
            );
        });

        it('should skip TTS when the mass gifter is on the ignore list', async () => {
            const event = {
                notice_type: 'community_sub_gift',
                chatter_user_name: 'GenerousGifter',
                chatter_user_login: 'generousgifter',
                chatter_user_id: '4003',
                community_sub_gift: { id: 'abc', total: 10, sub_tier: '1000' }
            };

            await handleNotification(COMMUNITY_SUB_GIFT_TYPE, event, 'testchannel', { ignoredUserIds: { 'twitch:4003': 'GenerousGifter' } });

            expect(mockDispatchTtsEvent).not.toHaveBeenCalled();
        });

        it('should handle an anonymous mass gift', async () => {
            const event = {
                notice_type: 'community_sub_gift',
                chatter_is_anonymous: true,
                community_sub_gift: { id: 'abc', total: 5, sub_tier: '1000' }
            };

            await handleNotification(COMMUNITY_SUB_GIFT_TYPE, event, 'testchannel');

            expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
                'testchannel',
                {
                    text: '5 Tier 1 gift subs from an anonymous gifter!',
                    user: 'anonymous_gifter',
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
            expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
                'testchannel',
                expect.objectContaining({
                    text: 'Resubber resubscribed for 12 months (Tier 1)! They said: Love this stream!',
                    user: 'Resubber',
                }),
                null
            );
        });

        it('should announce the sub streak when the viewer shares it', async () => {
            const event = {
                user_name: 'Resubber',
                user_login: 'resubber',
                tier: '1000',
                cumulative_months: 25,
                streak_months: 12
            };

            await handleNotification('channel.subscription.message', event, 'testchannel');

            expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
                'testchannel',
                expect.objectContaining({
                    text: 'Resubber resubscribed for 25 months, on a 12 month streak (Tier 1)!'
                }),
                null
            );
        });

        it('should omit the sub streak when the viewer does not share it', async () => {
            // Twitch sends streak_months: null when the viewer opts out of sharing
            const event = {
                user_name: 'Resubber',
                user_login: 'resubber',
                tier: '1000',
                cumulative_months: 25,
                streak_months: null
            };

            await handleNotification('channel.subscription.message', event, 'testchannel');

            expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
                'testchannel',
                expect.objectContaining({
                    text: 'Resubber resubscribed for 25 months (Tier 1)!'
                }),
                null
            );
        });

        it('should omit a 1 month sub streak as it reads awkwardly', async () => {
            const event = {
                user_name: 'Resubber',
                user_login: 'resubber',
                tier: '1000',
                cumulative_months: 2,
                streak_months: 1
            };

            await handleNotification('channel.subscription.message', event, 'testchannel');

            expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
                'testchannel',
                expect.objectContaining({ text: 'Resubber resubscribed for 2 months (Tier 1)!' }),
                null
            );
        });

        it('should combine sub streak and resub message', async () => {
            mockFormatTtsText.mockResolvedValueOnce('Love this stream!');
            const event = {
                user_name: 'Resubber',
                user_login: 'resubber',
                tier: '2000',
                cumulative_months: 30,
                streak_months: 30,
                message: { text: 'Love this stream!' }
            };

            await handleNotification('channel.subscription.message', event, 'testchannel');

            expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
                'testchannel',
                expect.objectContaining({
                    text: 'Resubber resubscribed for 30 months, on a 30 month streak (Tier 2)! They said: Love this stream!'
                }),
                null
            );
        });

        it('should use the resubber pronouns for the "said" prefix', async () => {
            mockFormatTtsText.mockResolvedValueOnce('Love this stream!');
            mockPronounService.getUserPronouns.mockResolvedValueOnce({ Subject: 'She', subject: 'she' });
            const event = {
                user_name: 'Resubber',
                user_login: 'resubber',
                tier: '1000',
                cumulative_months: 12,
                message: { text: 'Love this stream!' }
            };

            await handleNotification('channel.subscription.message', event, 'testchannel');

            expect(mockPronounService.getUserPronouns).toHaveBeenCalledWith('resubber');
            expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
                'testchannel',
                expect.objectContaining({
                    text: 'Resubber resubscribed for 12 months (Tier 1)! She said: Love this stream!'
                }),
                null
            );
        });

        it('should skip resub TTS when user is on the ignore list', async () => {
            const event = {
                user_name: 'SpamBot',
                user_login: 'spambot',
                user_id: '99999',
                tier: '1000',
                cumulative_months: 6,
                message: { text: 'spam message' }
            };
            const ttsConfig = { ignoredUserIds: { 'twitch:99999': 'SpamBot' }, engineEnabled: true };

            await handleNotification('channel.subscription.message', event, 'testchannel', ttsConfig);

            expect(mockDispatchTtsEvent).not.toHaveBeenCalled();
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

            expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
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
                user_id: '99999',
                tier: '1000',
                is_gift: false
            };
            const ttsConfig = { ignoredUserIds: { 'twitch:99999': 'SpamBot' }, engineEnabled: true };

            await handleNotification('channel.subscribe', event, 'testchannel', ttsConfig);

            expect(mockDispatchTtsEvent).not.toHaveBeenCalled();
        });

        it('should skip cheer TTS when non-anonymous user is on the ignore list', async () => {
            const event = {
                user_name: 'SpamBot',
                user_login: 'spambot',
                user_id: '99999',
                bits: 100,
                is_anonymous: false
            };
            const ttsConfig = { ignoredUserIds: { 'twitch:99999': 'SpamBot' }, engineEnabled: true };

            await handleNotification('channel.cheer', event, 'testchannel', ttsConfig);

            expect(mockDispatchTtsEvent).not.toHaveBeenCalled();
        });

        it('should handle raid event', async () => {
            const event = {
                from_broadcaster_user_name: 'Raider',
                from_broadcaster_user_login: 'raider',
                viewers: 42
            };

            await handleNotification('channel.raid', event, 'testchannel');

            expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
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

            expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
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

            expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
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

            expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
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

            expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
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

            expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
                'testchannel',
                { text: 'viewer23 is on a 5 stream watch streak!', user: 'viewer23', userId: '49912639', type: 'event' },
                null
            );
            expect(mockFormatTtsText).not.toHaveBeenCalled();
            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.objectContaining({ channelName: 'testchannel', user: 'viewer23', streakCount: 5, viewerMessage: null }),
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
            expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
                'testchannel',
                { text: 'turboicehusky is on a 10 stream watch streak! They said: 10!', user: 'turboicehusky', userId: '12345678', type: 'event' },
                null
            );
            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.objectContaining({ user: 'turboicehusky', streakCount: 10, viewerMessage: '10!' }),
                'Watch streak event'
            );
        });

        it('should still use the pronoun when the lookup takes longer than half a second', async () => {
            // Regression: the fallback used to fire at 500ms, which lost the race on every
            // cold cache (a pronouns.alejo.io miss costs ~700-760ms), so viewers with
            // pronouns registered were announced as "They" anyway.
            jest.useFakeTimers();
            try {
                mockFormatTtsText.mockResolvedValueOnce('25 Streak!');
                mockPronounService.getUserPronouns.mockImplementationOnce(
                    () => new Promise(resolve => setTimeout(() => resolve({ Subject: 'He', subject: 'he' }), 750))
                );
                const event = {
                    chatter_user_name: 'turboicehusky',
                    chatter_user_login: 'turboicehusky',
                    chatter_user_id: '69303911',
                    notice_type: 'watch_streak',
                    watch_streak: { streak_count: 25, channel_points_awarded: 450 },
                    message: { text: '25 Streak!' }
                };

                const pending = handleNotification(WATCH_STREAK_TYPE, event, 'parfaitfair');
                await jest.advanceTimersByTimeAsync(750);
                await pending;

                expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
                    'parfaitfair',
                    expect.objectContaining({
                        text: 'turboicehusky is on a 25 stream watch streak! He said: 25 Streak!'
                    }),
                    null
                );
            } finally {
                jest.useRealTimers();
            }
        });

        it('should not wait on the pronoun lookup when the message formats to empty', async () => {
            // The announcement drops the message entirely on this path, so it must not be
            // held up by a lookup whose result it would discard. Timers are never advanced:
            // if the handler awaited the (never-resolving) lookup, this would hang.
            jest.useFakeTimers();
            try {
                mockFormatTtsText.mockResolvedValueOnce('');
                mockPronounService.getUserPronouns.mockImplementationOnce(() => new Promise(() => {}));
                const event = {
                    chatter_user_name: 'turboicehusky',
                    chatter_user_login: 'turboicehusky',
                    chatter_user_id: '69303911',
                    notice_type: 'watch_streak',
                    watch_streak: { streak_count: 25, channel_points_awarded: 450 },
                    message: { text: 'parfai14Parfait' }
                };

                await handleNotification(WATCH_STREAK_TYPE, event, 'parfaitfair', { emoteMode: 'skip' });

                expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
                    'parfaitfair',
                    expect.objectContaining({
                        text: 'turboicehusky is on a 25 stream watch streak!'
                    }),
                    null
                );
            } finally {
                jest.useRealTimers();
            }
        });

        it('should fall back to "They" when the pronoun lookup never returns', async () => {
            jest.useFakeTimers();
            try {
                mockFormatTtsText.mockResolvedValueOnce('25 Streak!');
                mockPronounService.getUserPronouns.mockImplementationOnce(() => new Promise(() => {}));
                const event = {
                    chatter_user_name: 'turboicehusky',
                    chatter_user_login: 'turboicehusky',
                    chatter_user_id: '69303911',
                    notice_type: 'watch_streak',
                    watch_streak: { streak_count: 25, channel_points_awarded: 450 },
                    message: { text: '25 Streak!' }
                };

                const pending = handleNotification(WATCH_STREAK_TYPE, event, 'parfaitfair');
                await jest.advanceTimersByTimeAsync(2500);
                await pending;

                expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
                    'parfaitfair',
                    expect.objectContaining({
                        text: 'turboicehusky is on a 25 stream watch streak! They said: 25 Streak!'
                    }),
                    null
                );
            } finally {
                jest.useRealTimers();
            }
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
            const ttsConfig = { ignoredUserIds: { 'twitch:99999': 'SpamBot' }, engineEnabled: true };

            await handleNotification(WATCH_STREAK_TYPE, event, 'testchannel', ttsConfig);

            expect(mockDispatchTtsEvent).not.toHaveBeenCalled();
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
            expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
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
                {
                    emoteMode: 'skip',
                    channelEmoteMode: 'skip',
                    readFullUrls: true,
                    // A compiled rule set built from the built-in dictionary.
                    // Its contents are covered by textRewrite.test.js.
                    pronunciationRules: expect.objectContaining({ re: expect.any(RegExp) }),
                    // Channel-level, so emoji labels and emote descriptions come
                    // out in the channel's language rather than the viewer's.
                    locale: 'en',
                }
            );
            expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
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

            expect(mockDispatchTtsEvent).toHaveBeenCalledWith(
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

            expect(mockDispatchTtsEvent).not.toHaveBeenCalled();
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

            expect(mockDispatchTtsEvent).not.toHaveBeenCalled();
        });
    });
});
