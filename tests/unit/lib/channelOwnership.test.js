// tests/unit/lib/channelOwnership.test.js
// Several ownership instances share one fake Firestore to stand in for Cloud Run
// instances competing for the same channel's lease.

import { jest } from '@jest/globals';
import { createFakeFirestore, flush } from '../../helpers/fakeFirestore.js';

const mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.unstable_mockModule('../../../src/lib/logger.js', () => ({ default: mockLogger }));

const {
    createChannelOwnership,
    LEASE_TTL_MS,
    RENEW_INTERVAL_MS,
    SAFETY_MARGIN_MS,
    PLAYER_GRACE_MS,
} = await import('../../../src/lib/channelOwnership.js');

const ID = '111';
const NAME = 'parfaitfair';

let db;
let clock;
let enabled;
let instances;

/** Advances the clock by ms, sweeping on the real renewal cadence. */
async function runFor(ownership, ms) {
    const end = clock.now + ms;
    while (clock.now + RENEW_INTERVAL_MS <= end) {
        clock.now += RENEW_INTERVAL_MS;
        await ownership._sweep();
    }
    clock.now = end;
    await ownership._sweep();
}

function instance(name) {
    const ownership = createChannelOwnership({
        getDb: () => db,
        instanceId: name,
        isEnabled: () => enabled,
        now: () => clock.now,
    });
    instances.push(ownership);
    return ownership;
}

beforeEach(() => {
    db = createFakeFirestore();
    clock = { now: 1_000_000 };
    enabled = true;
    instances = [];
    jest.clearAllMocks();
});

afterEach(async () => {
    for (const o of instances) await o.stopChannelOwnership();
});

describe('claiming', () => {
    test('several instances race for one channel and exactly one wins', async () => {
        const racers = ['a', 'b', 'c', 'd', 'e'].map(instance);

        const results = await Promise.all(racers.map(o => o.claimChannel(ID, NAME, { hasPlayer: true })));

        const winners = results.filter(r => r.owned);
        expect(winners).toHaveLength(1);
        const winnerId = winners[0].ownerId;
        expect(db._read(`channelLeases/${ID}`).ownerId).toBe(winnerId);
        for (const o of racers) {
            expect(o.ownsBroadcaster(ID)).toBe(o.getInstanceId() === winnerId);
        }
    });

    test('renewing a held lease does not announce it again', async () => {
        const a = instance('a');
        const events = [];
        a.onOwnershipChange(e => events.push(e.type));

        await a.claimChannel(ID, NAME);
        await a.claimChannel(ID, NAME);

        expect(events).toEqual(['acquired']);
    });

    test('renewals keep the record of when and from whom the channel was acquired', async () => {
        const a = instance('a');
        const b = instance('b');
        await a.notePlayer(ID, NAME, true);
        await a.notePlayer(ID, NAME, false);
        await b.notePlayer(ID, NAME, true);
        const { acquiredAt } = db._read(`channelLeases/${ID}`);

        clock.now += RENEW_INTERVAL_MS;
        await b.claimChannel(ID, NAME, { hasPlayer: true });
        await b.claimChannel(ID, NAME, { hasPlayer: false });

        const lease = db._read(`channelLeases/${ID}`);
        expect(lease.previousOwnerId).toBe('a');
        expect(lease.acquiredAt.getTime()).toBe(acquiredAt.getTime());
        expect(lease.renewedAt.getTime()).toBe(clock.now);
    });

    test('stops acting SAFETY_MARGIN_MS before the lease could expire', async () => {
        const a = instance('a');
        await a.claimChannel(ID, NAME);

        clock.now += LEASE_TTL_MS - SAFETY_MARGIN_MS - 1;
        expect(a.ownsBroadcaster(ID)).toBe(true);
        clock.now += 1;
        expect(a.ownsBroadcaster(ID)).toBe(false);
    });

    test('an expired lease can be taken, and the old holder drops it at its next sweep', async () => {
        const a = instance('a');
        const b = instance('b');
        const lost = [];
        a.onOwnershipChange(e => { if (e.type === 'lost') lost.push(e.reason); });

        await a.claimChannel(ID, NAME);
        clock.now += LEASE_TTL_MS + 1; // a stopped renewing: frozen, crashed, partitioned

        expect((await b.claimChannel(ID, NAME)).owned).toBe(true);
        await flush();
        await a._sweep();

        expect(a.ownsBroadcaster(ID)).toBe(false);
        expect(lost).toHaveLength(1);
        expect(['lapsed', 'taken']).toContain(lost[0]);
    });
});

