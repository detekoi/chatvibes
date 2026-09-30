// src/lib/channelOwnership.js
// Assigns each channel to exactly one bot instance: the one holding its browser source.
//
// Cloud Run runs several instances at once and spreads Twitch's webhooks across
// them, but a channel's TTS queue — pending clips, `!tts pause`, who is speaking,
// redemptions waiting for approval — lives in memory, and its audio can only
// leave over the OBS browser source's WebSocket, which is attached to a single
// instance. So a channel is leased to the instance holding that socket, and
// webhooks that land anywhere else are forwarded to it through channelInbox.js.
//
// This differs from the ownership scheme in twitch-knowledge-bot, where any
// instance may own a channel and the first to see a webhook claims it. Here an
// owner without the player could queue clips but never play them, and with
// request-based CPU an instance with no open request is starved between
// webhooks. The player's socket is an open request, so the owner always has CPU.
//
// Layout: channelLeases/{broadcasterId}
//   { ownerId, channelName, hasPlayer, expiresAt, renewedAt, acquiredAt, previousOwnerId }
//
// The holder renews every RENEW_INTERVAL_MS while a player is connected; a lease
// nobody renews expires after LEASE_TTL_MS. When the last player disconnects the
// lease is kept for PLAYER_GRACE_MS, so a browser source that reconnects to the
// same instance (session affinity) finds its queue where it left it, but it is
// marked `hasPlayer: false` straight away: an instance that does have the player
// may take such a lease over rather than wait out the grace. `expiresAt` wants a
// Firestore TTL policy to reap leases left by instances that died without
// releasing them; the code never depends on that sweep, it compares `expiresAt`
// itself.
//
// When ownership is disabled (local dev, tests) every check reports that this
// process owns every channel, which is exactly the single-process behaviour.

import { Firestore } from '@google-cloud/firestore';
import logger from './logger.js';
import config from '../config/index.js';
import { INSTANCE_ID } from './instanceId.js';

const LEASES_COLLECTION = 'channelLeases';

export const LEASE_TTL_MS = 30 * 1000;
export const RENEW_INTERVAL_MS = 10 * 1000;
// Stop acting this long before the lease can expire, so a slow renewal or a
// little clock skew between instances never leaves two owners acting at once.
export const SAFETY_MARGIN_MS = 5 * 1000;
// How long a lease outlives the channel's last player on this instance. No
// longer than the TTL: with request-based CPU an instance whose player has gone
// may have no open request, its renewals stall, and the lease runs out anyway.
export const PLAYER_GRACE_MS = 30 * 1000;

function toMillis(value) {
    if (!value) return 0;
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (value instanceof Date) return value.getTime();
    return Number(value) || 0;
}

/**
 * One instance's view of the channel leases. The module exports a default
 * instance bound to the real Firestore; tests create several against a fake
 * one to stand in for competing Cloud Run instances.
 *
 * @param {object} opts
 * @param {() => FirebaseFirestore.Firestore} opts.getDb
 * @param {string} opts.instanceId
 * @param {() => boolean} opts.isEnabled
 * @param {() => number} [opts.now]
 */
