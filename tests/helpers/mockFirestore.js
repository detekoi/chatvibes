// tests/helpers/mockFirestore.js
// Mock Firestore for testing

export class MockDocumentSnapshot {
  constructor(data, id, exists = true) {
    this._data = data;
    this._id = id;
    this._exists = exists;
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

export class MockDocumentReference {
  constructor(data, id) {
    this._data = data;
    this._id = id;
  }

  async get() {
    return new MockDocumentSnapshot(this._data, this._id, !!this._data);
  }

  async set(data, options = {}) {
    if (options.merge || options.mergeFields) {
      this._data = { ...this._data, ...data };
    } else {
      this._data = data;
    }
    return this;
  }

  async update(data) {
    this._data = { ...this._data, ...data };
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
      new MockDocumentSnapshot(ref._data, id, !!ref._data)
    );
    return {
      forEach: (callback) => docs.forEach(callback),
      docs,
      size: docs.length
    };
  }

  onSnapshot(callback) {
    // Simple implementation for testing
    const snapshot = {
      docChanges: () => [],
      forEach: () => {}
    };
    callback(snapshot);
    return () => {}; // Unsubscribe function
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