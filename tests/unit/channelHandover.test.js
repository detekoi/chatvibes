// tests/unit/channelHandover.test.js
// What moves when a channel changes owner: the pending queue goes to the inbox on
// loss, is adopted from it on the other side, and a queue persisted at shutdown
// is restored by whichever instance takes the channel.

import { jest } from '@jest/globals';
import { createFakeFirestore, flush } from '../helpers/fakeFirestore.js';

const db = { current: null };
let ownershipListener;
let inboxHandler;
const mockForwardToInbox = jest.fn();
const mockStartInbox = jest.fn((id, handler) => { inboxHandler = handler; });
const mockStopInbox = jest.fn();
const mockGenerateSpeech = jest.fn();

jest.unstable_mockModule('../../src/lib/logger.js', () => ({
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule('@google-cloud/firestore', () => ({
    // ttsQueue keeps the first client it creates, so delegate to each test's fake.
    Firestore: jest.fn(() => ({
        collection: name => db.current.collection(name),
        runTransaction: fn => db.current.runTransaction(fn),
    })),
    Timestamp: class {},
}));
jest.unstable_mockModule('../../src/lib/channelOwnership.js', () => ({
    isOwnershipEnabled: () => true,
    onOwnershipChange: listener => { ownershipListener = listener; return () => {}; },
}));
jest.unstable_mockModule('../../src/lib/channelInbox.js', () => ({
    forwardToInbox: mockForwardToInbox,
    startInbox: mockStartInbox,
    stopInbox: mockStopInbox,
    stopAllInboxes: jest.fn(),
}));
jest.unstable_mockModule('../../src/lib/allowList.js', () => ({
    resolveToChannelName: id => (String(id) === '111' ? 'parfaitfair' : String(id).toLowerCase()),
    getChannelIdFromName: name => ({ parfaitfair: '111', otherchan: '222' })[name],
    getChannelNameFromId: id => ({ 111: 'parfaitfair', 222: 'otherchan' })[id],
}));
jest.unstable_mockModule('../../src/components/tts/ttsService.js', () => ({ generateSpeech: mockGenerateSpeech }));
// No browser source attached here, so processQueue leaves items where they are.
jest.unstable_mockModule('../../src/components/web/server.js', () => ({
    sendAudioToChannel: jest.fn(),
    hasActiveClients: () => false,
    channelPrefersUrlAudio: () => false,
    openClipStream: () => null,
    STOP_CURRENT_AUDIO: 'STOP_CURRENT_AUDIO',
}));
jest.unstable_mockModule('../../src/components/tts/ttsState.js', () => ({
    getTtsState: jest.fn(), getChannelTtsConfig: jest.fn(),
    getGlobalUserPreferences: jest.fn(), getChannelUserPreferences: jest.fn(),
}));

const ttsQueue = await import('../../src/components/tts/ttsQueue.js');
const { wireChannelHandover, handOffRemainingQueues } = await import('../../src/lib/channelHandover.js');

const item = (text, extra = {}) => ({
    type: 'chat', text, user: 'viewer', userId: '42',
    voiceConfig: { voiceId: 'v', emotion: 'neutral', languageBoost: 'auto' },
    timestamp: '2026-09-29T12:00:00.000Z', ...extra,
});

const onNotification = jest.fn();
wireChannelHandover({ onNotification });

beforeEach(() => {
    db.current = createFakeFirestore();
    jest.clearAllMocks();
    mockForwardToInbox.mockResolvedValue(undefined);
    for (const name of ['parfaitfair', 'otherchan']) {
        const cq = ttsQueue.getOrCreateChannelQueue(name);
        cq.queue = [];
        cq.isPaused = false;
    }
});

test('losing a channel hands its pending clips and pause to the inbox', async () => {
    ttsQueue.adoptQueue('parfaitfair', { items: [item('one'), item('two')], isPaused: true });

    await ownershipListener({ type: 'lost', broadcasterId: '111', channelName: 'parfaitfair', reason: 'no-player' });

    expect(mockStopInbox).toHaveBeenCalledWith('111');
    expect(mockForwardToInbox).toHaveBeenCalledWith('111', expect.objectContaining({ kind: 'queueHandoff' }));
    const handoff = JSON.parse(mockForwardToInbox.mock.calls[0][1].payload);
    expect(handoff.isPaused).toBe(true);
    expect(handoff.items.map(i => i.text)).toEqual(['one', 'two']);
    expect(ttsQueue.getOrCreateChannelQueue('parfaitfair').queue).toEqual([]);
});

test('the handoff carries the login, and the new owner uses it for a channel it cannot map yet', async () => {
    ttsQueue.adoptQueue('parfaitfair', { items: [item('one')] });
    await ownershipListener({ type: 'lost', broadcasterId: '111', channelName: 'parfaitfair', reason: 'taken' });
    const handoff = JSON.parse(mockForwardToInbox.mock.calls[0][1].payload);
    expect(handoff.channelName).toBe('parfaitfair');

    // '333' was added after this instance loaded its allow-list: no local mapping.
    await ownershipListener({ type: 'acquired', broadcasterId: '333', channelName: 'newchan' });
    await inboxHandler({ kind: 'queueHandoff', payload: { ...handoff, channelName: 'newchan' } });

    expect(ttsQueue.getOrCreateChannelQueue('newchan').queue.map(i => i.text)).toEqual(['one']);
    expect(ttsQueue.getOrCreateChannelQueue('333').queue).toEqual([]);
});

test('a channel with nothing queued and no pause hands nothing over', async () => {
    await ownershipListener({ type: 'lost', broadcasterId: '111', channelName: 'parfaitfair', reason: 'shutdown' });
    expect(mockForwardToInbox).not.toHaveBeenCalled();
});

test('when the handoff cannot be written the clips stay here', async () => {
    ttsQueue.adoptQueue('parfaitfair', { items: [item('one')] });
    mockForwardToInbox.mockRejectedValue(new Error('unavailable'));

    await ownershipListener({ type: 'lost', broadcasterId: '111', channelName: 'parfaitfair', reason: 'taken' });

    expect(ttsQueue.getOrCreateChannelQueue('parfaitfair').queue.map(i => i.text)).toEqual(['one']);
});

test('the new owner puts handed-over clips ahead of ones it queued since, and keeps the pause', async () => {
    await ownershipListener({ type: 'acquired', broadcasterId: '111', channelName: 'parfaitfair' });
    expect(mockStartInbox).toHaveBeenCalledWith('111', expect.any(Function));
    ttsQueue.adoptQueue('parfaitfair', { items: [item('newer')] });

    await inboxHandler({ kind: 'queueHandoff', payload: { items: [item('older')], isPaused: true } });

    const cq = ttsQueue.getOrCreateChannelQueue('parfaitfair');
    expect(cq.queue.map(i => i.text)).toEqual(['older', 'newer']);
    expect(cq.queue[0].timestamp).toBeInstanceOf(Date);
    expect(cq.isPaused).toBe(true);
});

test('forwarded notifications go to the notification handler with their timing', async () => {
    await ownershipListener({ type: 'acquired', broadcasterId: '111', channelName: 'parfaitfair' });
    const notification = { subscription: { type: 'channel.chat.message' } };

    await inboxHandler({ kind: 'notification', payload: notification, timing: { originMs: 1 } });

    expect(onNotification).toHaveBeenCalledWith(notification, { originMs: 1 });
});

test('taking a channel restores the queue a shutdown persisted for it, once', async () => {
    db.current._seed('ttsQueuePersistence/111', { channelName: 'parfaitfair', queue: [item('saved')], isPaused: false });

    await ownershipListener({ type: 'acquired', broadcasterId: '111', channelName: 'parfaitfair' });
    await flush();

    expect(ttsQueue.getOrCreateChannelQueue('parfaitfair').queue.map(i => i.text)).toEqual(['saved']);
    expect(db.current._read('ttsQueuePersistence/111')).toBeUndefined();
});

test('shutdown hands over queues for channels this instance did not own too', async () => {
    ttsQueue.adoptQueue('otherchan', { items: [item('via pubsub')] });

    await handOffRemainingQueues();

    expect(mockForwardToInbox).toHaveBeenCalledWith('222', expect.objectContaining({ kind: 'queueHandoff' }));
});