export function createChannelOwnership({ getDb, instanceId, isEnabled, now = Date.now }) {
    // broadcasterId -> { channelName, deadlineMs, hasPlayer, playerGoneAtMs }
    const owned = new Map();
    // broadcasterId -> Promise, so concurrent claims of one channel share a transaction
    const inFlight = new Map();
    const changeListeners = new Set();
    // Channels whose player is attached here while another instance's player holds
    // the lease; logged once per episode rather than on every sweep.
    const reportedSecondPlayer = new Set();

    let intervalId = null;
    let sweepInProgress = false;
    // Set by stopChannelOwnership, so a socket closing during shutdown cannot
    // re-claim a lease that was just handed back.
    let stopping = false;
    let getPlayerChannels = () => [];

    // broadcasterId -> unsubscribe, for the lease documents this instance holds
    const leaseWatchers = new Map();

    const leaseRef = broadcasterId => getDb().collection(LEASES_COLLECTION).doc(String(broadcasterId));

    function unwatchLease(broadcasterId) {
        const unsubscribe = leaseWatchers.get(broadcasterId);
        if (!unsubscribe) return;
        leaseWatchers.delete(broadcasterId);
        try {
            unsubscribe();
        } catch (err) {
            logger.warn({ err, broadcasterId }, '[ChannelOwnership] Error stopping lease watcher');
        }
    }

    /**
     * Watches a held lease so a takeover (by an instance the browser source
     * reconnected to) is noticed at once rather than at the next renewal, which
     * could leave this instance consuming the channel's inbox for up to
     * RENEW_INTERVAL_MS with no player to play to.
     */
    function watchLease(broadcasterId) {
        if (leaseWatchers.has(broadcasterId)) return;
        const unsubscribe = leaseRef(broadcasterId).onSnapshot(snap => {
            const data = snap.exists ? snap.data() : null;
            const entry = owned.get(broadcasterId);
            if (!entry || !data || data.ownerId === instanceId) return;
            owned.delete(broadcasterId);
            unwatchLease(broadcasterId);
            logger.warn({ channelName: entry.channelName, broadcasterId, ownerId: data.ownerId, instanceId },
                '[ChannelOwnership] Lease taken by another instance, dropping channel');
            emit('lost', broadcasterId, entry.channelName, 'taken');
        }, err => {
            // Renewal still catches a takeover; this only makes it quicker.
            logger.warn({ err, broadcasterId }, '[ChannelOwnership] Lease watcher failed');
            leaseWatchers.delete(broadcasterId);
        });
        leaseWatchers.set(broadcasterId, unsubscribe);
    }

    /**
     * Tells every listener, and resolves once all of them have finished, so a
     * shutdown does not exit before a 'lost' listener has handed the channel's
     * pending clips on.
     */
    async function emit(type, broadcasterId, channelName, reason) {
        const results = [];
        for (const listener of changeListeners) {
            try {
                results.push(listener({ type, broadcasterId, channelName, reason }));
            } catch (err) {
                logger.error({ err, type, broadcasterId }, '[ChannelOwnership] Ownership listener threw');
            }
        }
        const settled = await Promise.allSettled(results);
        for (const result of settled) {
            if (result.status === 'rejected') {
                logger.error({ err: result.reason, type, broadcasterId }, '[ChannelOwnership] Ownership listener failed');
            }
        }
    }

    function isOwnershipEnabled() {
        return isEnabled();
    }

    /**
     * Registers a callback for ownership changes. It may return a promise, which
     * the change waits for. A release deletes the lease first, then announces it.
     * @param {(change: {type: 'acquired'|'lost', broadcasterId: string, channelName: string, reason?: string}) => (void|Promise<void>)} listener
     * @returns {Function} Unsubscribe function.
     */
    function onOwnershipChange(listener) {
        changeListeners.add(listener);
        return () => changeListeners.delete(listener);
    }

    /**
     * Whether this instance currently owns the channel. Synchronous: answered from
     * the local lease record, which stops counting SAFETY_MARGIN_MS before the
     * Firestore lease could expire.
     * @param {string} broadcasterId
     */
    function ownsBroadcaster(broadcasterId) {
        if (!isOwnershipEnabled()) return true;
        const entry = owned.get(String(broadcasterId));
        return !!entry && entry.deadlineMs > now();
    }

    async function runClaim(broadcasterId, channelName, hasPlayer) {
        const db = getDb();
        const ref = leaseRef(broadcasterId);
        // Measured before the transaction: the local deadline must never run past
        // the expiry written to Firestore, however long the round trip takes.
        const startedAt = now();

        const result = await db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            const data = snap.exists ? snap.data() : null;
            const t = now();
            const heldElsewhere = data && data.ownerId !== instanceId && toMillis(data.expiresAt) > t;
            // A holder whose player has gone keeps the lease only until an
            // instance that has the player asks for it.
            if (heldElsewhere && !(hasPlayer && data.hasPlayer === false)) {
                return { owned: false, ownerId: data.ownerId };
            }
            const lease = {
                ownerId: instanceId,
                channelName,
                hasPlayer,
                expiresAt: new Date(t + LEASE_TTL_MS),
                renewedAt: new Date(t),
            };
            // set() replaces the document, so a renewal carries the acquisition
            // record forward or it is gone ten seconds after a takeover.
            if (data?.ownerId !== instanceId) {
                lease.acquiredAt = new Date(t);
                lease.previousOwnerId = data?.ownerId || null;
            } else {
                lease.acquiredAt = data.acquiredAt || new Date(t);
                lease.previousOwnerId = data.previousOwnerId || null;
            }
            tx.set(ref, lease);
            return {
                owned: true,
                ownerId: instanceId,
                previousOwnerId: data?.ownerId || null,
                tookOver: !!heldElsewhere,
            };
        });

        const previous = owned.get(broadcasterId);
        if (result.owned) {
            owned.set(broadcasterId, {
                channelName,
                deadlineMs: startedAt + LEASE_TTL_MS - SAFETY_MARGIN_MS,
                hasPlayer,
                playerGoneAtMs: hasPlayer ? null : (previous?.playerGoneAtMs ?? now()),
            });
            reportedSecondPlayer.delete(broadcasterId);
            watchLease(broadcasterId);
            if (!previous) {
                logger.info({ channelName, broadcasterId, previousOwnerId: result.previousOwnerId, tookOver: result.tookOver, instanceId },
                    '[ChannelOwnership] Acquired channel');
                await emit('acquired', broadcasterId, channelName);
            }
        } else if (previous) {
            owned.delete(broadcasterId);
            unwatchLease(broadcasterId);
            logger.warn({ channelName, broadcasterId, ownerId: result.ownerId, instanceId },
                '[ChannelOwnership] Lease taken by another instance, dropping channel');
            await emit('lost', broadcasterId, channelName, 'taken');
        } else if (hasPlayer && !reportedSecondPlayer.has(broadcasterId)) {
            reportedSecondPlayer.add(broadcasterId);
            // Two browser sources for one channel on two instances. Only the
            // owner's plays; this one stays silent until the owner lets go.
            logger.warn({ logKey: 'PLAYER_ON_NON_OWNER', channelName, broadcasterId, ownerId: result.ownerId, instanceId },
                '[ChannelOwnership] Browser source attached here, but another instance with a browser source owns the channel');
        }
        return result;
    }

    /**
     * Acquires or renews the lease on a channel. Succeeds when the lease is free,
     * expired or already ours, or when `hasPlayer` is set and the holder has none.
     * @param {string} broadcasterId
     * @param {string} channelName
     * @param {{hasPlayer?: boolean}} [opts]
     * @returns {Promise<{owned: boolean, ownerId: string}>}
     */
    function claimChannel(broadcasterId, channelName, { hasPlayer = true } = {}) {
        const id = String(broadcasterId);
        if (!isOwnershipEnabled()) return Promise.resolve({ owned: true, ownerId: instanceId });
        if (stopping) return Promise.resolve({ owned: false, ownerId: null });
        const pending = inFlight.get(id);
        if (pending?.hasPlayer === hasPlayer) return pending.promise;
        // A claim with the other player flag is running (a renewal racing a
        // browser source connecting, say). Its answer would write the wrong
        // flag, so this one runs after it rather than sharing it.
        const promise = (pending ? pending.promise.catch(() => {}) : Promise.resolve())
            .then(() => runClaim(id, channelName, hasPlayer))
            .finally(() => {
                if (inFlight.get(id)?.promise === promise) inFlight.delete(id);
            });
        inFlight.set(id, { promise, hasPlayer });
        return promise;
    }

    /**
     * Gives up a lease this instance holds. The lease is deleted first, so
     * other instances stop forwarding webhooks here while this one is still
     * listening to the inbox; only then do listeners stop the inbox and hand
     * the queue on. The other order left a window in which peers kept
     * forwarding to an inbox nobody read.
     * @param {string} broadcasterId
     * @param {string} reason - For logs and listeners, e.g. 'no-player' or 'shutdown'.
     */
    async function releaseChannel(broadcasterId, reason) {
        const entry = owned.get(broadcasterId);
        if (!entry) return;

        try {
            const db = getDb();
            const ref = leaseRef(broadcasterId);
            await db.runTransaction(async (tx) => {
                const snap = await tx.get(ref);
                if (snap.exists && snap.data().ownerId === instanceId) {
                    tx.delete(ref);
                }
            });
            logger.info({ channelName: entry.channelName, broadcasterId, reason }, '[ChannelOwnership] Released channel');
        } catch (err) {
            // The lease expires on its own; releasing early only speeds up handover.
            logger.warn({ err, broadcasterId, reason }, '[ChannelOwnership] Failed to release lease');
        }

        // A browser source that reconnected meanwhile re-claimed the channel
        // (a new entry), or a takeover already announced the loss (no entry).
        if (owned.get(broadcasterId) !== entry) return;
        owned.delete(broadcasterId);
        unwatchLease(broadcasterId);
        await emit('lost', broadcasterId, entry.channelName, reason);
    }

    /**
     * The instance holding a channel's lease, read from Firestore, or null when
     * nobody holds a live one. Used to route a webhook that landed elsewhere.
     * @param {string} broadcasterId
     * @returns {Promise<{ownerId: string, hasPlayer: boolean}|null>}
     */
    async function getLeaseOwner(broadcasterId) {
        const snap = await leaseRef(broadcasterId).get();
        if (!snap.exists) return null;
        const data = snap.data();
        if (toMillis(data.expiresAt) <= now()) return null;
        return { ownerId: data.ownerId, hasPlayer: data.hasPlayer !== false };
    }

    /**
     * Reacts at once to a browser source arriving or the last one leaving,
     * rather than waiting for the next sweep: claims the channel on connect, and
     * on the last disconnect marks the lease player-less so an instance the
     * source reconnects to can take it straight over.
     * @param {string} broadcasterId
     * @param {string} channelName
     * @param {boolean} present - Whether any player for the channel is attached here now.
     */
    async function notePlayer(broadcasterId, channelName, present) {
        if (!isOwnershipEnabled() || !broadcasterId) return;
        const id = String(broadcasterId);
        if (!present && !owned.has(id)) {
            reportedSecondPlayer.delete(id);
            return;
        }
        try {
            await claimChannel(id, channelName, { hasPlayer: present });
        } catch (err) {
            logger.warn({ err, broadcasterId: id, channelName, present }, '[ChannelOwnership] Could not update lease for player change, next sweep retries');
        }
    }

    /**
     * One maintenance pass: renew or release held leases, then claim channels
     * whose player is attached here but whose lease this instance does not hold
     * (the holder died, or its player went away).
     */
    async function sweep() {
        if (sweepInProgress) return;
        sweepInProgress = true;
        try {
            const players = new Map();
            try {
                for (const c of getPlayerChannels()) players.set(String(c.broadcasterId), c);
            } catch (err) {
                logger.warn({ err }, '[ChannelOwnership] Could not list local players');
            }

            // Each channel's lease is its own document, so they are renewed
            // side by side: one after another, a few slow transactions could
            // hold the channels at the end of the list past their deadline.
            await Promise.allSettled([...owned].map(async ([broadcasterId, entry]) => {
                const t = now();
                // A lapsed lease may already belong to someone else. Treat it as
                // lost so the queue is handed on rather than played twice.
                if (entry.deadlineMs <= t) {
                    owned.delete(broadcasterId);
                    unwatchLease(broadcasterId);
                    logger.warn({ channelName: entry.channelName, broadcasterId }, '[ChannelOwnership] Lease lapsed before renewal');
                    await emit('lost', broadcasterId, entry.channelName, 'lapsed');
                    return;
                }
                const hasPlayer = players.has(broadcasterId);
                if (!hasPlayer && entry.playerGoneAtMs !== null && t - entry.playerGoneAtMs >= PLAYER_GRACE_MS) {
                    await releaseChannel(broadcasterId, 'no-player');
                    return;
                }
                try {
                    await claimChannel(broadcasterId, entry.channelName, { hasPlayer });
                } catch (err) {
                    logger.warn({ err, broadcasterId }, '[ChannelOwnership] Lease renewal failed, will retry');
                }
            }));

            await Promise.allSettled([...players]
                .filter(([broadcasterId]) => !owned.has(broadcasterId))
                .map(async ([broadcasterId, { channelName }]) => {
                    try {
                        await claimChannel(broadcasterId, channelName, { hasPlayer: true });
                    } catch (err) {
                        logger.warn({ err, broadcasterId }, '[ChannelOwnership] Claim failed');
                    }
                }));
        } finally {
            sweepInProgress = false;
        }
    }

    /**
     * Starts lease maintenance.
     * @param {object} opts
     * @param {() => Array<{broadcasterId: string, channelName: string}>} opts.getPlayerChannels -
     *   Channels with at least one browser source attached to this instance.
     */
    async function startChannelOwnership(opts) {
        if (!isOwnershipEnabled()) {
            logger.info('[ChannelOwnership] Disabled — this process acts for every channel');
            return;
        }
        if (intervalId) {
            logger.warn('[ChannelOwnership] Already running');
            return;
        }
        getPlayerChannels = opts.getPlayerChannels;
        logger.info({ instanceId }, '[ChannelOwnership] Starting');
        try {
            await sweep();
        } catch (err) {
            logger.error({ err }, '[ChannelOwnership] Initial sweep failed');
        }
        intervalId = setInterval(() => {
            sweep().catch(err => logger.error({ err }, '[ChannelOwnership] Sweep failed'));
        }, RENEW_INTERVAL_MS);
        intervalId.unref?.();
    }

    /**
     * Stops maintenance and hands every lease back so another instance can take
     * over immediately rather than after the lease expires.
     */
    async function stopChannelOwnership() {
        stopping = true;
        if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
        }
        if (!isOwnershipEnabled()) return;
        await Promise.allSettled([...owned.keys()].map(id => releaseChannel(id, 'shutdown')));
    }

    return {
        isOwnershipEnabled,
        getInstanceId: () => instanceId,
        onOwnershipChange,
        ownsBroadcaster,
        claimChannel,
        getLeaseOwner,
        notePlayer,
        startChannelOwnership,
        stopChannelOwnership,
        getOwnedBroadcasterIds: () => [...owned.keys()],
        // For tests
        _sweep: sweep,
        _owned: owned,
    };
}

let db;
const defaultOwnership = createChannelOwnership({
    getDb: () => {
        if (!db) db = new Firestore();
        return db;
    },
    instanceId: INSTANCE_ID,
    isEnabled: () => config.cluster?.channelOwnershipEnabled === true,
});

export const {
    isOwnershipEnabled,
    onOwnershipChange,
    ownsBroadcaster,
    getLeaseOwner,
    notePlayer,
    startChannelOwnership,
    stopChannelOwnership,
} = defaultOwnership;
