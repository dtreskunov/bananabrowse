#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Store } from './store.js';
import { preview, migrate, verifyMigration } from './migrate.js';
import { loadConfig } from './config.js';
import { audit, failureCode, requireValue } from './errors.js';

export const USAGE = 'Usage: DOMAGENT_DB=<db> node admin.js client create|provision <label> | client list | client rename <id> <label> | client rotate|revoke <id> | device list | device rename <id> <label> | device revoke <id> | workspace status | migration dry-run|migrate|verify [--service-stopped]\n';
export function adminCommand(store, resource, verb, args = []) {
  if (resource === 'client' && ['create','provision'].includes(verb)) {
    requireValue(args.length === 1, 'INVALID_ARGUMENTS');
    return store.createClient(args[0]);
  }
  if (resource === 'client' && verb === 'rotate') {
    requireValue(args.length === 1, 'INVALID_ARGUMENTS');
    return store.rotateClient(args[0]);
  }
  if (['client','device'].includes(resource) && verb === 'list') {
    requireValue(!args.length, 'INVALID_ARGUMENTS');
    return resource === 'client' ? store.listClients() : store.listDevices();
  }
  if (['client','device'].includes(resource) && verb === 'rename') {
    requireValue(args.length === 2, 'INVALID_ARGUMENTS');
    store.rename(resource, ...args); return { id: args[0], renamed: true };
  }
  if (['client','device'].includes(resource) && verb === 'revoke') {
    requireValue(args.length === 1, 'INVALID_ARGUMENTS');
    store.revoke(resource, args[0]); return { id: args[0], revoked: true };
  }
  requireValue(false, 'INVALID_COMMAND');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  let store, db;
  try {
    const [resource, verb, ...args] = process.argv.slice(2), path = process.env.DOMAGENT_DB || './data/domagent.db';
    let result;
    if (resource === 'migration') {
      requireValue(['dry-run','migrate','verify'].includes(verb), 'INVALID_COMMAND');
      requireValue(verb !== 'migrate' || args.length === 1 && args[0] === '--service-stopped', 'STOP_SERVICE_BEFORE_MIGRATION');
      requireValue(verb === 'migrate' || !args.length, 'INVALID_ARGUMENTS');
      db = new DatabaseSync(path, { readOnly: verb !== 'migrate' });
      db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
      result = verb === 'migrate' ? migrate(db) : verb === 'verify' ? verifyMigration(db) : preview(db);
    } else if (resource === 'workspace' && verb === 'status') {
      const config = loadConfig();
      const secret = config.operatorSecret();
      requireValue(!args.length && secret, 'LIVE_STATUS_REQUIRES_OPERATOR_SECRET');
      const response = await fetch(`${config.origin}/api/operator/workspaces`, {
        headers: { Authorization: `Bearer ${secret}` }, redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      requireValue(response.ok, 'LIVE_STATUS_UNAVAILABLE'); result = await response.json();
    } else { store = new Store(path); result = adminCommand(store, resource, verb, args); }
    // Only explicit provisioning/rotation prints a newly created credential once.
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) { audit('admin_command_failed', { code: failureCode(error) }); process.stderr.write(USAGE); process.exitCode = 1; }
  finally { store?.close(); db?.close(); }
}
