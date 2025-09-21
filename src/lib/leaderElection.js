// src/lib/leaderElection.js
import { Firestore, FieldValue } from '@google-cloud/firestore';
import crypto from 'crypto';
import logger from './logger.js';

const LEASE_COLLECTION = 'system';
const LEASE_DOCUMENT = 'ircLeader';
const HEARTBEAT_INTERVAL_MS = 30000; // 30s
const LEASE_TTL_MS = 120000; // 120s lease expiry

function generateInstanceId() {
    const revision = process.env.K_REVISION || 'local';
    const service = process.env.K_SERVICE || 'chatvibes-tts';
    const randomSuffix = crypto.randomBytes(8).toString('hex');
    return `${service}:${revision}:${randomSuffix}`;
}

export class LeaderElection {
    constructor() {
        this.db = new Firestore();
        this.instanceId = generateInstanceId();
        this.leaseDocRef = this.db.collection(LEASE_COLLECTION).doc(LEASE_DOCUMENT);
        this.heartbeatTimer = null;
        this.isLeader = false;
        this.onStartedLeading = null;
        this.onStoppedLeading = null;
    }

    async tryAcquireLease() {
        const now = Date.now();
        const expiryCutoff = now - LEASE_TTL_MS;
        return this.db.runTransaction(async (tx) => {
            const snap = await tx.get(this.leaseDocRef);
            if (!snap.exists) {
                tx.set(this.leaseDocRef, {
                    holderId: this.instanceId,
                    updatedAtMs: now,
                    expiresAtMs: now + LEASE_TTL_MS,
                });
                return true;
            }
            const data = snap.data() || {};
            const expiresAtMs = typeof data.expiresAtMs === 'number' ? data.expiresAtMs : 0;
            if (expiresAtMs <= now || (typeof data.updatedAtMs === 'number' && data.updatedAtMs <= expiryCutoff)) {
                tx.update(this.leaseDocRef, {
                    holderId: this.instanceId,
                    updatedAtMs: now,
                    expiresAtMs: now + LEASE_TTL_MS,
                });
                return true;
            }
            if (data.holderId === this.instanceId) {
                tx.update(this.leaseDocRef, {
                    updatedAtMs: now,
                    expiresAtMs: now + LEASE_TTL_MS,
                });
                return true;
            }
            return false;
        });
    }

    async start({ onStartedLeading, onStoppedLeading }) {
        this.onStartedLeading = onStartedLeading;
        this.onStoppedLeading = onStoppedLeading;
        logger.info({ instanceId: this.instanceId }, 'LeaderElection: Starting leader election loop');
        await this._evaluateLeadership();
        this.heartbeatTimer = setInterval(() => {
            this._evaluateLeadership().catch((err) => {
                logger.error({ err }, 'LeaderElection: Error during evaluation loop');
            });
        }, HEARTBEAT_INTERVAL_MS);
        if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref();
    }

    async stop() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        // Best-effort release if we are the holder
        try {
            const snap = await this.leaseDocRef.get();
            if (snap.exists && snap.data()?.holderId === this.instanceId) {
                await this.leaseDocRef.update({
                    holderId: FieldValue.delete(),
                    updatedAtMs: FieldValue.delete(),
                    expiresAtMs: FieldValue.delete(),
                });
            }
        } catch (err) {
            logger.warn({ err }, 'LeaderElection: Failed to release lease on stop');
        }
        this.isLeader = false;
    }

    async _evaluateLeadership() {
        const acquired = await this.tryAcquireLease();
        if (acquired && !this.isLeader) {
            this.isLeader = true;
            logger.info({ instanceId: this.instanceId }, 'LeaderElection: Acquired leadership');
            if (typeof this.onStartedLeading === 'function') {
                try { await this.onStartedLeading(); } catch (err) { logger.error({ err }, 'LeaderElection: onStartedLeading error'); }
            }
            return;
        }
        if (!acquired && this.isLeader) {
            this.isLeader = false;
            logger.warn('LeaderElection: Lost leadership');
            if (typeof this.onStoppedLeading === 'function') {
                try { await this.onStoppedLeading(); } catch (err) { logger.error({ err }, 'LeaderElection: onStoppedLeading error'); }
            }
        }
    }
}

export function createLeaderElection() {
    return new LeaderElection();
}