describe('the browser source decides the owner', () => {
    test('an instance with the player takes over from a holder whose player left', async () => {
        const a = instance('a');
        const b = instance('b');
        const lost = [];
        a.onOwnershipChange(e => { if (e.type === 'lost') lost.push(e.reason); });

        await a.notePlayer(ID, NAME, true);
        await a.notePlayer(ID, NAME, false); // last source on a disconnected
        expect(db._read(`channelLeases/${ID}`).hasPlayer).toBe(false);

        await b.notePlayer(ID, NAME, true); // and reconnected to b
        await flush();

        expect(b.ownsBroadcaster(ID)).toBe(true);
        expect(a.ownsBroadcaster(ID)).toBe(false);
        expect(lost).toEqual(['taken']);
    });

    test('a second player on another instance does not take the channel from one that has a player', async () => {
        const a = instance('a');
        const b = instance('b');

        await a.notePlayer(ID, NAME, true);
        await b.notePlayer(ID, NAME, true);

        expect(a.ownsBroadcaster(ID)).toBe(true);
        expect(b.ownsBroadcaster(ID)).toBe(false);
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ logKey: 'PLAYER_ON_NON_OWNER', ownerId: 'a' }),
            expect.any(String)
        );
    });

    test('an instance without a player cannot take over a live lease', async () => {
        const a = instance('a');
        const b = instance('b');

        await a.notePlayer(ID, NAME, true);
        await a.notePlayer(ID, NAME, false);

        expect((await b.claimChannel(ID, NAME, { hasPlayer: false })).owned).toBe(false);
    });

    test('keeps the lease through the grace period, then releases it', async () => {
        const a = instance('a');
        let players = [{ broadcasterId: ID, channelName: NAME }];
        await a.startChannelOwnership({ getPlayerChannels: () => players });
        expect(a.ownsBroadcaster(ID)).toBe(true);

        players = [];
        await a.notePlayer(ID, NAME, false);
        await runFor(a, PLAYER_GRACE_MS - 1);
        expect(a.ownsBroadcaster(ID)).toBe(true);

        await runFor(a, 1);
        expect(a.ownsBroadcaster(ID)).toBe(false);
        expect(db._read(`channelLeases/${ID}`)).toBeUndefined();
    });

    test('a player returning within the grace period keeps the channel', async () => {
        const a = instance('a');
        let players = [{ broadcasterId: ID, channelName: NAME }];
        await a.startChannelOwnership({ getPlayerChannels: () => players });

        players = [];
        await a.notePlayer(ID, NAME, false);
        await runFor(a, PLAYER_GRACE_MS / 2);
        players = [{ broadcasterId: ID, channelName: NAME }];
        await a.notePlayer(ID, NAME, true);
        await runFor(a, PLAYER_GRACE_MS);

        expect(a.ownsBroadcaster(ID)).toBe(true);
        expect(db._read(`channelLeases/${ID}`).hasPlayer).toBe(true);
    });

    test('the sweep picks up a channel whose player is here once the other holder is gone', async () => {
        const a = instance('a');
        const b = instance('b');
        await a.notePlayer(ID, NAME, true);
        await b.startChannelOwnership({ getPlayerChannels: () => [{ broadcasterId: ID, channelName: NAME }] });
        expect(b.ownsBroadcaster(ID)).toBe(false);

        clock.now += LEASE_TTL_MS + 1; // a died without releasing
        await b._sweep();

        expect(b.ownsBroadcaster(ID)).toBe(true);
    });
});

