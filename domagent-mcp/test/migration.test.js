import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preview, migrate } from '../migrate.js';
import { Store, hash } from '../store.js';

function legacy(db) {
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE owners(id TEXT PRIMARY KEY,issuer TEXT,subject TEXT,label TEXT,admitted INTEGER,disabled INTEGER,invitation_expires INTEGER,UNIQUE(issuer,subject));
    CREATE TABLE sessions(hash TEXT PRIMARY KEY,owner_id TEXT REFERENCES owners(id),csrf TEXT,expires INTEGER);
    CREATE TABLE clients(id TEXT PRIMARY KEY,owner_id TEXT REFERENCES owners(id),label TEXT,credential_hash TEXT UNIQUE,revoked INTEGER);
    CREATE TABLE devices(id TEXT PRIMARY KEY,owner_id TEXT REFERENCES owners(id),key_id TEXT UNIQUE,public_key TEXT,extension_origin TEXT,label TEXT,revoked INTEGER);
    CREATE TABLE links(client_id TEXT REFERENCES clients(id),device_id TEXT REFERENCES devices(id),PRIMARY KEY(client_id,device_id));
    CREATE TABLE enrollments(id TEXT PRIMARY KEY,key_id TEXT,public_key TEXT,extension_origin TEXT,label TEXT,nonce TEXT,owner_id TEXT REFERENCES owners(id),expires INTEGER);
    INSERT INTO owners VALUES('owner','https://idp.test','owner','Owner',1,0,0);
    INSERT INTO owners VALUES('member','https://idp.test','member','Member',1,0,0);
    INSERT INTO clients VALUES('client','owner','Old client','fixture-hash',0);
    INSERT INTO devices VALUES('device','member','legacy-key','{}','chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','Old browser',0);
    INSERT INTO links VALUES('client','device');
  `);
}

test('legacy database requires explicit complete assignments and fresh browser pairing', () => {
  const directory = mkdtempSync(join(tmpdir(), 'domagent-migration-'));
  const path = join(directory, 'legacy.db');
  let db;
  let store;
  try {
    db = new DatabaseSync(path);
    legacy(db);
    db.prepare('UPDATE clients SET credential_hash=? WHERE id=?').run(hash('old-credential'), 'client');
    const report = preview(db);
    assert.equal(report.clients[0].client_id, 'client');
    assert.equal(report.browser_owners[0].owner_id, 'member');
    assert(!JSON.stringify(report).includes(hash('old-credential')));
    assert.throws(() => migrate(db, []), /INCOMPLETE_ASSIGNMENTS/);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0);
    assert.throws(() => new Store(path), /TENANT_MIGRATION_REQUIRED/);
    const migrated = migrate(db, [{ client_id: 'client', owner_id: 'owner', label: 'Atlas', members: ['member'] }]);
    assert.equal(migrated.length, 1);
    assert.equal(preview(db).migration_required, false);
    assert.throws(() => migrate(db, []), /ALREADY_MIGRATED/);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    db.close(); db = undefined;
    store = new Store(path);
    const tenant = migrated[0].tenant_id;
    assert.equal(store.authenticateClient('old-credential', tenant).id, 'client');
    assert.equal(store.member('member', tenant), true);
    assert.deepEqual(store.devicesForClient('client'), []);
    assert.equal(store.deviceByKey('legacy-key', tenant), undefined);
  } finally {
    store?.close(); db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('invalid migration input leaves legacy state unchanged', () => {
  const db = new DatabaseSync(':memory:');
  try {
    legacy(db);
    assert.throws(() => migrate(db, [{ client_id: 'unknown', owner_id: 'owner', label: 'Atlas' }]));
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0);
    assert.equal(db.prepare('SELECT key_id FROM devices').get().key_id, 'legacy-key');
  } finally { db.close(); }
});

test('failure during migration rolls back schema and credential mutations', () => {
  const db = new DatabaseSync(':memory:');
  try {
    legacy(db);
    const prepare = db.prepare.bind(db);
    db.prepare = sql => {
      if (sql.includes('INSERT INTO clients(id,owner_id,label,credential_hash')) throw new Error('Injected migration write failure');
      return prepare(sql);
    };
    assert.throws(() => migrate(db, [{ client_id: 'client', owner_id: 'owner', label: 'Atlas' }]),
      /Injected migration write failure/);
    db.prepare = prepare;
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0);
    assert.equal(db.prepare('SELECT credential_hash FROM clients').get().credential_hash, 'fixture-hash');
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='legacy_clients'").get(), undefined);
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  } finally { db.close(); }
});
