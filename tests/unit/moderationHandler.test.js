// tests/unit/moderationHandler.test.js
// The removal each chat moderation event describes, and the hand-off to the queue.

import { jest } from '@jest/globals';

const mockRemoveChatClips = jest.fn(() => ({ queued: 0, generating: false, sent: 0 }));
jest.unstable_mockModule('../../src/lib/logger.js', () => ({
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule('../../src/components/tts/ttsQueue.js', () => ({ removeChatClips: mockRemoveChatClips }));

const { chatRemovalFor, handleChatRemoval, CHAT_REMOVAL_TYPES } =
    await import('../../src/components/twitch/handlers/moderationHandler.js');
const { runWithTiming } = await import('../../src/lib/ttsTiming.js');
const { CHAT_REMOVAL_SUBSCRIPTION_TYPES } = await import('../../src/components/twitch/twitchSubs.js');

beforeEach(() => jest.clearAllMocks());

test('a deleted message removes that message ID', () => {
    expect(chatRemovalFor('channel.chat.message_delete', { message_id: 'abc', target_user_id: 'u1' }))
        .toEqual({ messageId: 'abc', atMs: expect.any(Number) });
});

test('a timeout or a ban removes the messages of the target viewer', () => {
    expect(chatRemovalFor('channel.chat.clear_user_messages', { target_user_id: 42 }))
        .toEqual({ userId: '42', atMs: expect.any(Number) });
});

test('an event with nothing to remove is ignored', () => {
    expect(chatRemovalFor('channel.chat.message_delete', {})).toBeNull();
    expect(chatRemovalFor('channel.chat.clear_user_messages', {})).toBeNull();
    handleChatRemoval('channel.chat.message_delete', {}, 'chan');
    expect(mockRemoveChatClips).not.toHaveBeenCalled();
});

test('the removal time is when the webhook reached the bot', async () => {
    await runWithTiming({ source: 'eventsub', receivedMs: 1234 }, async () => {
        handleChatRemoval('channel.chat.clear_user_messages', { target_user_id: 'u1' }, 'chan');
    });
    expect(mockRemoveChatClips).toHaveBeenCalledWith('chan', { userId: 'u1', atMs: 1234 });
});

test('the subscriptions and the routed types are the same list', () => {
    expect([...CHAT_REMOVAL_SUBSCRIPTION_TYPES]).toEqual([...CHAT_REMOVAL_TYPES]);
});
