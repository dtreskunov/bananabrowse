import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { requireValue } from './errors.js';

export const token = () => randomBytes(32).toString('base64url');
export const hash = value => createHash('sha256').update(value).digest('hex');

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA foreign_keys=ON;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
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
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id),
        key_id TEXT NOT NULL UNIQUE, public_key TEXT NOT NULL,
        extension_origin TEXT NOT NULL, label TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS clients (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id),
        label TEXT NOT NULL, credential_hash TEXT UNIQUE NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS links (
        client_id TEXT NOT NULL REFERENCES clients(id), device_id TEXT NOT NULL REFERENCES devices(id),
        PRIMARY KEY(client_id,device_id)
      );
      CREATE TABLE IF NOT EXISTS enrollments (
        id TEXT PRIMARY KEY, key_id TEXT NOT NULL, public_key TEXT NOT NULL,
        extension_origin TEXT NOT NULL, label TEXT NOT NULL, nonce TEXT NOT NULL,
        owner_id TEXT REFERENCES owners(id), expires INTEGER NOT NULL
      );
    `);
  }
  close() { this.db.close(); }
  invite(issuer, subject, label) {
    requireValue(subject && label && label.length <= 80, 'INVALID_INVITATION');
    const id = randomUUID();
    const owner = this.db.prepare(`INSERT INTO owners(id,issuer,subject,label,invitation_expires)
      VALUES(?,?,?,?,?) ON CONFLICT(issuer,subject) DO UPDATE SET
      label=excluded.label,invitation_expires=excluded.invitation_expires
      WHERE owners.admitted=0 AND owners.disabled=0 RETURNING id`)
      .get(id, issuer, subject, label, Date.now() + 7 * 86400_000);
    requireValue(owner, 'OWNER_ALREADY_REGISTERED');
    return owner.id;
  }
  admit(issuer, subject) {
    const owner = this.db.prepare('SELECT * FROM owners WHERE issuer=? AND subject=?')
      .get(issuer, subject);
    requireValue(owner && !owner.disabled &&
      (owner.admitted || owner.invitation_expires > Date.now()), 'OWNER_NOT_INVITED', 403);
    this.db.prepare('UPDATE owners SET admitted=1 WHERE id=?').run(owner.id);
    return owner;
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
  enrollmentStart(value) {
    this.db.prepare('DELETE FROM enrollments WHERE expires<?').run(Date.now());
    requireValue(this.db.prepare('SELECT count(*) AS n FROM enrollments').get().n < 1000,
      'RATE_LIMITED', 429);
    requireValue(!this.db.prepare('SELECT id FROM devices WHERE key_id=?').get(value.key_id),
      'KEY_ALREADY_ENROLLED', 409);
    this.db.prepare(`INSERT INTO enrollments
      (id,key_id,public_key,extension_origin,label,nonce,expires) VALUES(?,?,?,?,?,?,?)`)
      .run(value.id, value.key_id, JSON.stringify(value.public_key), value.extension_origin,
        value.label, value.nonce, value.expires);
  }
  enrollment(id) {
    return this.db.prepare('SELECT * FROM enrollments WHERE id=? AND expires>?').get(id, Date.now());
  }
  approveEnrollment(id, ownerId) {
    const e = this.enrollment(id);
    requireValue(e && this.owner(ownerId) && (!e.owner_id || e.owner_id === ownerId),
      'ENROLLMENT_UNAVAILABLE', 404);
    this.db.prepare('UPDATE enrollments SET owner_id=? WHERE id=?').run(ownerId, id);
  }
  confirmEnrollment(id) {
    const e = this.enrollment(id);
    requireValue(e && this.owner(e.owner_id), 'ENROLLMENT_UNAVAILABLE', 404);
    const deviceId = randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO devices VALUES(?,?,?,?,?,?,0)')
        .run(deviceId, e.owner_id, e.key_id, e.public_key, e.extension_origin, e.label);
      this.db.prepare('DELETE FROM enrollments WHERE id=?').run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.device(deviceId);
  }
  device(id) {
    return this.db.prepare(`SELECT d.* FROM devices d JOIN owners o ON o.id=d.owner_id
      WHERE d.id=? AND d.revoked=0 AND o.disabled=0 AND o.admitted=1`).get(id);
  }
  deviceByKey(id) {
    return this.db.prepare(`SELECT d.* FROM devices d JOIN owners o ON o.id=d.owner_id
      WHERE d.key_id=? AND d.revoked=0 AND o.disabled=0 AND o.admitted=1`).get(id);
  }
  createClient(ownerId, label) {
    requireValue(this.owner(ownerId) && typeof label === 'string' &&
      label.trim() && label.length <= 80, 'INVALID_CLIENT');
    const id = randomUUID();
    const credential = token();
    this.db.prepare('INSERT INTO clients VALUES(?,?,?,?,0)')
      .run(id, ownerId, label.trim(), hash(credential));
    return { id, credential };
  }
  client(id) {
    return this.db.prepare(`SELECT c.* FROM clients c JOIN owners o ON o.id=c.owner_id
      WHERE c.id=? AND c.revoked=0 AND o.disabled=0 AND o.admitted=1`).get(id);
  }
  rotateClient(ownerId, id) {
    requireValue(this.client(id)?.owner_id === ownerId, 'NOT_AUTHORIZED', 403);
    const credential = token();
    this.db.prepare('UPDATE clients SET credential_hash=? WHERE id=?').run(hash(credential), id);
    return { id, credential };
  }
  authenticateClient(credential) {
    return this.db.prepare(`SELECT c.* FROM clients c JOIN owners o ON o.id=c.owner_id
      WHERE c.credential_hash=? AND c.revoked=0 AND o.disabled=0 AND o.admitted=1`)
      .get(hash(credential));
  }
  link(ownerId, clientId, deviceId) {
    const c = this.client(clientId);
    const d = this.device(deviceId);
    requireValue(c && d && d.owner_id === ownerId,
      'NOT_AUTHORIZED', 403);
    this.db.prepare('INSERT OR IGNORE INTO links VALUES(?,?)').run(clientId, deviceId);
  }
  linked(clientId, deviceId) {
    return Boolean(this.client(clientId) && this.device(deviceId) &&
      this.db.prepare('SELECT 1 FROM links WHERE client_id=? AND device_id=?').get(clientId, deviceId));
  }
  devicesForClient(clientId) {
    return this.db.prepare(`SELECT d.* FROM devices d JOIN links l ON l.device_id=d.id
      JOIN owners o ON o.id=d.owner_id
      WHERE l.client_id=? AND d.revoked=0 AND o.disabled=0 AND o.admitted=1`).all(clientId);
  }
  devicesForOwner(ownerId) {
    return this.db.prepare('SELECT id,label FROM devices WHERE owner_id=? AND revoked=0').all(ownerId);
  }
  clientsForOwner(ownerId) {
    return this.db.prepare('SELECT id,label FROM clients WHERE owner_id=? AND revoked=0').all(ownerId);
  }
  linksForOwner(ownerId) {
    return this.db.prepare(`SELECT c.id AS client_id,c.label AS client_label,
      d.id AS device_id,d.label AS device_label FROM links l
      JOIN clients c ON c.id=l.client_id JOIN devices d ON d.id=l.device_id
      WHERE d.owner_id=? AND d.revoked=0 AND c.revoked=0`).all(ownerId);
  }
  unlink(ownerId, clientId, deviceId) {
    requireValue(this.device(deviceId)?.owner_id === ownerId, 'NOT_AUTHORIZED', 403);
    this.db.prepare('DELETE FROM links WHERE client_id=? AND device_id=?').run(clientId, deviceId);
  }
  revoke(ownerId, kind, id) {
    if (kind === 'client') {
      requireValue(this.client(id)?.owner_id === ownerId, 'NOT_AUTHORIZED', 403);
      this.db.prepare('UPDATE clients SET revoked=1 WHERE id=?').run(id);
    } else if (kind === 'device') {
      requireValue(this.device(id)?.owner_id === ownerId, 'NOT_AUTHORIZED', 403);
      this.db.prepare('UPDATE devices SET revoked=1 WHERE id=?').run(id);
    } else {
      requireValue(false, 'INVALID_ACTION');
    }
  }
  disableOwner(id) {
    requireValue(this.db.prepare('UPDATE owners SET disabled=1 WHERE id=?').run(id).changes,
      'OWNER_UNAVAILABLE');
  }
}
