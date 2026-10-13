import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash, createHmac } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizePairingCode } from '../shared/protocol.js';
import { requireValue, Fault } from './errors.js';

export const SCHEMA_VERSION = 3;
export const PAIRING_TTL_MS = 300_000;
export const PROPOSAL_TTL_MS = 60_000;
export const token = () => randomBytes(32).toString('base64url');
export const newTenantId = () => `t_${randomBytes(16).toString('base64url')}`;
export const hash = value => createHash('sha256').update(value).digest('hex');
export const validLabel = value => typeof value === 'string' && value.trim() && [...value].length <= 80;

export function initializeSchema(db) {
  db.exec(`
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, label TEXT NOT NULL,
      owner_id TEXT, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)));
    CREATE TABLE clients (id TEXT PRIMARY KEY, owner_id TEXT, label TEXT NOT NULL,
      credential_hash TEXT NOT NULL UNIQUE, revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
      legacy_disabled INTEGER NOT NULL DEFAULT 0 CHECK(legacy_disabled IN (0,1)),
      tenant_id TEXT NOT NULL UNIQUE REFERENCES tenants(id), UNIQUE(id,tenant_id));
    CREATE TABLE devices (id TEXT PRIMARY KEY, owner_id TEXT, key_id TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL, extension_origin TEXT NOT NULL, label TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)), legacy_disabled INTEGER NOT NULL DEFAULT 0 CHECK(legacy_disabled IN (0,1)),
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      UNIQUE(id,tenant_id));
    CREATE TABLE client_devices (client_id TEXT NOT NULL, device_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
      PRIMARY KEY(client_id,device_id), UNIQUE(device_id),
      FOREIGN KEY(client_id,tenant_id) REFERENCES clients(id,tenant_id),
      FOREIGN KEY(device_id,tenant_id) REFERENCES devices(id,tenant_id));
    CREATE TABLE operator_sessions (hash TEXT PRIMARY KEY, secret_hash TEXT NOT NULL,
      csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE pairings (id TEXT PRIMARY KEY, key_id TEXT NOT NULL, public_key TEXT NOT NULL,
      extension_origin TEXT NOT NULL, label TEXT NOT NULL, code_hash TEXT UNIQUE NOT NULL,
      receipt_hash TEXT NOT NULL, expires INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','proposed','confirmed','cancelled')),
      proposal_id TEXT, client_id TEXT, tenant_id TEXT, credential_hash TEXT, nonce TEXT,
      proposal_expires INTEGER, device_id TEXT);
    PRAGMA user_version=3;
  `);
  db.prepare('INSERT INTO metadata VALUES(?,?)').run('pairing_secret', token());
}

