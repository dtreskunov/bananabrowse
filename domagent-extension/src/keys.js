import { keyId, serviceOrigin } from '../../shared/protocol.js';
import { fail } from './security.js';

export class IndexedStore {
  constructor(indexedDB = globalThis.indexedDB) {
    this.indexedDB = indexedDB;
    this.opening = null;
  }

  open() {
    if (!this.opening) this.opening = new Promise((resolve, reject) => {
      const request = this.indexedDB.open('domagent-device-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('services', { keyPath: 'origin' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Device key database upgrade blocked'));
    });
    return this.opening;
  }

  async get(origin) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('services', 'readonly');
      const request = tx.objectStore('services').get(origin);
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Device key read aborted'));
    });
  }

  async put(record) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('services', 'readwrite');
      tx.objectStore('services').put(record);
      tx.oncomplete = () => resolve(record);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Device key write aborted'));
    });
  }
}

export class DeviceKeys {
  constructor(store = new IndexedStore()) {
    this.store = store;
    this.creating = new Map();
  }

  async get(origin) {
    origin = serviceOrigin(origin);
    if (!this.creating.has(origin)) {
      const promise = this.loadOrCreate(origin).finally(() => this.creating.delete(origin));
      this.creating.set(origin, promise);
    }
    return this.creating.get(origin);
  }

  async loadOrCreate(origin) {
    const existing = await this.store.get(origin);
    if (existing) {
      if (existing.privateKey?.extractable !== false || existing.privateKey?.type !== 'private' ||
          existing.privateKey.algorithm?.name !== 'ECDSA' ||
          existing.privateKey.algorithm?.namedCurve !== 'P-256' ||
          existing.key_id !== await keyId(existing.public_key)) fail('NOT_AUTHORIZED');
      return existing;
    }
    const keys = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const public_key = await crypto.subtle.exportKey('jwk', keys.publicKey);
    return this.store.put({
      origin, privateKey: keys.privateKey, public_key, key_id: await keyId(public_key),
      enrollment: null, identity: null, protected_origins: [],
    });
  }

  save(record) {
    return this.store.put(record);
  }
}
