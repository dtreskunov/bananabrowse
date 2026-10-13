#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { initializeSchema, SCHEMA_VERSION, hash } from './store.js';
import { requireValue, audit, failureCode } from './errors.js';

const required = {
  owners: ['id','issuer','subject','label','admitted','disabled','invitation_expires'],
  tenants: ['id','label','owner_id','enabled'],
  tenant_members: ['tenant_id','owner_id'],
  clients: ['id','owner_id','label','credential_hash','revoked','tenant_id'],
  devices: ['id','owner_id','key_id','public_key','extension_origin','label','revoked','tenant_id'],
  sessions: ['hash','owner_id','csrf','expires'],
  enrollments: ['id','key_id','public_key','extension_origin','label','nonce','owner_id','expires','tenant_id'],
  setup_requests: ['id','agent_name','request_description','token_hash','receipt_hash','expires','state','tenant_id'],
};
function version(db) { return db.prepare('PRAGMA user_version').get().user_version; }
function checkSource(db) {
  requireValue(version(db) === 2, 'KNOWN_SOURCE_SCHEMA_REQUIRED');
  const actual = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
  requireValue(actual.length === Object.keys(required).length && actual.every(name => Object.hasOwn(required, name)), 'UNKNOWN_SCHEMA_LAYOUT');
  for (const [table, columns] of Object.entries(required)) {
    const found = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    requireValue(found.length === columns.length && columns.every(c => found.includes(c)), 'UNKNOWN_SCHEMA_LAYOUT');
  }
  requireValue(db.prepare('PRAGMA foreign_key_check').all().length === 0 &&
    db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok', 'MIGRATION_INTEGRITY_FAILED');
}
export function preview(db) {
  if (version(db) === SCHEMA_VERSION) return { schema_version: SCHEMA_VERSION, migration_required: false, ...verifyMigration(db) };
  checkSource(db);
  const unusual = db.prepare(`SELECT t.id AS tenant_id FROM tenants t
    WHERE (SELECT count(*) FROM tenant_members m WHERE m.tenant_id=t.id) != 1
    OR NOT EXISTS(SELECT 1 FROM tenant_members m WHERE m.tenant_id=t.id AND m.owner_id=t.owner_id)
    OR EXISTS(SELECT 1 FROM clients c WHERE c.tenant_id=t.id AND c.owner_id!=t.owner_id)
    OR EXISTS(SELECT 1 FROM devices d WHERE d.tenant_id=t.id AND d.owner_id!=t.owner_id)`).all();
  const orphaned = db.prepare(`SELECT d.id AS device_id FROM devices d
    WHERE NOT EXISTS(SELECT 1 FROM clients c WHERE c.tenant_id=d.tenant_id)`).all();
  const mapping = db.prepare(`SELECT c.id AS client_id,c.tenant_id,c.owner_id,c.revoked,
    (SELECT count(*) FROM devices d WHERE d.tenant_id=c.tenant_id) AS device_count FROM clients c ORDER BY c.id`).all();
  return { schema_version: 2, migration_required: true, can_migrate: !unusual.length && !orphaned.length,
    unusual_multiowner: unusual, orphaned_devices: orphaned, clients: mapping,
    note: 'Explicit schema2 → schema3 only. IDs, keys, hashes, revoked flags and approved associations are preserved; runtime authority is discarded. Multi-owner mapping needs an explicitly reviewed separate migration.' };
}
function durable(db, prefix = '') {
  return ['tenants','clients','devices'].flatMap(table => {
    const columns = table === 'tenants' ? 'id,label,owner_id,enabled'
      : table === 'clients' ? 'id,owner_id,label,credential_hash,revoked,tenant_id'
        : 'id,owner_id,key_id,public_key,extension_origin,label,revoked,tenant_id';
    return [table, db.prepare(`SELECT ${columns} FROM ${prefix}${table} ORDER BY id`).all()];
  });
}
export function verifyMigration(db) {
  requireValue(version(db) === SCHEMA_VERSION, 'SCHEMA_VERSION_UNSUPPORTED');
  requireValue(db.prepare('PRAGMA foreign_key_check').all().length === 0 &&
    db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok', 'MIGRATION_INTEGRITY_FAILED');
  const legacy = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='legacy_clients'").get());
  if (legacy) {
    requireValue(hash(JSON.stringify(durable(db))) === hash(JSON.stringify(durable(db, 'legacy_'))), 'DURABLE_IDENTITIES_CHANGED');
    const expected = db.prepare(`SELECT c.id AS client_id,d.id AS device_id,c.tenant_id
      FROM legacy_clients c JOIN legacy_devices d ON d.tenant_id=c.tenant_id ORDER BY c.id,d.id`).all();
    const actual = db.prepare('SELECT client_id,device_id,tenant_id FROM client_devices ORDER BY client_id,device_id').all();
    // New post-migration bindings are permitted; every old association must remain.
    requireValue(expected.every(e => actual.some(a => a.client_id === e.client_id &&
      a.device_id === e.device_id && a.tenant_id === e.tenant_id)), 'LEGACY_BINDINGS_CHANGED');
  }
  const counts = Object.fromEntries(['tenants','clients','devices','client_devices'].map(table =>
    [table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]));
  return { verified: true, legacy_evidence: legacy, counts, durable_digest: hash(JSON.stringify(durable(db))) };
}
export function migrate(db) {
  const report = preview(db);
  requireValue(report.migration_required, 'ALREADY_MIGRATED');
  requireValue(!report.unusual_multiowner.length, 'MULTIOWNER_MAPPING_REQUIRED');
  requireValue(!report.orphaned_devices.length, 'ORPHANED_DEVICE_MAPPING_REQUIRED');
  db.exec('PRAGMA foreign_keys=OFF; BEGIN EXCLUSIVE');
  try {
    // Repeat preflight under the write lock; preview alone is never authorization to flatten.
    const locked = preview(db);
    requireValue(locked.can_migrate, 'MIGRATION_PREFLIGHT_CHANGED');
    for (const table of Object.keys(required)) db.exec(`ALTER TABLE ${table} RENAME TO legacy_${table}`);
    initializeSchema(db);
    db.exec(`INSERT INTO tenants SELECT * FROM legacy_tenants;
      INSERT INTO clients(id,owner_id,label,credential_hash,revoked,tenant_id,legacy_disabled)
        SELECT c.id,c.owner_id,c.label,c.credential_hash,c.revoked,c.tenant_id,
        CASE WHEN o.admitted=1 AND o.disabled=0 THEN 0 ELSE 1 END
        FROM legacy_clients c JOIN legacy_owners o ON o.id=c.owner_id;
      INSERT INTO devices(id,owner_id,key_id,public_key,extension_origin,label,revoked,tenant_id,legacy_disabled)
        SELECT d.id,d.owner_id,d.key_id,d.public_key,d.extension_origin,d.label,d.revoked,d.tenant_id,
        CASE WHEN o.admitted=1 AND o.disabled=0 THEN 0 ELSE 1 END
        FROM legacy_devices d JOIN legacy_owners o ON o.id=d.owner_id;
      INSERT INTO client_devices SELECT c.id,d.id,c.tenant_id FROM clients c JOIN devices d ON d.tenant_id=c.tenant_id;
      DELETE FROM legacy_sessions; DELETE FROM legacy_enrollments; DELETE FROM legacy_setup_requests;`);
    const result = verifyMigration(db);
    db.exec('COMMIT');
    return { schema_version: SCHEMA_VERSION, ...result };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.exec('PRAGMA foreign_keys=ON'); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  let db;
  try {
    const [command, path, confirmation] = process.argv.slice(2);
    requireValue(path && ['preview','dry-run','apply','verify'].includes(command), 'INVALID_COMMAND');
    requireValue(command !== 'apply' || confirmation === '--service-stopped', 'STOP_SERVICE_BEFORE_MIGRATION');
    db = new DatabaseSync(path, { readOnly: command !== 'apply' });
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON');
    const result = command === 'apply' ? migrate(db) : command === 'verify' ? verifyMigration(db) : preview(db);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    audit('migration_failed', { code: failureCode(error) });
    process.stderr.write('Usage: node migrate.js preview|dry-run|verify <db> | apply <db> --service-stopped\n');
    process.exitCode = 1;
  } finally { db?.close(); }
}
