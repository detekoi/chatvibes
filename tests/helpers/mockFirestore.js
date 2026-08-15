// tests/helpers/mockFirestore.js
// Mock Firestore for testing

export class MockDocumentSnapshot {
  constructor(data, id, exists = true, ref = null) {
    this._data = data;
    this._id = id;
    this._exists = exists;
    this.ref = ref;
  }

  get id() {
    return this._id;
  }

  get exists() {
    return this._exists;
  }

  data() {
    return this._data;
  }
}

/** True for plain objects, which are the only thing Firestore merges into. */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
}

/** Recursive map merge, honouring the FieldValue.delete() sentinel. */
function deepMerge(target, source) {
  const out = { ...(target || {}) };
  for (const [key, value] of Object.entries(source)) {
    if (value && value._delete) {
      delete out[key];
    } else if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Apply [pathSegments, value] pairs, creating intermediate maps as needed.
 * A delete sentinel on a missing path throws with code 5 (NOT_FOUND), matching
 * the real client, because callers treat that code as "already gone".
 */
function applyUpdates(data, pairs) {
  const out = { ...(data || {}) };
  for (const [segments, value] of pairs) {
    let node = out;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      node[seg] = isPlainObject(node[seg]) ? { ...node[seg] } : {};
      node = node[seg];
    }
    const leaf = segments[segments.length - 1];
    if (value && value._delete) {
      if (!(leaf in node)) {
        const err = new Error('NOT_FOUND: no such field');
        err.code = 5;
        throw err;
      }
      delete node[leaf];
    } else if (value && value._arrayUnion) {
      const existing = Array.isArray(node[leaf]) ? node[leaf] : [];
      node[leaf] = [...new Set([...existing, ...value._arrayUnion])];
    } else if (value && value._arrayRemove) {
      const existing = Array.isArray(node[leaf]) ? node[leaf] : [];
      node[leaf] = existing.filter(v => !value._arrayRemove.includes(v));
    } else {
      node[leaf] = value;
    }
  }
  return out;
}

/** Stands in for the real FieldPath, whose segments are taken literally. */
export class MockFieldPath {
  constructor(...segments) {
    this.segments = segments;
  }
}

export class MockDocumentReference {
  constructor(data, id) {
    this._data = data;
    this._id = id;
  }

  // Real DocumentReferences expose this, and callers that build a composite doc id
  // (see the dedup claims in lib/ttsDispatch.js) need to assert on it.
  get id() {
    return this._id;
  }

  async get() {
    return new MockDocumentSnapshot(this._data, this._id, !!this._data, this);
  }

  async set(data, options = {}) {
    if (options.mergeFields) {
      // mergeFields replaces each named top-level field outright rather than
      // merging into it, which is how clearPronunciations empties a map.
      const next = { ...this._data };
      for (const field of options.mergeFields) {
        if (field in data) next[field] = data[field];
      }
      this._data = next;
    } else if (options.merge) {
      // Real Firestore deep-merges nested maps key by key. The pronunciation
      // dictionary depends on that: writing one entry must not drop the rest.
      this._data = deepMerge(this._data, data);
    } else {
      this._data = data;
    }
    return this;
  }

  /**
   * Supports both call shapes: update(dataObject) and the varargs
   * update(fieldPath, value, fieldPath, value, ...) form, which is the only
   * way to target a map key that contains a space, hyphen or dot.
   */
  async update(...args) {
    if (args.length === 1 && !(args[0] instanceof MockFieldPath)) {
      this._data = applyUpdates(this._data, Object.entries(args[0]).map(([k, v]) => [k.split('.'), v]));
      return this;
    }

    const pairs = [];
    for (let i = 0; i < args.length; i += 2) {
      const path = args[i];
      const segments = path instanceof MockFieldPath ? path.segments : String(path).split('.');
      pairs.push([segments, args[i + 1]]);
    }
    this._data = applyUpdates(this._data, pairs);
    return this;
  }

  async delete() {
    this._data = null;
    return this;
  }
}

export class MockCollectionReference {
  constructor(collectionId) {
    this.collectionId = collectionId;
    this.documents = new Map();
  }

  doc(id) {
    if (!this.documents.has(id)) {
      this.documents.set(id, new MockDocumentReference(null, id));
    }
    return this.documents.get(id);
  }

  async get() {
    const docs = Array.from(this.documents.entries()).map(([id, ref]) =>
      new MockDocumentSnapshot(ref._data, id, !!ref._data, ref)
    );
    return {
      forEach: (callback) => docs.forEach(callback),
      docs,
      size: docs.length,
      empty: docs.length === 0
    };
  }

  onSnapshot(callback) {
    // Simple implementation for testing
    const snapshot = {
      docChanges: () => [],
      forEach: () => { }
    };
    callback(snapshot);
    return () => { }; // Unsubscribe function
  }

  limit(_n) {
    return this;
  }

  async add(data) {
    const id = 'auto-id-' + Math.random().toString(36).substr(2, 9);
    const docRef = this.doc(id);
    await docRef.set(data);
    return docRef;
  }
}

export class MockFirestore {
  constructor() {
    this.collections = new Map();
  }

  collection(collectionId) {
    if (!this.collections.has(collectionId)) {
      this.collections.set(collectionId, new MockCollectionReference(collectionId));
    }
    return this.collections.get(collectionId);
  }
}

export const createMockFirestore = () => new MockFirestore();

export const FieldValue = {
  serverTimestamp: () => new Date(),
  arrayUnion: (...values) => ({ _arrayUnion: values }),
  arrayRemove: (...values) => ({ _arrayRemove: values }),
  delete: () => ({ _delete: true })
};

export const FieldPath = MockFieldPath;