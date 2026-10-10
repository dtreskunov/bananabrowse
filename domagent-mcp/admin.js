#!/usr/bin/env node
import { Store } from './store.js';
import { audit, failureCode, requireValue } from './errors.js';

process.umask(0o077);
let store;
try {
  store = new Store(process.env.DOMAGENT_DB || './data/domagent.db');
  const [command, ...args] = process.argv.slice(2);
  if (command === 'invite') {
    const [issuer, subject, label] = args;
    requireValue(issuer && new URL(issuer).protocol === 'https:' && subject && label, 'INVALID_INVITATION');
    const id = store.invite(issuer, subject, label);
    audit('owner_invited', { owner_id: id });
  } else if (command === 'disable-owner') {
    requireValue(args.length === 1, 'OWNER_ID_REQUIRED');
    store.disableOwner(args[0]);
    audit('owner_disabled', { owner_id: args[0] });
  } else if (command === 'add-member') {
    requireValue(args.length === 3, 'INVALID_ARGUMENTS');
    store.addMember(args[0], args[1], args[2]);
    audit('member_added', { tenant_id: args[1], owner_id: args[2] });
  } else if (command === 'remove-member') {
    requireValue(args.length === 3, 'INVALID_ARGUMENTS');
    store.removeMember(args[0], args[1], args[2]);
    audit('member_removed', { tenant_id: args[1], owner_id: args[2] });
  } else throw new Error('INVALID_COMMAND');
} catch (error) {
  audit('admin_command_failed', { code: failureCode(error) });
  process.stderr.write('Usage: node admin.js invite <exact-issuer> <subject> <label> | disable-owner <id> | add-member/remove-member <tenant-owner-id> <tenant-id> <member-id>\n');
  process.exitCode = 1;
} finally {
  store?.close();
}
