// tests/helpers/fakeFirestore.js
// In-memory Firestore for tests that depend on transaction and listener
// semantics: channel leases, the channel inbox, exactly-once claims. Ported from
// twitch-knowledge-bot. Documents live in a flat Map keyed by path. Transactions
// run one at a time, which is what real serializable transactions amount to for
// the conflicts these tests stage. Date fields read back with a toMillis(), as
// Firestore Timestamps do.
//
// Unlike tests/helpers/mockFirestore.js this one is shared between several
// "instances" in one test, so two copies of a module can race on the same
// documents.

import { ALREADY_EXISTS } from '../../src/lib/firestoreClaim.js';

function toComparable(value) {
    if (value instanceof Date) return value.getTime();
    if (value && typeof value.toMillis === 'function') return value.toMillis();
    return value;
}

function wrapTimestamps(data) {
    const out = {};
    for (const [k, v] of Object.entries(data)) {
        out[k] = v instanceof Date ? Object.assign(new Date(v.getTime()), { toMillis: () => v.getTime() }) : v;
    }
    return out;
}

function snapshot(path, data) {
    return {
        id: path.split('/').pop(),
        exists: data !== undefined,
        data: () => (data === undefined ? undefined : wrapTimestamps(data)),
        get: field => (data === undefined ? undefined : wrapTimestamps(data)[field]),
    };
}

export function createFakeFirestore() {
    const docs = new Map();
    const listeners = new Set();

    function notify() {
        for (const listener of [...listeners]) listener();
    }

    function write(path, data) {
        docs.set(path, data);
        notify();
    }

    function docRef(path) {
        const ref = {
            id: path.split('/').pop(),
            path,
            firestore: db,
            collection: name => collectionRef(`${path}/${name}`),
            get: async () => snapshot(path, docs.get(path)),
            create: async data => {
                if (docs.has(path)) throw Object.assign(new Error(`ALREADY_EXISTS: ${path}`), { code: ALREADY_EXISTS });
                write(path, { ...data });
            },
            set: async (data, opts) => {
                const base = opts?.merge ? (docs.get(path) || {}) : {};
                write(path, { ...base, ...data });
            },
            update: async data => {
                if (!docs.has(path)) throw Object.assign(new Error(`NOT_FOUND: ${path}`), { code: 5 });
                write(path, { ...docs.get(path), ...data });
            },
            delete: async () => {
                docs.delete(path);
                notify();
            },
            onSnapshot: (onNext, onError) => {
                let last;
                const listener = () => {
                    const current = docs.get(path);
                    if (current === last) return;
                    last = current;
                    onNext(snapshot(path, current));
                };
                listener.fail = err => {
                    listeners.delete(listener);
                    onError?.(err);
                };
                listeners.add(listener);
                last = Symbol('unseen');
                Promise.resolve().then(listener);
                return () => listeners.delete(listener);
            },
        };
        return ref;
    }

    function childDocs(path) {
        const prefix = `${path}/`;
        return [...docs.entries()]
            .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
            .map(([p, d]) => ({ path: p, data: d }));
    }

    function queryRef(path, orderField = null) {
        const run = () => {
            const rows = childDocs(path);
            if (orderField) rows.sort((x, y) => toComparable(x.data[orderField]) - toComparable(y.data[orderField]));
            return rows;
        };
        return {
            orderBy: field => queryRef(path, field),
            get: async () => {
                const rows = run();
                const out = rows.map(r => ({ ...snapshot(r.path, r.data), ref: docRef(r.path) }));
                return { size: out.length, empty: out.length === 0, docs: out, forEach: fn => out.forEach(fn) };
            },
            onSnapshot: (onNext, onError) => {
                let seen = new Set();
                const listener = () => {
                    const rows = run();
                    const added = rows.filter(r => !seen.has(r.path));
                    seen = new Set(rows.map(r => r.path));
                    if (added.length === 0) return;
                    onNext({
                        docChanges: () => added.map(r => ({
                            type: 'added',
                            doc: { ...snapshot(r.path, r.data), ref: docRef(r.path) },
                        })),
                    });
                };
                listener.fail = err => {
                    listeners.delete(listener);
                    onError?.(err);
                };
                listeners.add(listener);
                // Initial snapshot, delivered asynchronously like the real client.
                Promise.resolve().then(listener);
                return () => listeners.delete(listener);
            },
        };
    }

    function collectionRef(path) {
        return { ...queryRef(path), doc: id => docRef(`${path}/${id}`) };
    }

    let txQueue = Promise.resolve();

    async function runOne(fn) {
        const writes = [];
        const tx = {
            get: ref => ref.get(),
            set: (ref, data, opts) => { writes.push(() => ref.set(data, opts)); },
            update: (ref, data) => { writes.push(() => ref.update(data)); },
            delete: ref => { writes.push(() => ref.delete()); },
        };
        const result = await fn(tx);
        for (const w of writes) await w();
        return result;
    }

    const db = {
        collection: name => collectionRef(name),
        runTransaction: fn => {
            const run = txQueue.then(() => runOne(fn));
            txQueue = run.catch(() => {});
            return run;
        },
        // Test helpers
        _seed: (path, data) => write(path, data),
        _read: path => docs.get(path),
        _paths: () => [...docs.keys()],
        _failListeners: err => {
            for (const listener of [...listeners]) listener.fail?.(err);
        },
    };

    return db;
}

/** Lets pending promise callbacks and listener deliveries run. */
export async function flush(rounds = 10) {
    for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve));
}
