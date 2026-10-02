// tests/unit/eventsubHighlightPipeline.test.js
// A "Highlight My Message" chat message from the webhook to the TTS dispatch.
//
// The payload follows Twitch's channel.chat.message v1 reference: a highlight
// is an ordinary chat message whose message_type is
// "channel_points_highlighted", with channel_points_custom_reward_id null. It
// goes through the real signature check, the real router and the real chat
// handler, and once more as the JSON text the channel inbox carries to the
// instance that owns the channel, so message_type has to survive that trip.

import crypto from 'crypto';
import { jest } from '@jest/globals';
import { createMockFirestore, FieldValue } from '../helpers/mockFirestore.js';

const SECRET = 'test-eventsub-secret';
const mockDispatchTtsEvent = jest.fn().mockResolvedValue(true);
const mockGetTtsState = jest.fn();
const mockProcessMessage = jest.fn().mockResolvedValue(null);

jest.unstable_mockModule('../../src/config/index.js', () => ({
    default: { twitch: { eventSubSecret: SECRET, username: 'wildcatbot' } },
}));
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
jest.unstable_mockModule('../../src/lib/allowList.js', () => ({ isChannelActive: () => true }));
jest.unstable_mockModule('../../src/lib/channelOwnership.js', () => ({
    isOwnershipEnabled: () => false,
    ownsBroadcaster: () => true,
    getLeaseOwner: jest.fn().mockResolvedValue(null),
}));
jest.unstable_mockModule('../../src/lib/channelInbox.js', () => ({ forwardToInbox: jest.fn() }));
jest.unstable_mockModule('../../src/components/tts/ttsState.js', () => ({
    getTtsState: mockGetTtsState,
    getUserEmoteModePreference: jest.fn().mockResolvedValue(null),
}));
jest.unstable_mockModule('../../src/components/commands/commandProcessor.js', () => ({
    processMessage: mockProcessMessage,
    hasPermission: jest.fn().mockReturnValue(false),
}));
jest.unstable_mockModule('../../src/lib/ttsDispatch.js', () => ({ dispatchTtsEvent: mockDispatchTtsEvent }));
jest.unstable_mockModule('../../src/components/twitch/eventUtils.js', () => ({
    getSharedSessionInfo: jest.fn().mockResolvedValue(null),
}));
jest.unstable_mockModule('../../src/lib/emotes/index.js', () => ({
    isGeminiAvailable: () => false,
    processMessageWithEmoteDescriptions: jest.fn(),
}));
jest.unstable_mockModule('../../src/components/twitch/handlers/redemptionHandler.js', () => ({
    handleChannelPointsRedemption: jest.fn(),
    handleRedemptionAnnouncement: jest.fn(),
}));
jest.unstable_mockModule('../../src/components/twitch/handlers/notificationHandler.js', () => ({
    handleNotification: jest.fn(),
    WATCH_STREAK_TYPE: 'x.watch_streak',
    SUB_GIFT_TYPE: 'x.sub_gift',
    COMMUNITY_SUB_GIFT_TYPE: 'x.community_sub_gift',
}));
jest.unstable_mockModule('../../src/components/twitch/handlers/sharedChatHandler.js', () => ({
    onBegin: jest.fn(), onUpdate: jest.fn(), onEnd: jest.fn(),
}));

const { eventSubHandler, handleForwardedNotification } = await import('../../src/components/twitch/eventsub.js');

// Shape of a channel.chat.message v1 notification, per Twitch's EventSub reference.
const highlightNotification = () => ({
    subscription: {
        id: '0b7f3361-672b-4d39-b307-dd5b576c9b27',
        status: 'enabled',
        type: 'channel.chat.message',
        version: '1',
        condition: { broadcaster_user_id: '1971641', user_id: '2914196' },
        transport: { method: 'webhook', callback: 'https://example.com/twitch/event' },
        created_at: '2026-10-02T18:11:47.492253549Z',
        cost: 0,
    },
    event: {
        broadcaster_user_id: '1971641',
        broadcaster_user_login: 'streamer',
        broadcaster_user_name: 'streamer',
        chatter_user_id: '4145994',
        chatter_user_login: 'viewer32',
        chatter_user_name: 'viewer32',
        message_id: 'cc106a89-1814-919d-454c-f4f2f970aae7',
        message: {
            text: 'Hi chat, look at me',
            fragments: [{ type: 'text', text: 'Hi chat, look at me', cheermote: null, emote: null, mention: null }],
        },
        color: '#00FF7F',
        badges: [],
        message_type: 'channel_points_highlighted',
        cheer: null,
        reply: null,
        channel_points_custom_reward_id: null,
        channel_points_animation_id: null,
        source_broadcaster_user_id: null,
        source_broadcaster_user_login: null,
        source_broadcaster_user_name: null,
        source_message_id: null,
        source_badges: null,
    },
});

let counter = 0;
async function deliver(notification, { sign = true } = {}) {
    const messageId = `hl-${++counter}`;
    const timestamp = new Date().toISOString();
    const rawBody = Buffer.from(JSON.stringify(notification));
    const signature = 'sha256=' + crypto.createHmac('sha256', sign ? SECRET : 'wrong')
        .update(messageId + timestamp + rawBody).digest('hex');
    let status = null;
    const res = { writeHead: (code) => { status = code; return { end: () => {} }; } };
    await eventSubHandler({
        headers: {
            'twitch-eventsub-message-id': messageId,
            'twitch-eventsub-message-timestamp': timestamp,
            'twitch-eventsub-message-signature': signature,
            'twitch-eventsub-message-type': 'notification',
        },
    }, res, rawBody);
    return status;
}

const spoken = () => mockDispatchTtsEvent.mock.calls.map(c => [c[0], c[1]]);

beforeEach(() => {
    jest.clearAllMocks();
    mockGetTtsState.mockResolvedValue({
        engineEnabled: true, mode: 'highlighted_only', emoteMode: 'read', ttsPermissionLevel: 'mods',
    });
});

test('a signed highlight webhook is spoken as a highlight in highlighted_only mode', async () => {
    await deliver(highlightNotification());
    expect(spoken()).toEqual([[
        'streamer',
        expect.objectContaining({
            type: 'highlight',
            text: 'Hi chat, look at me',
            user: 'viewer32',
            userId: '4145994',
            messageId: 'cc106a89-1814-919d-454c-f4f2f970aae7',
        }),
    ]]);
});

test('a forwarded highlight keeps message_type through the inbox JSON and is spoken on the owner', async () => {
    const payload = JSON.stringify(highlightNotification());
    await handleForwardedNotification(JSON.parse(payload), { source: 'eventsub', originMs: 1, forwardedMs: 2 });
    expect(spoken()).toHaveLength(1);
    expect(spoken()[0][1]).toMatchObject({ type: 'highlight' });
});

test('a webhook with a bad signature is refused and nothing is spoken', async () => {
    const status = await deliver(highlightNotification(), { sign: false });
    expect(status).toBe(403);
    expect(spoken()).toEqual([]);
});

test('the same payload as plain chat (message_type "text") stays silent', async () => {
    const n = highlightNotification();
    n.event.message_type = 'text';
    await deliver(n);
    expect(spoken()).toEqual([]);
});

test('the same highlight is not spoken in command mode', async () => {
    mockGetTtsState.mockResolvedValue({ engineEnabled: true, mode: 'command', emoteMode: 'read' });
    await deliver(highlightNotification());
    expect(spoken()).toEqual([]);
});
