import { keyId, serviceOrigin } from '../../shared/protocol.js';
import type { Wire } from '../../shared/protocol.js';
import { fail } from './security.js';

const DATABASE = 'domagent-v6';
const RECORD = 'self';

export class IndexedStore {
  declare indexedDB: IDBFactory;
  declare opening: Promise<IDBDatabase> | null;
  constructor(indexedDB = globalThis.indexedDB) {
    this.indexedDB = indexedDB;
    this.opening = null;
  }
  open() {
    if (!this.opening) this.opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('identity', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Identity database upgrade blocked'));
    });
    return this.opening;
  }
  async transact(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest | undefined): Promise<any> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('identity', mode);
      const request = run(tx.objectStore('identity'));
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Identity transaction aborted'));
    });
  }
  get() { return this.transact('readonly', store => store.get(RECORD)); }
  put(record: Wire): Promise<Wire> { return this.transact('readwrite', store => store.put({ ...record, id: RECORD })).then(() => record); }
  clear() { return this.transact('readwrite', store => store.delete(RECORD)); }
}

/** One browser identity per install: a nonextractable P-256 key plus server-issued IDs and refresh token. */
export class Identity {
  declare store: IndexedStore;
  constructor(store = new IndexedStore()) { this.store = store; }
  async load() {
    const record = await this.store.get();
    if (!record) return null;
    if (record.privateKey?.extractable !== false || record.privateKey?.type !== 'private' ||
        record.privateKey.algorithm?.name !== 'ECDSA' || record.privateKey.algorithm?.namedCurve !== 'P-256' ||
        record.key_id !== await keyId(record.public_key)) fail('NOT_AUTHORIZED');
    return record;
  }
  async create(origin: string): Promise<Wire> {
    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const public_key = await crypto.subtle.exportKey('jwk', keys.publicKey);
    return { origin: serviceOrigin(origin), privateKey: keys.privateKey, public_key,
      key_id: await keyId(public_key), browser_id: null, refresh_token: null, name: null };
  }
  save(record: Wire): Promise<Wire> { return this.store.put(record); }
  clear() { return this.store.clear(); }
}
