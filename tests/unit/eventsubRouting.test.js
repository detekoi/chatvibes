// tests/unit/eventsubRouting.test.js
// Where a verified, de-duplicated webhook is handled: here, or forwarded to the
// instance that owns the channel (the one holding its browser source).

import { jest } from '@jest/globals';
import { createMockFirestore, FieldValue } from '../helpers/mockFirestore.js';

process.env.EVENTSUB_BYPASS = '1';

const mockOwnership = {
    isOwnershipEnabled: jest.fn(),
    ownsBroadcaster: jest.fn(),
    getLeaseOwner: jest.fn(),
};
const mockForwardToInbox = jest.fn();
const mockHandleChatMessage = jest.fn();
const mockHandleNotification = jest.fn();
const mockIsChannelActive = jest.fn();
let timingSeenByHandler;

jest.unstable_mockModule('../../src/lib/logger.js', () => ({
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule('@google-cloud/firestore', () => ({
    Firestore: jest.fn(() => createMockFirestore()),
    FieldValue,
    Timestamp: { fromMillis: ms => ({ toMillis: () => ms }) },
}));
jest.unstable_mockModule('../../src/lib/firestoreClaim.js', () => ({
    claimOnce: jest.fn().mockResolvedValue(true),
}));
jest.unstable_mockModule('../../src/lib/instanceId.js', () => ({ INSTANCE_ID: 'me' }));
jest.unstable_mockModule('../../src/lib/allowList.js', () => ({ isChannelActive: mockIsChannelActive }));
jest.unstable_mockModule('../../src/components/tts/ttsState.js', () => ({
    getTtsState: jest.fn().mockResolvedValue({ engineEnabled: true, speakEvents: true }),
}));
jest.unstable_mockModule('../../src/lib/channelOwnership.js', () => mockOwnership);
jest.unstable_mockModule('../../src/lib/channelInbox.js', () => ({ forwardToInbox: mockForwardToInbox }));
jest.unstable_mockModule('../../src/components/twitch/handlers/chatHandler.js', () => ({
    handleChatMessage: mockHandleChatMessage,
}));
jest.unstable_mockModule('../../src/components/twitch/handlers/redemptionHandler.js', () => ({
    handleChannelPointsRedemption: jest.fn(),
    handleRedemptionAnnouncement: jest.fn(),
}));
jest.unstable_mockModule('../../src/components/twitch/handlers/notificationHandler.js', () => ({
    handleNotification: mockHandleNotification,
    WATCH_STREAK_TYPE: 'x.watch_streak',
    SUB_GIFT_TYPE: 'x.sub_gift',
    COMMUNITY_SUB_GIFT_TYPE: 'x.community_sub_gift',
}));
jest.unstable_mockModule('../../src/components/twitch/handlers/sharedChatHandler.js', () => ({
    onBegin: jest.fn(), onUpdate: jest.fn(), onEnd: jest.fn(),
}));

const { currentTiming } = await import('../../src/lib/ttsTiming.js');
const { eventSubHandler, handleForwardedNotification, resolveEventChannel } =
    await import('../../src/components/twitch/eventsub.js');

let messageCounter = 0;

async function deliver(notification) {
    const messageId = `msg-${++messageCounter}`;
    const rawBody = Buffer.from(JSON.stringify(notification));
    const req = {
        headers: {
            'twitch-eventsub-message-id': messageId,
            'twitch-eventsub-message-timestamp': new Date().toISOString(),
            'twitch-eventsub-message-type': 'notification',
        },
    };
    const res = { writeHead: () => ({ end: () => {} }) };
    await eventSubHandler(req, res, rawBody);
    return { messageId, rawBody };
}

const chatMessage = (broadcasterId = '111') => ({
    subscription: { type: 'channel.chat.message' },
    event: { broadcaster_user_id: broadcasterId, broadcaster_user_login: 'parfaitfair', message: { text: 'hi' } },
});

beforeEach(() => {
    jest.clearAllMocks();
    mockOwnership.isOwnershipEnabled.mockReturnValue(true);
    mockOwnership.ownsBroadcaster.mockReturnValue(false);
    mockOwnership.getLeaseOwner.mockResolvedValue(null);
    mockIsChannelActive.mockReturnValue(true);
    mockForwardToInbox.mockResolvedValue(undefined);
    timingSeenByHandler = null;
    mockHandleChatMessage.mockImplementation(async () => { timingSeenByHandler = currentTiming(); });
});

test('handles the event here when this instance owns the channel', async () => {
    mockOwnership.ownsBroadcaster.mockReturnValue(true);

    await deliver(chatMessage());

    expect(mockHandleChatMessage).toHaveBeenCalledTimes(1);
    expect(mockOwnership.getLeaseOwner).not.toHaveBeenCalled();
    expect(mockForwardToInbox).not.toHaveBeenCalled();
});

test('forwards to the owner when another instance holds the lease', async () => {
    mockOwnership.getLeaseOwner.mockResolvedValue({ ownerId: 'other', hasPlayer: true });

    const { messageId, rawBody } = await deliver(chatMessage());

    expect(mockHandleChatMessage).not.toHaveBeenCalled();
    expect(mockForwardToInbox).toHaveBeenCalledWith('111', expect.objectContaining({
        messageId,
        payload: rawBody.toString('utf8'),
        isChat: true,
        targetOwner: 'other',
        timing: expect.objectContaining({ source: 'eventsub', claimedMs: expect.any(Number) }),
    }));
});

test('handles the event here when nobody owns the channel', async () => {
    await deliver(chatMessage());

    expect(mockHandleChatMessage).toHaveBeenCalledTimes(1);
    expect(mockForwardToInbox).not.toHaveBeenCalled();
});

test('fails open: a Firestore error while routing handles the event here', async () => {
    mockOwnership.getLeaseOwner.mockRejectedValue(new Error('unavailable'));

    await deliver(chatMessage());

    expect(mockHandleChatMessage).toHaveBeenCalledTimes(1);
});

test('a failed forward also falls back to handling the event here', async () => {
    mockOwnership.getLeaseOwner.mockResolvedValue({ ownerId: 'other', hasPlayer: true });
    mockForwardToInbox.mockRejectedValue(new Error('unavailable'));

    await deliver(chatMessage());

    expect(mockHandleChatMessage).toHaveBeenCalledTimes(1);
});

test('with ownership disabled nothing is looked up or forwarded', async () => {
    mockOwnership.isOwnershipEnabled.mockReturnValue(false);

    await deliver(chatMessage());

    expect(mockOwnership.getLeaseOwner).not.toHaveBeenCalled();
    expect(mockHandleChatMessage).toHaveBeenCalledTimes(1);
});

test('an inactive channel is not routed', async () => {
    mockIsChannelActive.mockReturnValue(false);

    await deliver(chatMessage());

    expect(mockOwnership.getLeaseOwner).not.toHaveBeenCalled();
    expect(mockForwardToInbox).not.toHaveBeenCalled();
});

test('raids route on the raided channel', () => {
    expect(resolveEventChannel({
        subscription: { type: 'channel.raid' },
        event: { from_broadcaster_user_id: '999', to_broadcaster_user_id: '111' },
    })).toBe('111');
    expect(resolveEventChannel(chatMessage('222'))).toBe('222');
    expect(resolveEventChannel({ subscription: { type: 'x' }, event: {} })).toBeNull();
});

test('a forwarded notification is processed on the owner with the inbox route in its timing', async () => {
    await handleForwardedNotification(chatMessage(), { source: 'eventsub', originMs: 1, forwardedMs: 2 });

    expect(mockHandleChatMessage).toHaveBeenCalledTimes(1);
    expect(timingSeenByHandler).toEqual(expect.objectContaining({
        source: 'eventsub',
        route: 'inbox',
        originMs: 1,
        forwardedMs: 2,
        inboxReceivedMs: expect.any(Number),
    }));
    expect(mockForwardToInbox).not.toHaveBeenCalled();
});
