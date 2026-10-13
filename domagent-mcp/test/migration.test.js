import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../store.js';
import { preview, migrate, verifyMigration } from '../migrate.js';

function legacy() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE owners(id TEXT PRIMARY KEY,issuer TEXT,subject TEXT,label TEXT,admitted INTEGER,disabled INTEGER,invitation_expires INTEGER);
    CREATE TABLE tenants(id TEXT PRIMARY KEY,label TEXT,owner_id TEXT,enabled INTEGER);
    CREATE TABLE tenant_members(tenant_id TEXT,owner_id TEXT);
    CREATE TABLE clients(id TEXT PRIMARY KEY,owner_id TEXT,label TEXT,credential_hash TEXT,revoked INTEGER,tenant_id TEXT);
    CREATE TABLE devices(id TEXT PRIMARY KEY,owner_id TEXT,key_id TEXT,public_key TEXT,extension_origin TEXT,label TEXT,revoked INTEGER,tenant_id TEXT);
    CREATE TABLE sessions(hash TEXT,owner_id TEXT,csrf TEXT,expires INTEGER);
    CREATE TABLE enrollments(id TEXT,key_id TEXT,public_key TEXT,extension_origin TEXT,label TEXT,nonce TEXT,owner_id TEXT,expires INTEGER,tenant_id TEXT);
    CREATE TABLE setup_requests(id TEXT,agent_name TEXT,request_description TEXT,token_hash TEXT,receipt_hash TEXT,expires INTEGER,state TEXT,tenant_id TEXT);
    PRAGMA user_version=2;
    INSERT INTO owners VALUES('owner','https://old.test','subject','Owner',1,0,1);
    INSERT INTO tenants VALUES('t_abcdefghijklmnopqrstuv','Atlas','owner',1);
    INSERT INTO tenant_members VALUES('t_abcdefghijklmnopqrstuv','owner');
    INSERT INTO clients VALUES('client','owner','Atlas','credential-hash',0,'t_abcdefghijklmnopqrstuv');
    INSERT INTO devices VALUES('device','owner','key','public-key','moz-extension://uuid','My browser',0,'t_abcdefghijklmnopqrstuv');
    INSERT INTO sessions VALUES('session','owner','csrf',1);
  `);
  return db;
}
test('explicit schema migration preserves IDs, keys, hashes, revocations and historical bindings, not sessions', () => {
  const db = legacy();
  try {
    const before = db.prepare('SELECT * FROM devices').get();
    assert.equal(preview(db).can_migrate, true);
    const result = migrate(db);
    assert.equal(result.schema_version, 3);
    assert.equal(verifyMigration(db).verified, true);
    const after = db.prepare('SELECT * FROM devices').get();
    for (const field of Object.keys(before)) assert.equal(after[field], before[field]);
    assert.equal(db.prepare('SELECT count(*) AS n FROM legacy_sessions').get().n, 0);
    assert.deepEqual({ ...db.prepare('SELECT * FROM client_devices').get() },
      { client_id: 'client', device_id: 'device', tenant_id: 't_abcdefghijklmnopqrstuv' });
    assert.throws(() => migrate(db), /ALREADY_MIGRATED/);
  } finally { db.close(); }
  const store = new Store(':memory:');
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 3);
  store.close();
});
test('ambiguous multiowner migration and unknown schema are rejected transactionally without flattening', () => {
  const db = legacy();
  try {
    db.exec("INSERT INTO owners VALUES('other','https://old.test','other','Other',1,0,1); INSERT INTO tenant_members VALUES('t_abcdefghijklmnopqrstuv','other')");
    assert.equal(preview(db).can_migrate, false);
    assert.throws(() => migrate(db), /MULTIOWNER_MAPPING_REQUIRED/);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
    assert.equal(db.prepare("SELECT count(*) AS n FROM devices").get().n, 1);
    db.exec('CREATE TABLE unexpected(id TEXT)');
    assert.throws(() => preview(db), /UNKNOWN_SCHEMA_LAYOUT/);
  } finally { db.close(); }
});
test('migration records disabled legacy accounts and preserves revoked flags rather than resurrecting access', () => {
  const db = legacy();
  try {
    db.exec("UPDATE owners SET disabled=1; UPDATE devices SET revoked=1; UPDATE clients SET revoked=1");
    migrate(db);
    assert.equal(db.prepare('SELECT legacy_disabled FROM clients').get().legacy_disabled, 1);
    assert.equal(db.prepare('SELECT revoked FROM clients').get().revoked, 1);
    assert.equal(db.prepare('SELECT revoked FROM devices').get().revoked, 1);
    assert.equal(verifyMigration(db).verified, true);
  } finally { db.close(); }
});
