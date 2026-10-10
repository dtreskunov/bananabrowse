#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { initializeSchema, newTenantId } from './store.js';
import { tenantId } from '../shared/protocol.js';
import { requireValue, audit, failureCode } from './errors.js';

export function preview(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version === 2) return { schema_version: 2, migration_required: false, clients: [] };
  const columns = db.prepare('PRAGMA table_info(clients)').all();
  requireValue(columns.length && !columns.some(c => c.name === 'tenant_id'), 'NOT_A_LEGACY_DATABASE');
  return {
    schema_version: version, migration_required: true,
    clients: db.prepare('SELECT id AS client_id,owner_id,label,revoked FROM clients').all(),
    browser_owners: db.prepare(`SELECT DISTINCT c.id AS client_id,d.owner_id
      FROM links l JOIN clients c ON c.id=l.client_id JOIN devices d ON d.id=l.device_id`).all(),
    note: 'Assign every legacy client to a separate tenant with an explicit owner and optional member account IDs. All browsers require re-pairing.',
  };
}

export function migrate(db, assignments) {
  const report = preview(db);
  requireValue(report.migration_required, 'ALREADY_MIGRATED');
  requireValue(Array.isArray(assignments) && assignments.length === report.clients.length &&
    new Set(assignments.map(a => a.client_id)).size === assignments.length, 'INCOMPLETE_ASSIGNMENTS');
  const assigned = assignments.map(a => {
    const client = report.clients.find(c => c.client_id === a.client_id);
    requireValue(client && typeof a.owner_id === 'string' &&
      typeof a.label === 'string' && a.label.trim() && a.label.length <= 80, 'INVALID_ASSIGNMENT');
    const members = a.members === undefined ? [] : a.members;
    requireValue(Array.isArray(members) && members.every(id => typeof id === 'string'), 'INVALID_MEMBERS');
    for (const id of [a.owner_id, ...members]) {
      requireValue(db.prepare('SELECT id FROM owners WHERE id=?').get(id), 'OWNER_UNAVAILABLE');
    }
    const id = a.tenant_id === undefined ? newTenantId() : tenantId(a.tenant_id);
    return { ...a, tenant_id: id, members: [...new Set([a.owner_id, ...members])] };
  });
  requireValue(new Set(assigned.map(a => a.tenant_id)).size === assigned.length, 'DUPLICATE_TENANT');
  db.exec('PRAGMA foreign_keys=OFF; BEGIN EXCLUSIVE;');
  try {
    db.exec(`ALTER TABLE clients RENAME TO legacy_clients;
      ALTER TABLE devices RENAME TO legacy_devices;
      DROP TABLE links; DROP TABLE enrollments; DELETE FROM sessions;`);
    initializeSchema(db);
    for (const a of assigned) {
      db.prepare('INSERT INTO tenants(id,label,owner_id) VALUES(?,?,?)')
        .run(a.tenant_id, a.label.trim(), a.owner_id);
      for (const member of a.members) db.prepare('INSERT INTO tenant_members VALUES(?,?)').run(a.tenant_id, member);
      db.prepare(`INSERT INTO clients(id,owner_id,label,credential_hash,revoked,tenant_id)
        SELECT id,?,label,credential_hash,revoked,? FROM legacy_clients WHERE id=?`)
        .run(a.owner_id, a.tenant_id, a.client_id);
    }
    requireValue(db.prepare('PRAGMA foreign_key_check').all().length === 0, 'MIGRATION_INTEGRITY_FAILED');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys=ON;');
  }
  return assigned.map(a => ({ client_id: a.client_id, tenant_id: a.tenant_id, owner_id: a.owner_id }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  let db;
  try {
    const [command, path, assignmentsFile, confirmation] = process.argv.slice(2);
    requireValue(path && ['preview', 'apply'].includes(command), 'INVALID_COMMAND');
    requireValue(command !== 'apply' || confirmation === '--service-stopped', 'STOP_SERVICE_BEFORE_MIGRATION');
    db = new DatabaseSync(path, { readOnly: command === 'preview' });
    db.exec('PRAGMA busy_timeout=5000;');
    const result = command === 'preview' ? preview(db) : migrate(db, JSON.parse(readFileSync(assignmentsFile, 'utf8')));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    audit('migration_failed', { code: failureCode(error) });
    process.stderr.write('Usage: node migrate.js preview <db> | apply <db> <assignments.json> --service-stopped\n');
    process.exitCode = 1;
  } finally { db?.close(); }
}
