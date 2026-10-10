import { connectionUrl, keyId, serviceOrigin, tenantId } from '../../shared/protocol.js';
import { fail } from './security.js';

export class IndexedStore {
  constructor(indexedDB = globalThis.indexedDB) {
    this.indexedDB = indexedDB;
    this.opening = null;
  }

  open() {
    if (!this.opening) this.opening = new Promise((resolve, reject) => {
      // Legacy origin-only keys deliberately stay in the old database. They
      // cannot authenticate a tenant and must never be adopted during upgrade.
      const request = this.indexedDB.open('domagent-device-v2', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('services', { keyPath: 'connection_url' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Device key database upgrade blocked'));
    });
    return this.opening;
  }

  async get(connection) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('services', 'readonly');
      const request = tx.objectStore('services').get(connection);
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

  async get(origin, tenant) {
    origin = serviceOrigin(origin);
    tenant = tenantId(tenant);
    const connection = connectionUrl(origin, tenant);
    if (!this.creating.has(connection)) {
      const promise = this.loadOrCreate(origin, tenant, connection).finally(() => this.creating.delete(connection));
      this.creating.set(connection, promise);
    }
    return this.creating.get(connection);
  }

  async loadOrCreate(origin, tenant, connection) {
    const existing = await this.store.get(connection);
    if (existing) {
      if (existing.origin !== origin || existing.tenant_id !== tenant || existing.connection_url !== connection ||
          (existing.identity && existing.identity.tenant_id !== tenant) ||
          existing.privateKey?.extractable !== false || existing.privateKey?.type !== 'private' ||
          existing.privateKey.algorithm?.name !== 'ECDSA' ||
          existing.privateKey.algorithm?.namedCurve !== 'P-256' ||
          existing.key_id !== await keyId(existing.public_key)) fail('NOT_AUTHORIZED');
      return existing;
    }
    const keys = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const public_key = await crypto.subtle.exportKey('jwk', keys.publicKey);
    return this.store.put({
      origin, tenant_id: tenant, connection_url: connection,
      privateKey: keys.privateKey, public_key, key_id: await keyId(public_key),
      enrollment: null, identity: null, protected_origins: [],
    });
  }

  save(record) {
    return this.store.put(record);
  }
}
