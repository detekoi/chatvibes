// tests/unit/ttsDispatch.test.js
// Routing decision only: does the event go straight into the local queue, or out
// over Pub/Sub? Getting this wrong either adds a round trip of latency to every
// message or drops audio for a listener attached to another instance.

import { jest } from '@jest/globals';
import { createMockFirestore, FieldValue } from '../helpers/mockFirestore.js';

let mockHasActiveClients;
let mockPublishTtsEvent;
let mockEnqueue;
let mockClaimOnce;
let dispatchTtsEvent;
let dispatchYouTubeTtsEvent;

const EVENT = { text: 'hello', user: 'someone', userId: '123', type: 'chat', messageId: 'msg-1' };
const YT_EVENT = { text: 'hi', user: 'ytviewer', userId: 'UC1', type: 'chat', messageId: 'yt-abc', platform: 'youtube' };

beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.useRealTimers();

    mockHasActiveClients = jest.fn().mockReturnValue(false);
    mockPublishTtsEvent = jest.fn().mockResolvedValue('pubsub-id');
    mockEnqueue = jest.fn().mockResolvedValue(undefined);
    mockClaimOnce = jest.fn().mockResolvedValue(true);

    jest.unstable_mockModule('../../src/lib/logger.js', () => ({
        default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    }));
    jest.unstable_mockModule('@google-cloud/firestore', () => ({
        Firestore: jest.fn(() => createMockFirestore()),
        FieldValue,
        Timestamp: { fromMillis: ms => ({ toMillis: () => ms }) }
    }));
    jest.unstable_mockModule('../../src/lib/pubsub.js', () => ({
        publishTtsEvent: mockPublishTtsEvent
    }));
    jest.unstable_mockModule('../../src/components/web/server.js', () => ({
        hasActiveClients: mockHasActiveClients
    }));
    jest.unstable_mockModule('../../src/components/tts/ttsQueue.js', () => ({
        enqueue: mockEnqueue
    }));
    jest.unstable_mockModule('../../src/lib/firestoreClaim.js', () => ({
        claimOnce: mockClaimOnce,
        ALREADY_EXISTS: 6,
        isClaimExpired: jest.fn(() => true)
    }));

    ({ dispatchTtsEvent, dispatchYouTubeTtsEvent } = await import('../../src/lib/ttsDispatch.js'));
});

describe('dispatchTtsEvent', () => {
    test('enqueues locally and skips Pub/Sub when this instance holds the client', async () => {
        mockHasActiveClients.mockReturnValue(true);

        await dispatchTtsEvent('somechannel', EVENT);

        expect(mockEnqueue).toHaveBeenCalledWith('somechannel', EVENT, null);
        expect(mockPublishTtsEvent).not.toHaveBeenCalled();
    });

    test('publishes when no client for the channel is attached here', async () => {
        mockHasActiveClients.mockReturnValue(false);

        await dispatchTtsEvent('somechannel', EVENT);

        expect(mockPublishTtsEvent).toHaveBeenCalledWith('somechannel', EVENT, null);
        expect(mockEnqueue).not.toHaveBeenCalled();
    });

    test('enqueues locally when a shared-chat participant is attached here', async () => {
        // The originating channel has no client on this instance, but a channel it is
        // sharing chat with does — the audio still needs to play here.
        const shared = { sessionId: 's1', channels: ['other', 'local'] };
        mockHasActiveClients.mockImplementation(ch => ch === 'local');

        await dispatchTtsEvent('somechannel', EVENT, shared);

        expect(mockEnqueue).toHaveBeenCalledWith('somechannel', EVENT, shared);
        expect(mockPublishTtsEvent).not.toHaveBeenCalled();
    });

    test('publishes when no shared-chat participant is attached here', async () => {
        const shared = { sessionId: 's1', channels: ['other', 'elsewhere'] };
        mockHasActiveClients.mockReturnValue(false);

        await dispatchTtsEvent('somechannel', EVENT, shared);

        expect(mockPublishTtsEvent).toHaveBeenCalledWith('somechannel', EVENT, shared);
        expect(mockEnqueue).not.toHaveBeenCalled();
    });

    test('publishes when sharedSessionInfo has no channels array', async () => {
        mockHasActiveClients.mockReturnValue(false);

        await dispatchTtsEvent('somechannel', EVENT, { sessionId: 's1' });

        expect(mockPublishTtsEvent).toHaveBeenCalled();
        expect(mockEnqueue).not.toHaveBeenCalled();
    });
});

describe('dispatchYouTubeTtsEvent', () => {
    // Unlike a Twitch webhook, the chat proxy broadcasts every message to every
    // instance, so YouTube needs its own claim before it can use the local path.

    test('claims on the YouTube message id and enqueues locally when serving here', async () => {
        mockHasActiveClients.mockReturnValue(true);

        const result = await dispatchYouTubeTtsEvent('12345', YT_EVENT);

        expect(result).toBe(true);
        expect(mockClaimOnce).toHaveBeenCalledTimes(1);
        expect(mockClaimOnce.mock.calls[0][1]).toMatchObject({ channel: '12345', messageId: 'yt-abc' });
        expect(mockEnqueue).toHaveBeenCalledWith('12345', YT_EVENT, null);
        expect(mockPublishTtsEvent).not.toHaveBeenCalled();
    });

    test('stops entirely when another instance already claimed the message', async () => {
        mockHasActiveClients.mockReturnValue(true);
        mockClaimOnce.mockResolvedValue(false);

        const result = await dispatchYouTubeTtsEvent('12345', YT_EVENT);

        expect(result).toBe(false);
        expect(mockEnqueue).not.toHaveBeenCalled();
        expect(mockPublishTtsEvent).not.toHaveBeenCalled();
    });

    test('publishes after claiming when no browser source is attached here', async () => {
        mockHasActiveClients.mockReturnValue(false);

        await dispatchYouTubeTtsEvent('12345', YT_EVENT);

        expect(mockClaimOnce).toHaveBeenCalledTimes(1);
        expect(mockPublishTtsEvent).toHaveBeenCalledWith('12345', YT_EVENT, null);
        expect(mockEnqueue).not.toHaveBeenCalled();
    });

    test('claims immediately when serving here, and waits first when not', async () => {
        // The handicap is what makes the instance that can actually play the audio
        // win the race, instead of the winner being one-in-N.
        mockHasActiveClients.mockReturnValue(true);
        const fastStart = Date.now();
        await dispatchYouTubeTtsEvent('12345', YT_EVENT);
        const fastMs = Date.now() - fastStart;

        jest.clearAllMocks();
        mockClaimOnce.mockResolvedValue(true);
        mockHasActiveClients.mockReturnValue(false);
        const slowStart = Date.now();
        await dispatchYouTubeTtsEvent('12345', YT_EVENT);
        const slowMs = Date.now() - slowStart;

        expect(fastMs).toBeLessThan(100);
        expect(slowMs).toBeGreaterThanOrEqual(250);
    });

    test('falls back to publishing when the message carries no id to claim on', async () => {
        // Without a stable key there is nothing to deduplicate on, so the Pub/Sub
        // claim — which hashes the text instead — stays as the last guard.
        mockHasActiveClients.mockReturnValue(true);

        const result = await dispatchYouTubeTtsEvent('12345', { ...YT_EVENT, messageId: null });

        expect(result).toBe(true);
        expect(mockClaimOnce).not.toHaveBeenCalled();
        expect(mockPublishTtsEvent).toHaveBeenCalled();
        expect(mockEnqueue).not.toHaveBeenCalled();
    });
});
