import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { tenantId } from '../shared/protocol.js';
import { requireValue } from './errors.js';

export const token = () => randomBytes(32).toString('base64url');
export const newTenantId = () => `t_${randomBytes(16).toString('base64url')}`;
export const hash = value => createHash('sha256').update(value).digest('hex');

export function initializeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS owners (
      id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL,
      label TEXT NOT NULL, admitted INTEGER NOT NULL DEFAULT 0,
      disabled INTEGER NOT NULL DEFAULT 0, invitation_expires INTEGER NOT NULL,
      UNIQUE(issuer,subject)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id),
      csrf TEXT NOT NULL, expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES owners(id),
      enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS tenant_members (
      tenant_id TEXT NOT NULL REFERENCES tenants(id), owner_id TEXT NOT NULL REFERENCES owners(id),
      PRIMARY KEY(tenant_id,owner_id)
    );
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id), label TEXT NOT NULL,
      credential_hash TEXT UNIQUE NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
      tenant_id TEXT NOT NULL UNIQUE REFERENCES tenants(id), UNIQUE(id,tenant_id)
    );
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, key_id TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL, extension_origin TEXT NOT NULL, label TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0, tenant_id TEXT NOT NULL,
      FOREIGN KEY(tenant_id,owner_id) REFERENCES tenant_members(tenant_id,owner_id),
      UNIQUE(id,tenant_id)
    );
    CREATE TABLE IF NOT EXISTS enrollments (
      id TEXT PRIMARY KEY, key_id TEXT NOT NULL, public_key TEXT NOT NULL,
      extension_origin TEXT NOT NULL, label TEXT NOT NULL, nonce TEXT NOT NULL,
      owner_id TEXT, expires INTEGER NOT NULL, tenant_id TEXT NOT NULL REFERENCES tenants(id),
      FOREIGN KEY(tenant_id,owner_id) REFERENCES tenant_members(tenant_id,owner_id)
    );
    CREATE TABLE IF NOT EXISTS setup_requests (
      id TEXT PRIMARY KEY, agent_name TEXT NOT NULL, request_description TEXT NOT NULL,
      token_hash TEXT NOT NULL, receipt_hash TEXT NOT NULL, expires INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending', tenant_id TEXT REFERENCES tenants(id)
    );
    PRAGMA user_version=2;
  `);
}

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    const columns = this.db.prepare('PRAGMA table_info(clients)').all();
    if (columns.length && !columns.some(column => column.name === 'tenant_id')) {
      this.db.close();
      requireValue(false, 'TENANT_MIGRATION_REQUIRED');
    }
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 2) {
      this.db.close();
      requireValue(false, 'SCHEMA_VERSION_UNSUPPORTED');
    }
    initializeSchema(this.db);
  }
  close() { this.db.close(); }
  transaction(run) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  invite(issuer, subject, label) {
    requireValue(typeof subject === 'string' && subject && typeof label === 'string' &&
      label.trim() && label.length <= 80, 'INVALID_INVITATION');
    const owner = this.db.prepare(`INSERT INTO owners(id,issuer,subject,label,invitation_expires)
      VALUES(?,?,?,?,?) ON CONFLICT(issuer,subject) DO UPDATE SET
      label=excluded.label,invitation_expires=excluded.invitation_expires
      WHERE owners.admitted=0 AND owners.disabled=0 RETURNING id`)
      .get(randomUUID(), issuer, subject, label.trim(), Date.now() + 7 * 86400_000);
    requireValue(owner, 'OWNER_ALREADY_REGISTERED');
    return owner.id;
  }
  admit(issuer, subject, label = 'Connected user') {
    requireValue(typeof issuer === 'string' && issuer && typeof subject === 'string' && subject &&
      typeof label === 'string' && label.trim() && label.length <= 80, 'OIDC_IDENTITY_INVALID', 403);
    this.db.prepare(`INSERT INTO owners(id,issuer,subject,label,admitted,invitation_expires)
      VALUES(?,?,?,?,1,0) ON CONFLICT(issuer,subject) DO NOTHING`)
      .run(randomUUID(), issuer, subject, label.trim());
    const owner = this.db.prepare('SELECT * FROM owners WHERE issuer=? AND subject=?').get(issuer, subject);
    requireValue(owner && !owner.disabled, 'OWNER_DISABLED', 403);
    this.db.prepare('UPDATE owners SET admitted=1 WHERE id=?').run(owner.id);
    return this.owner(owner.id);
  }
  owner(id) {
    return this.db.prepare('SELECT * FROM owners WHERE id=? AND disabled=0 AND admitted=1').get(id);
  }
  createSession(ownerId) {
    requireValue(this.owner(ownerId), 'NOT_AUTHORIZED', 403);
    this.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    const credential = token();
    const csrf = token();
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)')
      .run(hash(credential), ownerId, csrf, Date.now() + 8 * 3600_000);
    return { token: credential, csrf };
  }
  session(credential) {
    return this.db.prepare(`SELECT s.*,o.label FROM sessions s JOIN owners o ON o.id=s.owner_id
      WHERE s.hash=? AND s.expires>? AND o.disabled=0 AND o.admitted=1`)
      .get(hash(credential), Date.now());
  }
  logout(credential) { this.db.prepare('DELETE FROM sessions WHERE hash=?').run(hash(credential)); }
  tenant(id) {
    return this.db.prepare(`SELECT t.* FROM tenants t JOIN owners o ON o.id=t.owner_id
      WHERE t.id=? AND t.enabled=1 AND o.admitted=1 AND o.disabled=0`).get(id);
  }
  member(ownerId, tenant) {
    return Boolean(this.owner(ownerId) && this.tenant(tenant) &&
      this.db.prepare('SELECT 1 FROM tenant_members WHERE tenant_id=? AND owner_id=?').get(tenant, ownerId));
  }
  owns(ownerId, tenant) { return this.tenant(tenant)?.owner_id === ownerId && Boolean(this.owner(ownerId)); }
  createTenant(ownerId, label) {
    requireValue(this.owner(ownerId) && typeof label === 'string' && label.trim() &&
      label.length <= 80, 'INVALID_TENANT');
    const id = newTenantId();
    this.db.prepare('INSERT INTO tenants(id,label,owner_id) VALUES(?,?,?)').run(id, label.trim(), ownerId);
    this.db.prepare('INSERT INTO tenant_members VALUES(?,?)').run(id, ownerId);
    return this.tenant(id);
  }
  addMember(ownerId, tenant, memberId) {
    requireValue(this.owns(ownerId, tenant) && this.owner(memberId), 'NOT_AUTHORIZED', 403);
    this.db.prepare('INSERT OR IGNORE INTO tenant_members VALUES(?,?)').run(tenant, memberId);
  }
  removeMember(ownerId, tenant, memberId) {
    requireValue(this.owns(ownerId, tenant) && memberId !== ownerId, 'NOT_AUTHORIZED', 403);
    this.db.prepare('DELETE FROM enrollments WHERE tenant_id=? AND owner_id=?').run(tenant, memberId);
    this.db.prepare('DELETE FROM devices WHERE tenant_id=? AND owner_id=?').run(tenant, memberId);
    this.db.prepare('DELETE FROM tenant_members WHERE tenant_id=? AND owner_id=?').run(tenant, memberId);
  }
  tenantsForOwner(ownerId) {
    return this.db.prepare(`SELECT t.* FROM tenants t JOIN tenant_members m ON m.tenant_id=t.id
      JOIN owners o ON o.id=t.owner_id WHERE m.owner_id=? AND t.enabled=1 AND o.disabled=0 AND o.admitted=1`)
      .all(ownerId);
  }
  enrollmentStart(value) {
    requireValue(this.tenant(tenantId(value.tenant_id)), 'TENANT_UNAVAILABLE', 404);
    this.db.prepare('DELETE FROM enrollments WHERE expires<?').run(Date.now());
    requireValue(this.db.prepare('SELECT count(*) AS n FROM enrollments').get().n < 1000, 'RATE_LIMITED', 429);
    requireValue(!this.db.prepare('SELECT id FROM devices WHERE key_id=?').get(value.key_id),
      'KEY_ALREADY_ENROLLED', 409);
    this.db.prepare(`INSERT INTO enrollments
      (id,key_id,public_key,extension_origin,label,nonce,expires,tenant_id) VALUES(?,?,?,?,?,?,?,?)`)
      .run(value.id, value.key_id, JSON.stringify(value.public_key), value.extension_origin,
        value.label, value.nonce, value.expires, value.tenant_id);
  }
  enrollment(id, tenant) {
    return this.db.prepare('SELECT * FROM enrollments WHERE id=? AND tenant_id=? AND expires>?')
      .get(id, tenant, Date.now());
  }
  approveEnrollment(id, ownerId, tenant) {
    const e = this.enrollment(id, tenant);
    requireValue(e && this.member(ownerId, tenant) && (!e.owner_id || e.owner_id === ownerId),
      'ENROLLMENT_UNAVAILABLE', 404);
    this.db.prepare('UPDATE enrollments SET owner_id=? WHERE id=? AND tenant_id=?').run(ownerId, id, tenant);
  }
  confirmEnrollment(id, tenant) {
    const e = this.enrollment(id, tenant);
    requireValue(e && this.member(e.owner_id, tenant), 'ENROLLMENT_UNAVAILABLE', 404);
    return this.transaction(() => {
      const deviceId = randomUUID();
      this.db.prepare('INSERT INTO devices VALUES(?,?,?,?,?,?,0,?)')
        .run(deviceId, e.owner_id, e.key_id, e.public_key, e.extension_origin, e.label, tenant);
      this.db.prepare('DELETE FROM enrollments WHERE id=? AND tenant_id=?').run(id, tenant);
      return this.device(deviceId, tenant);
    });
  }
  device(id, tenant) {
    const d = this.db.prepare('SELECT * FROM devices WHERE id=? AND revoked=0').get(id);
    return d && (!tenant || d.tenant_id === tenant) && this.member(d.owner_id, d.tenant_id) ? d : undefined;
  }
  deviceByKey(id, tenant) {
    const d = this.db.prepare('SELECT id FROM devices WHERE key_id=? AND tenant_id=?').get(id, tenant);
    return d && this.device(d.id, tenant);
  }
  createClient(ownerId, label, tenant) {
    requireValue(this.owns(ownerId, tenant) && typeof label === 'string' &&
      label.trim() && label.length <= 80, 'INVALID_CLIENT');
    const credential = token();
    const id = randomUUID();
    this.db.prepare('INSERT INTO clients VALUES(?,?,?,?,0,?)').run(id, ownerId, label.trim(), hash(credential), tenant);
    return { id, credential, tenant_id: tenant };
  }
  client(id, tenant) {
    const c = this.db.prepare('SELECT * FROM clients WHERE id=? AND revoked=0').get(id);
    return c && (!tenant || c.tenant_id === tenant) && this.member(c.owner_id, c.tenant_id) ? c : undefined;
  }
  rotateClient(ownerId, id, tenant) {
    requireValue(this.owns(ownerId, tenant) && this.client(id, tenant), 'NOT_AUTHORIZED', 403);
    const credential = token();
    this.db.prepare('UPDATE clients SET credential_hash=? WHERE id=? AND tenant_id=?').run(hash(credential), id, tenant);
    return { id, credential, tenant_id: tenant };
  }
  authenticateClient(credential, tenant) {
    const c = this.db.prepare('SELECT id FROM clients WHERE credential_hash=? AND tenant_id=?')
      .get(hash(credential), tenant);
    return c && this.client(c.id, tenant);
  }
  linked(clientId, deviceId, tenant) {
    const c = this.client(clientId, tenant);
    const d = this.device(deviceId, tenant);
    return Boolean(c && d && c.tenant_id === d.tenant_id);
  }
  devicesForClient(clientId, tenant) {
    const c = this.client(clientId, tenant);
    if (!c) return [];
    return this.db.prepare('SELECT id FROM devices WHERE tenant_id=? AND revoked=0')
      .all(c.tenant_id).map(d => this.device(d.id, c.tenant_id)).filter(Boolean);
  }
  clientsForDevice(deviceId, tenant) {
    const device = this.device(deviceId, tenant);
    requireValue(device, 'NOT_AUTHORIZED', 403);
    return this.db.prepare('SELECT id,label FROM clients WHERE tenant_id=? AND revoked=0')
      .all(device.tenant_id).filter(client => this.linked(client.id, deviceId, tenant));
  }
  devicesForOwner(ownerId, tenant) {
    return this.db.prepare('SELECT id,label FROM devices WHERE owner_id=? AND tenant_id=? AND revoked=0')
      .all(ownerId, tenant);
  }
  clientsForOwner(ownerId, tenant) {
    return this.db.prepare('SELECT id,label FROM clients WHERE owner_id=? AND tenant_id=? AND revoked=0')
      .all(ownerId, tenant);
  }
  revoke(ownerId, kind, id, tenant) {
    requireValue(['client', 'device'].includes(kind), 'INVALID_ARGUMENTS');
    const record = kind === 'client' ? this.client(id, tenant) : this.device(id, tenant);
    requireValue(record && (record.owner_id === ownerId || this.owns(ownerId, tenant)),
      'NOT_AUTHORIZED', 403);
    this.db.prepare(`UPDATE ${kind === 'client' ? 'clients' : 'devices'} SET revoked=1 WHERE id=? AND tenant_id=?`)
      .run(id, tenant);
  }
  disableTenant(ownerId, tenant) {
    requireValue(this.owns(ownerId, tenant), 'NOT_AUTHORIZED', 403);
    this.db.prepare('UPDATE tenants SET enabled=0 WHERE id=?').run(tenant);
  }
  disableOwner(ownerId) { this.db.prepare('UPDATE owners SET disabled=1 WHERE id=?').run(ownerId); }
  createSetup(name, description) {
    requireValue(typeof name === 'string' && name.trim() && name.length <= 80 &&
      typeof description === 'string' && description.trim() && description.length <= 500, 'INVALID_SETUP_REQUEST');
    this.db.prepare('DELETE FROM setup_requests WHERE expires<?').run(Date.now());
    requireValue(this.db.prepare('SELECT count(*) AS n FROM setup_requests').get().n < 1000, 'RATE_LIMITED', 429);
    const id = randomUUID();
    const setupToken = token();
    const receipt = token();
    const expires = Date.now() + 900_000;
    this.db.prepare(`INSERT INTO setup_requests(id,agent_name,request_description,token_hash,receipt_hash,expires)
      VALUES(?,?,?,?,?,?)`).run(id, name.trim(), description.trim(), hash(setupToken), hash(receipt), expires);
    return { id, token: setupToken, receipt, expires };
  }
  setup(id) {
    return this.db.prepare('SELECT * FROM setup_requests WHERE id=? AND expires>?').get(id, Date.now());
  }
  setupWithToken(id, credential) {
    return this.db.prepare('SELECT * FROM setup_requests WHERE id=? AND token_hash=? AND expires>?')
      .get(id, hash(credential), Date.now());
  }
  setupWithReceipt(id, receipt) {
    return this.db.prepare('SELECT state,tenant_id,expires FROM setup_requests WHERE id=? AND receipt_hash=? AND expires>?')
      .get(id, hash(receipt), Date.now());
  }
  approveSetup(id, credential, ownerId) {
    return this.transaction(() => {
      const request = this.setupWithToken(id, credential);
      requireValue(request?.state === 'pending' && this.owner(ownerId), 'SETUP_UNAVAILABLE', 404);
      const tenant = this.createTenant(ownerId, request.agent_name);
      const client = this.createClient(ownerId, request.agent_name, tenant.id);
      this.db.prepare("UPDATE setup_requests SET state='approved',tenant_id=?,token_hash='' WHERE id=?")
        .run(tenant.id, id);
      return { tenant, client };
    });
  }
  denySetup(id, credential, ownerId) {
    requireValue(this.owner(ownerId) && this.setupWithToken(id, credential)?.state === 'pending',
      'SETUP_UNAVAILABLE', 404);
    this.db.prepare("UPDATE setup_requests SET state='denied',token_hash='' WHERE id=?").run(id);
  }
}
