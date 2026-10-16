import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { SESSION_RETENTION_MS, UNPAIRED_BROWSER_MS, PAIRED_BROWSER_MS, validName } from '../shared/protocol.js';
import { requireValue } from './errors.js';

export const SCHEMA_VERSION = 6;
export const REFRESH_GRACE_MS = 300_000;
export const token = () => randomBytes(32).toString('base64url');
export const hash = value => createHash('sha256').update(value).digest('hex');
export const cleanText = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);

export function initializeSchema(db) {
  db.exec(`
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE browsers (id TEXT PRIMARY KEY, name TEXT NOT NULL, key_id TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL, extension_origin TEXT NOT NULL, created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL, refresh_hash TEXT NOT NULL UNIQUE, previous_refresh_hash TEXT,
      rotated_at INTEGER NOT NULL);
    CREATE TABLE pairings (agent_id TEXT NOT NULL,
      browser_id TEXT NOT NULL REFERENCES browsers(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, PRIMARY KEY(agent_id, browser_id));
    CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, browser_id TEXT NOT NULL,
      group_id TEXT NOT NULL UNIQUE, group_client_id TEXT NOT NULL, purpose TEXT NOT NULL,
      title TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      UNIQUE(browser_id, group_client_id),
      FOREIGN KEY(agent_id, browser_id) REFERENCES pairings(agent_id, browser_id) ON DELETE CASCADE);
    CREATE TABLE tabs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      url TEXT NOT NULL, title TEXT NOT NULL);
    PRAGMA user_version=6;
  `);
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
      // Clean break: older layouts are never upgraded in place.
      else requireValue(version === SCHEMA_VERSION, 'SCHEMA_VERSION_UNSUPPORTED');
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  transaction(run) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = run(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  nextId(prefix) {
    const key = `seq:${prefix}`;
    const current = Number(this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value || 0) + 1;
    this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, String(current));
    return `${prefix}${current.toString(36)}`;
  }

  registerBrowser({ name, key_id, public_key, extension_origin }) {
    requireValue(validName(name), 'INVALID_ARGUMENTS');
    return this.transaction(() => {
      requireValue(!this.db.prepare('SELECT 1 FROM browsers WHERE key_id=?').get(key_id), 'KEY_ALREADY_REGISTERED', 409);
      requireValue(this.db.prepare('SELECT count(*) AS n FROM browsers').get().n < 10_000, 'RATE_LIMITED', 429);
      const id = this.nextId('b'), refresh = token(), now = this.now();
      this.db.prepare(`INSERT INTO browsers(id,name,key_id,public_key,extension_origin,created_at,last_seen,refresh_hash,rotated_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(id, name.trim(), key_id, JSON.stringify(public_key), extension_origin,
        now, now, hash(refresh), now);
      return { id, refresh_token: refresh };
    });
  }
  browser(id) { return this.db.prepare('SELECT * FROM browsers WHERE id=?').get(id); }
  listBrowsers() {
    return this.db.prepare(`SELECT b.id,b.name,b.created_at,b.last_seen,
      (SELECT count(*) FROM pairings p WHERE p.browser_id=b.id) AS pairings FROM browsers b ORDER BY b.created_at`).all();
  }
  /** Rotates the refresh token. Reuse of a superseded token outside a short grace window revokes the browser. */
  rotateRefresh(browserId, presented) {
    const next = this.transaction(() => {
      const row = this.browser(browserId);
      if (!row || typeof presented !== 'string' || presented.length > 128) return null;
      const digest = hash(presented);
      if (digest !== row.refresh_hash) {
        const withinGrace = this.now() - row.rotated_at <= REFRESH_GRACE_MS;
        if (digest !== row.previous_refresh_hash) return null;
        if (!withinGrace) {
          this.db.prepare('DELETE FROM browsers WHERE id=?').run(browserId);
          return null;
        }
      }
      const value = token();
      this.db.prepare(`UPDATE browsers SET previous_refresh_hash=refresh_hash, refresh_hash=?, rotated_at=?, last_seen=?
        WHERE id=?`).run(hash(value), this.now(), this.now(), browserId);
      return value;
    });
    requireValue(next, 'NOT_AUTHORIZED', 401);
    return next;
  }
  renameBrowser(id, name) {
    requireValue(validName(name), 'INVALID_ARGUMENTS');
    requireValue(this.db.prepare('UPDATE browsers SET name=? WHERE id=?').run(name.trim(), id).changes === 1, 'NOT_FOUND', 404);
  }
  touchBrowser(id) { this.db.prepare('UPDATE browsers SET last_seen=? WHERE id=?').run(this.now(), id); }
  deleteBrowser(id) { return this.db.prepare('DELETE FROM browsers WHERE id=?').run(id).changes === 1; }

  /** Pairs and returns the browser's name, suffixed " (n)" if another of the agent's browsers already uses it. */
  pair(agentId, browserId) {
    return this.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO pairings(agent_id,browser_id,created_at) VALUES(?,?,?)')
        .run(agentId, browserId, this.now());
      const { name } = this.browser(browserId);
      const taken = new Set(this.db.prepare(`SELECT b.name FROM pairings p JOIN browsers b ON b.id=p.browser_id
        WHERE p.agent_id=? AND b.id<>?`).all(agentId, browserId).map(row => row.name));
      if (!taken.has(name)) return name;
      const base = name.replace(/ \(\d+\)$/, '');
      let n = 2, unique;
      do { const suffix = ` (${n++})`; unique = `${base.slice(0, 80 - suffix.length)}${suffix}`; } while (taken.has(unique));
      this.db.prepare('UPDATE browsers SET name=? WHERE id=?').run(unique, browserId);
      return unique;
    });
  }
  unpair(agentId, browserId) {
    return this.db.prepare('DELETE FROM pairings WHERE agent_id=? AND browser_id=?').run(agentId, browserId).changes === 1;
  }
  paired(agentId, browserId) {
    return Boolean(this.db.prepare('SELECT 1 FROM pairings WHERE agent_id=? AND browser_id=?').get(agentId, browserId));
  }
  browsersForAgent(agentId) {
    return this.db.prepare(`SELECT b.id,b.name,b.last_seen,p.created_at AS paired_at FROM pairings p
      JOIN browsers b ON b.id=p.browser_id WHERE p.agent_id=? ORDER BY p.created_at`).all(agentId);
  }
  agentsForBrowser(browserId) {
    return this.db.prepare('SELECT agent_id,created_at FROM pairings WHERE browser_id=? ORDER BY created_at').all(browserId);
  }
  listPairings() { return this.db.prepare('SELECT agent_id,browser_id,created_at FROM pairings ORDER BY created_at').all(); }
  pruneAgents(knownIds) {
    const known = new Set(knownIds);
    for (const { agent_id } of this.db.prepare('SELECT DISTINCT agent_id FROM pairings').all()) {
      if (!known.has(agent_id)) this.db.prepare('DELETE FROM pairings WHERE agent_id=?').run(agent_id);
    }
  }

  createSession({ agent_id, browser_id, group_client_id, purpose, title }) {
    return this.transaction(() => {
      requireValue(this.paired(agent_id, browser_id), 'NOT_FOUND', 404);
      requireValue(!this.db.prepare('SELECT 1 FROM sessions WHERE browser_id=? AND group_client_id=?')
        .get(browser_id, group_client_id), 'INVALID_MESSAGE');
      const id = this.nextId('s'), group = this.nextId('g'), now = this.now();
      this.db.prepare(`INSERT INTO sessions(id,agent_id,browser_id,group_id,group_client_id,purpose,title,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(id, agent_id, browser_id, group, group_client_id, purpose, cleanText(title, 120),
        now, now + SESSION_RETENTION_MS);
      return this.session(id);
    });
  }
  session(id) { return this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id); }
  sessionsForBrowser(browserId) {
    return this.db.prepare('SELECT * FROM sessions WHERE browser_id=? ORDER BY created_at').all(browserId);
  }
  sessionsForAgent(agentId) {
    return this.db.prepare('SELECT * FROM sessions WHERE agent_id=? ORDER BY created_at').all(agentId);
  }
  listSessions() { return this.db.prepare('SELECT * FROM sessions ORDER BY created_at').all(); }
  keepSession(id, title) {
    this.db.prepare('UPDATE sessions SET title=?, expires_at=? WHERE id=?')
      .run(cleanText(title, 120), this.now() + SESSION_RETENTION_MS, id);
  }
  deleteSession(id) { return this.db.prepare('DELETE FROM sessions WHERE id=?').run(id).changes === 1; }

  tabsForSession(sessionId) { return this.db.prepare('SELECT * FROM tabs WHERE session_id=? ORDER BY rowid').all(sessionId); }
  tab(id) { return this.db.prepare('SELECT * FROM tabs WHERE id=?').get(id); }
  createTab(sessionId, url, title) {
    return this.transaction(() => {
      const id = this.nextId('t');
      this.db.prepare('INSERT INTO tabs(id,session_id,url,title) VALUES(?,?,?,?)')
        .run(id, sessionId, cleanText(url, 2048), cleanText(title, 160));
      return id;
    });
  }
  updateTab(id, url, title) {
    this.db.prepare('UPDATE tabs SET url=?, title=? WHERE id=?').run(cleanText(url, 2048), cleanText(title, 160), id);
  }
  deleteTab(id) { this.db.prepare('DELETE FROM tabs WHERE id=?').run(id); }

  sweep() {
    const now = this.now();
    const expired = this.db.prepare('SELECT id FROM sessions WHERE expires_at<=?').all(now).map(row => row.id);
    for (const id of expired) this.deleteSession(id);
    // Pairings and sessions cascade. Online browsers are touched every heartbeat, so only offline ones age out.
    const stale = this.db.prepare(`SELECT id FROM browsers WHERE last_seen<=? OR (last_seen<=? AND NOT EXISTS
      (SELECT 1 FROM pairings p WHERE p.browser_id=browsers.id))`)
      .all(now - PAIRED_BROWSER_MS, now - UNPAIRED_BROWSER_MS).map(row => row.id);
    for (const id of stale) this.deleteBrowser(id);
    return { sessions: expired, browsers: stale };
  }
}
