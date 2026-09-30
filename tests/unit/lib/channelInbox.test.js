// tests/unit/lib/channelInbox.test.js
// Forwarding webhooks and handed-over queues to a channel's owner through Firestore.

import { jest } from '@jest/globals';
import { createFakeFirestore, flush } from '../../helpers/fakeFirestore.js';

jest.unstable_mockModule('../../../src/lib/logger.js', () => ({
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { createChannelInbox, MAX_CHAT_AGE_MS, MAX_EVENT_AGE_MS } = await import('../../../src/lib/channelInbox.js');

const ID = '111';
const EVENTS = `channelInbox/${ID}/inboxEvents`;

let db;
let clock;

function inbox(instanceId, owns = () => true) {
    return createChannelInbox({ getDb: () => db, instanceId, ownsBroadcaster: owns, now: () => clock.now });
}

const chat = text => JSON.stringify({ subscription: { type: 'channel.chat.message' }, event: { message: { text } } });

beforeEach(() => {
    db = createFakeFirestore();
    clock = { now: 5_000_000 };
});

test('the owner receives a forwarded event once, parsed, with its timing', async () => {
    const sender = inbox('a');
    const owner = inbox('b');
    const handler = jest.fn();
    owner.startInbox(ID, handler);

    await sender.forwardToInbox(ID, { messageId: 'm1', payload: chat('hi'), isChat: true, timing: { originMs: 1 } });
    await flush();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'notification',
        messageId: 'm1',
        payload: expect.objectContaining({ event: { message: { text: 'hi' } } }),
        timing: { originMs: 1, forwardedMs: clock.now },
        fromInstance: 'a',
    }));
    expect(db._paths()).toEqual([]);
    owner.stopAllInboxes();
});

test('two instances listening at once (a takeover in progress) process each event exactly once', async () => {
    const sender = inbox('a');
    const oldOwner = inbox('b');
    const newOwner = inbox('c');
    const handled = [];
    oldOwner.startInbox(ID, e => handled.push(['b', e.messageId]));
    newOwner.startInbox(ID, e => handled.push(['c', e.messageId]));

    await Promise.all(['m1', 'm2', 'm3', 'm4'].map(messageId =>
        sender.forwardToInbox(ID, { messageId, payload: chat(messageId) })));
    await flush();

    expect(handled.map(([, id]) => id).sort()).toEqual(['m1', 'm2', 'm3', 'm4']);
    oldOwner.stopAllInboxes();
    newOwner.stopAllInboxes();
});

test('an instance that no longer owns the channel leaves events for the next owner', async () => {
    const sender = inbox('a');
    const former = inbox('b', () => false);
    const handler = jest.fn();
    former.startInbox(ID, handler);

    await sender.forwardToInbox(ID, { messageId: 'm1', payload: chat('hi') });
    await flush();

    expect(handler).not.toHaveBeenCalled();
    expect(db._paths()).toEqual([`${EVENTS}/m1`]);
    former.stopAllInboxes();
});

test('events forwarded before the owner started listening arrive in its first snapshot', async () => {
    await inbox('a').forwardToInbox(ID, { messageId: 'm1', payload: chat('early') });
    const owner = inbox('b');
    const handler = jest.fn();

    owner.startInbox(ID, handler);
    await flush();

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'm1' }));
    owner.stopAllInboxes();
});

test('a retried delivery overwrites rather than duplicates', async () => {
    const sender = inbox('a');
    await sender.forwardToInbox(ID, { messageId: 'm1', payload: chat('hi') });
    await sender.forwardToInbox(ID, { messageId: 'm1', payload: chat('hi') });

    expect(db._paths()).toEqual([`${EVENTS}/m1`]);
});

test('stale events are claimed and dropped: chat after two minutes, anything else after ten', async () => {
    const sender = inbox('a');
    await sender.forwardToInbox(ID, { messageId: 'chat-old', payload: chat('x'), isChat: true });
    await sender.forwardToInbox(ID, { messageId: 'sub-ok', payload: '{}' });
    await sender.forwardToInbox(ID, { messageId: 'sub-old', payload: '{}' });
    db._seed(`${EVENTS}/sub-old`, { ...db._read(`${EVENTS}/sub-old`), enqueuedAt: new Date(clock.now - MAX_EVENT_AGE_MS) });
    clock.now += MAX_CHAT_AGE_MS + 1;

    const owner = inbox('b');
    const handler = jest.fn();
    owner.startInbox(ID, handler);
    await flush();

    expect(handler.mock.calls.map(([e]) => e.messageId)).toEqual(['sub-ok']);
    expect(db._paths()).toEqual([]);
    owner.stopAllInboxes();
});

test('a failed listener is forgotten, so the channel can be listened to again', async () => {
    const owner = inbox('b');
    owner.startInbox(ID, jest.fn());
    await flush();

    db._failListeners(new Error('stream broke'));
    expect(owner._inboxes.has(ID)).toBe(false);

    const handler = jest.fn();
    owner.startInbox(ID, handler);
    await inbox('a').forwardToInbox(ID, { messageId: 'm1', payload: chat('again') });
    await flush();
    expect(handler).toHaveBeenCalledTimes(1);
    owner.stopAllInboxes();
});