describe('release', () => {
    test('the lease is deleted before listeners stop the inbox, so peers stop forwarding first', async () => {
        const a = instance('a');
        const seenDuringLost = [];
        a.onOwnershipChange(e => {
            if (e.type === 'lost') seenDuringLost.push(db._read(`channelLeases/${ID}`));
        });

        await a.claimChannel(ID, NAME);
        await a.stopChannelOwnership();

        expect(seenDuringLost).toEqual([undefined]);
        expect(a.ownsBroadcaster(ID)).toBe(false);
    });

    test('keeps acting until the lease is gone: owns the channel while the delete is in flight', async () => {
        const a = instance('a');
        await a.claimChannel(ID, NAME);
        let ownedDuringDelete;
        const realTransaction = db.runTransaction;
        db.runTransaction = fn => {
            ownedDuringDelete = a.ownsBroadcaster(ID);
            return realTransaction(fn);
        };

        await a.stopChannelOwnership();

        expect(ownedDuringDelete).toBe(true);
    });

    test('a player that reconnects while the release is in flight keeps the channel', async () => {
        const a = instance('a');
        let players = [{ broadcasterId: ID, channelName: NAME }];
        await a.startChannelOwnership({ getPlayerChannels: () => players });
        const lost = [];
        a.onOwnershipChange(e => { if (e.type === 'lost') lost.push(e.reason); });

        players = [];
        await a.notePlayer(ID, NAME, false);
        clock.now += RENEW_INTERVAL_MS;
        await a._sweep();
        clock.now += PLAYER_GRACE_MS - RENEW_INTERVAL_MS;
        const realTransaction = db.runTransaction;
        let reconnected = false;
        db.runTransaction = async fn => {
            const result = await realTransaction(fn);
            if (!reconnected) {
                reconnected = true;
                players = [{ broadcasterId: ID, channelName: NAME }];
                db.runTransaction = realTransaction;
                await a.notePlayer(ID, NAME, true);
            }
            return result;
        };
        await a._sweep();

        expect(a.ownsBroadcaster(ID)).toBe(true);
        expect(db._read(`channelLeases/${ID}`)).toEqual(expect.objectContaining({ ownerId: 'a', hasPlayer: true }));
        expect(lost).toEqual([]);
    });

    test('after shutdown begins, a closing socket cannot re-claim', async () => {
        const a = instance('a');
        await a.claimChannel(ID, NAME);
        await a.stopChannelOwnership();

        await a.notePlayer(ID, NAME, false);
        expect((await a.claimChannel(ID, NAME)).owned).toBe(false);
        expect(db._read(`channelLeases/${ID}`)).toBeUndefined();
    });
});

describe('shutdown and in-flight claims', () => {
    test('a claim in flight when shutdown begins does not leave a lease behind', async () => {
        const a = instance('a');

        const claim = a.claimChannel(ID, NAME, { hasPlayer: true });
        await a.stopChannelOwnership();
        await claim;

        expect(db._read(`channelLeases/${ID}`)).toBeUndefined();
        expect(a.ownsBroadcaster(ID)).toBe(false);
    });

    test('a renewal in flight when shutdown begins does not write the released lease back', async () => {
        const a = instance('a');
        await a.claimChannel(ID, NAME, { hasPlayer: true });

        const renewal = a.claimChannel(ID, NAME, { hasPlayer: false });
        await a.stopChannelOwnership();
        await renewal;

        expect(db._read(`channelLeases/${ID}`)).toBeUndefined();
    });

    test('a claim that committed before shutdown is released by it', async () => {
        const a = instance('a');
        const lost = [];
        a.onOwnershipChange(e => { if (e.type === 'lost') lost.push(e.reason); });

        const claim = a.claimChannel(ID, NAME, { hasPlayer: true });
        await flush(); // the transaction commits before shutdown starts
        await a.stopChannelOwnership();
        await claim;

        expect(db._read(`channelLeases/${ID}`)).toBeUndefined();
        expect(lost).toEqual(['shutdown']);
    });
});

describe('a player reconnecting just before the grace release', () => {
    test('keeps the lease when the reconnect is written before the release transaction runs', async () => {
        const a = instance('a');
        let players = [{ broadcasterId: ID, channelName: NAME }];
        await a.startChannelOwnership({ getPlayerChannels: () => players });
        const lost = [];
        a.onOwnershipChange(e => { if (e.type === 'lost') lost.push(e.reason); });

        players = [];
        await a.notePlayer(ID, NAME, false);
        await runFor(a, PLAYER_GRACE_MS - 1);

        // The sweep decides to release (no player in its snapshot), but the
        // source reconnects and re-marks the lease before the delete runs.
        clock.now += 1;
        const realTransaction = db.runTransaction;
        db.runTransaction = async fn => {
            db.runTransaction = realTransaction;
            await a.notePlayer(ID, NAME, true);
            return realTransaction(fn);
        };
        await a._sweep();

        expect(db._read(`channelLeases/${ID}`)).toEqual(expect.objectContaining({ ownerId: 'a', hasPlayer: true }));
        expect(a.ownsBroadcaster(ID)).toBe(true);
        expect(lost).toEqual([]);
    });
});

describe('disabled', () => {
    test('owns every channel and touches no Firestore', async () => {
        enabled = false;
        const a = instance('a');

        expect(a.ownsBroadcaster('anything')).toBe(true);
        expect((await a.claimChannel(ID, NAME)).owned).toBe(true);
        await a.notePlayer(ID, NAME, true);
        await a.startChannelOwnership({ getPlayerChannels: () => [{ broadcasterId: ID, channelName: NAME }] });

        expect(db._paths()).toEqual([]);
    });
});