export class Store {
  constructor(path, options = {}) {
    this.now = options.now || Date.now;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    try {
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      const tables = this.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      if (!tables.length && version === 0) initializeSchema(this.db);
      else requireValue(version === SCHEMA_VERSION,
        version === 2 ? 'SCHEMA_MIGRATION_REQUIRED' : 'SCHEMA_VERSION_UNSUPPORTED');
      this.pairingSecret = options.pairingSecret ||
        this.db.prepare("SELECT value FROM metadata WHERE key='pairing_secret'").get()?.value;
      requireValue(typeof this.pairingSecret === 'string' && this.pairingSecret.length >= 32, 'PAIRING_SECRET_REQUIRED');
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  transaction(run) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = run(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  tenant(id) { return this.db.prepare('SELECT * FROM tenants WHERE id=? AND enabled=1').get(id); }
  createClient(label) {
    requireValue(validLabel(label), 'INVALID_CLIENT');
    return this.transaction(() => {
      const tenant = newTenantId(), id = randomUUID(), credential = token();
      this.db.prepare('INSERT INTO tenants(id,label) VALUES(?,?)').run(tenant, label.trim());
      this.db.prepare('INSERT INTO clients(id,label,credential_hash,tenant_id) VALUES(?,?,?,?)')
        .run(id, label.trim(), hash(credential), tenant);
      return { id, client_id: id, tenant_id: tenant, credential };
    });
  }
  client(id, tenant) {
    const client = this.db.prepare(`SELECT c.* FROM clients c JOIN tenants t ON t.id=c.tenant_id
      WHERE c.id=? AND c.revoked=0 AND c.legacy_disabled=0 AND t.enabled=1`).get(id);
    return client && (!tenant || client.tenant_id === tenant) ? client : undefined;
  }
  authenticateClient(credential, tenant) {
    if (typeof credential !== 'string' || credential.length > 512) return undefined;
    const row = this.db.prepare('SELECT id FROM clients WHERE credential_hash=? AND tenant_id=?')
      .get(hash(credential), tenant);
    return row && this.client(row.id, tenant);
  }
  listClients() { return this.db.prepare('SELECT id,label,tenant_id,revoked FROM clients ORDER BY id').all(); }
  listDevices() {
    return this.db.prepare(`SELECT d.id,d.label,d.tenant_id,d.revoked,l.client_id FROM devices d
      LEFT JOIN client_devices l ON l.device_id=d.id ORDER BY d.id`).all();
  }
  rename(kind, id, label) {
    requireValue(['client','device'].includes(kind) && validLabel(label), 'INVALID_ARGUMENTS');
    const table = kind === 'client' ? 'clients' : 'devices';
    requireValue(this.db.prepare(`UPDATE ${table} SET label=? WHERE id=?`).run(label.trim(), id).changes === 1, 'NOT_FOUND', 404);
  }
  cancelProposals(id) {
    this.db.prepare(`UPDATE pairings SET state='cancelled',nonce=NULL
      WHERE client_id=? AND state='proposed'`).run(id);
  }
  rotateClient(id) {
    requireValue(this.client(id), 'NOT_AUTHORIZED', 403);
    return this.transaction(() => {
      const credential = token();
      this.db.prepare('UPDATE clients SET credential_hash=? WHERE id=? AND revoked=0').run(hash(credential), id);
      this.cancelProposals(id);
      return { client_id: id, tenant_id: this.client(id).tenant_id, credential };
    });
  }
  revoke(kind, id) {
    requireValue(['client','device'].includes(kind), 'INVALID_ARGUMENTS');
    return this.transaction(() => {
      const table = kind === 'client' ? 'clients' : 'devices';
      requireValue(this.db.prepare(`UPDATE ${table} SET revoked=1 WHERE id=?`).run(id).changes === 1, 'NOT_FOUND', 404);
      if (kind === 'client') this.cancelProposals(id);
      else this.db.prepare("UPDATE pairings SET state='cancelled' WHERE device_id=?").run(id);
    });
  }
  device(id, tenant) {
    const device = this.db.prepare(`SELECT d.* FROM devices d JOIN tenants t ON t.id=d.tenant_id
      WHERE d.id=? AND d.revoked=0 AND d.legacy_disabled=0 AND t.enabled=1`).get(id);
    return device && (!tenant || device.tenant_id === tenant) ? device : undefined;
  }
  deviceByKey(key, tenant) {
    const row = this.db.prepare('SELECT id FROM devices WHERE key_id=? AND tenant_id=?').get(key, tenant);
    return row && this.device(row.id, tenant);
  }
  linked(clientId, deviceId, tenant) {
    const c = this.client(clientId, tenant), d = this.device(deviceId, tenant);
    return Boolean(c && d && this.db.prepare(`SELECT 1 FROM client_devices
      WHERE client_id=? AND device_id=? AND tenant_id=?`).get(clientId, deviceId, c.tenant_id));
  }
  devicesForClient(clientId, tenant) {
    if (!this.client(clientId, tenant)) return [];
    return this.db.prepare('SELECT device_id FROM client_devices WHERE client_id=?')
      .all(clientId).map(row => this.device(row.device_id, tenant)).filter(Boolean);
  }
  clientsForDevice(deviceId, tenant) {
    return this.db.prepare('SELECT client_id FROM client_devices WHERE device_id=?')
      .all(deviceId).map(row => this.client(row.client_id, tenant)).filter(c => c && this.linked(c.id, deviceId, tenant))
      .map(c => ({ id: c.id, label: c.label }));
  }
  createSession(secretHash) {
    this.db.prepare('DELETE FROM operator_sessions WHERE expires<=?').run(this.now());
    requireValue(this.db.prepare('SELECT count(*) AS n FROM operator_sessions').get().n < 128, 'RATE_LIMITED', 429);
    const credential = token(), csrf = token(), expires = this.now() + 3600_000;
    this.db.prepare('INSERT INTO operator_sessions VALUES(?,?,?,?)').run(hash(credential), secretHash, csrf, expires);
    return { token: credential, csrf, expires };
  }
  session(credential, secretHash) {
    if (typeof credential !== 'string' || credential.length > 512) return undefined;
    return this.db.prepare('SELECT csrf,expires FROM operator_sessions WHERE hash=? AND secret_hash=? AND expires>?')
      .get(hash(credential), secretHash, this.now());
  }
  logout(credential) { this.db.prepare('DELETE FROM operator_sessions WHERE hash=?').run(hash(credential)); }
  codeHash(code) {
    let normalized;
    try { normalized = normalizePairingCode(code); } catch { throw new Fault('PAIRING_UNAVAILABLE', 404); }
    return createHmac('sha256', this.pairingSecret).update('domagent.v5.pairing-code\0')
      .update(normalized).digest('hex');
  }
  cleanPairings() {
    this.db.prepare('DELETE FROM pairings WHERE expires<=?').run(this.now());
    this.db.prepare(`UPDATE pairings SET state='pending',proposal_id=NULL,client_id=NULL,tenant_id=NULL,
      credential_hash=NULL,nonce=NULL,proposal_expires=NULL WHERE state='proposed' AND proposal_expires<=?`).run(this.now());
  }
  pairingStart(value) {
    return this.transaction(() => {
      this.cleanPairings();
      requireValue(this.db.prepare('SELECT count(*) AS n FROM pairings').get().n < 1000, 'RATE_LIMITED', 429);
      requireValue(!this.db.prepare('SELECT 1 FROM pairings WHERE id=?').get(value.request_id), 'PAIRING_UNAVAILABLE', 404);
      const codeHash = this.codeHash(value.pairing_code);
      requireValue(!this.db.prepare('SELECT 1 FROM pairings WHERE code_hash=?').get(codeHash), 'PAIRING_CODE_COLLISION', 409);
      const existing = this.db.prepare('SELECT * FROM devices WHERE key_id=?').get(value.key_id);
      requireValue(!existing || (!existing.revoked && existing.extension_origin === value.extension_origin &&
        existing.public_key === JSON.stringify(value.public_key)), 'PAIRING_UNAVAILABLE', 404);
      const expires = this.now() + PAIRING_TTL_MS;
      this.db.prepare(`INSERT INTO pairings(id,key_id,public_key,extension_origin,label,code_hash,receipt_hash,expires)
        VALUES(?,?,?,?,?,?,?,?)`).run(value.request_id, value.key_id, JSON.stringify(value.public_key),
          value.extension_origin, value.label.trim(), codeHash, hash(value.receipt), expires);
      return { request_id: value.request_id, expires_at: expires };
    });
  }
  pairing(requestId, key, receipt) {
    this.cleanPairings();
    return this.db.prepare(`SELECT * FROM pairings WHERE id=? AND key_id=? AND receipt_hash=?
      AND expires>? AND state!='cancelled'`).get(requestId, key, hash(receipt), this.now());
  }
  pairingPublic(row) {
    requireValue(row && row.state !== 'cancelled' && row.expires > this.now(), 'PAIRING_UNAVAILABLE', 404);
    if (row.state === 'confirmed') {
      requireValue(this.linked(row.client_id, row.device_id, row.tenant_id), 'PAIRING_UNAVAILABLE', 404);
      return { state: 'confirmed', expires_at: row.expires, device_id: row.device_id,
        tenant_id: row.tenant_id, client_id: row.client_id, client_label: this.client(row.client_id).label };
    }
    if (row.state === 'proposed') {
      requireValue(this.client(row.client_id, row.tenant_id)?.credential_hash === row.credential_hash, 'PAIRING_UNAVAILABLE', 404);
      return { state: 'proposed', expires_at: row.expires, proposal_id: row.proposal_id,
        tenant_id: row.tenant_id, client_id: row.client_id, client_label: this.client(row.client_id).label, nonce: row.nonce };
    }
    return { state: 'pending', expires_at: row.expires };
  }
  adopt(clientId, tenant, code) {
    return this.transaction(() => {
      this.cleanPairings();
      const client = this.client(clientId, tenant);
      requireValue(client, 'NOT_AUTHORIZED', 403);
      let row;
      try { row = this.db.prepare("SELECT * FROM pairings WHERE code_hash=? AND state!='cancelled'").get(this.codeHash(code)); }
      catch (error) { if (error.message === 'PAIRING_UNAVAILABLE') throw new Fault('PAIRING_UNAVAILABLE', 404); throw error; }
      requireValue(row && row.expires > this.now() && (!row.client_id || row.client_id === clientId), 'PAIRING_UNAVAILABLE', 404);
      if (row.state === 'pending') {
        const existing = this.db.prepare('SELECT * FROM devices WHERE key_id=?').get(row.key_id);
        requireValue(!existing || this.linked(clientId, existing.id, tenant), 'PAIRING_UNAVAILABLE', 404);
        this.db.prepare(`UPDATE pairings SET state='proposed',proposal_id=?,client_id=?,tenant_id=?,
          credential_hash=?,nonce=?,proposal_expires=? WHERE id=?`)
          .run(randomUUID(), clientId, tenant, client.credential_hash, token(),
            Math.min(row.expires, this.now() + PROPOSAL_TTL_MS), row.id);
        row = this.db.prepare('SELECT * FROM pairings WHERE id=?').get(row.id);
      }
      const result = this.pairingPublic(row);
      delete result.nonce;
      return result;
    });
  }
  pairingConfirm(value) {
    return this.transaction(() => {
      const row = this.pairing(value.request_id, value.key_id, value.receipt);
      requireValue(row && row.proposal_id === value.proposal_id && row.tenant_id === value.tenant_id &&
        row.client_id === value.client_id && row.nonce === value.nonce &&
        this.client(row.client_id, row.tenant_id)?.credential_hash === row.credential_hash, 'PAIRING_UNAVAILABLE', 404);
      if (row.state === 'confirmed') return this.pairingPublic(row);
      requireValue(row.state === 'proposed' && row.proposal_expires > this.now(), 'PAIRING_UNAVAILABLE', 404);
      let device = this.db.prepare('SELECT * FROM devices WHERE key_id=?').get(row.key_id);
      requireValue(!device || (!device.revoked && device.public_key === row.public_key &&
        device.extension_origin === row.extension_origin && this.linked(row.client_id, device.id, row.tenant_id)),
        'PAIRING_UNAVAILABLE', 404);
      if (!device) {
        const id = randomUUID();
        this.db.prepare(`INSERT INTO devices(id,key_id,public_key,extension_origin,label,tenant_id)
          VALUES(?,?,?,?,?,?)`).run(id, row.key_id, row.public_key, row.extension_origin, row.label, row.tenant_id);
        this.db.prepare('INSERT INTO client_devices VALUES(?,?,?)').run(row.client_id, id, row.tenant_id);
        device = this.device(id);
      }
      this.db.prepare("UPDATE pairings SET state='confirmed',device_id=? WHERE id=?").run(device.id, row.id);
      return this.pairingPublic(this.db.prepare('SELECT * FROM pairings WHERE id=?').get(row.id));
    });
  }
  pairingCancel(value) {
    const row = this.pairing(value.request_id, value.key_id, value.receipt);
    requireValue(row, 'PAIRING_UNAVAILABLE', 404);
    requireValue(row.state !== 'confirmed', 'PAIRING_UNAVAILABLE', 404);
    this.db.prepare("UPDATE pairings SET state='cancelled',nonce=NULL WHERE id=?").run(row.id);
    return { state: 'cancelled' };
  }
}
