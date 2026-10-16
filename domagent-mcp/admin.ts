#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { Store, hash } from './store.js';
import { AGENT_ID_PATTERN, validName } from '../shared/protocol.js';

const [command, ...args] = process.argv.slice(2);
const usage = `Usage:
  admin.js agent-key <agent-id> "<Name>" [homepage]   Generate an API key and print its .env line
  admin.js browsers                                    List registered browsers
  admin.js browser-revoke <browser-id>                 Revoke a browser, its pairings and sessions
  admin.js pairings                                    List agent/browser pairings
  admin.js pairing-revoke <agent-id> <browser-id>      Remove one pairing and its sessions
  admin.js sessions                                    List sessions

Database: DOMAGENT_DB (default ./data/domagent.db). The running service picks up
revocations within a few seconds. Agent configuration changes need a restart.`;

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

if (command === 'agent-key') {
  const [id, name, homepage = ''] = args;
  if (!id || !AGENT_ID_PATTERN.test(id)) fail('Agent ID must be 1-32 lowercase letters, digits or hyphens.');
  if (!validName(name || '')) fail('Provide a display name of at most 80 characters.');
  if (homepage && !URL.canParse(homepage)) fail('Homepage must be a URL.');
  const key = `da_${randomBytes(32).toString('base64url')}`;
  const variable = `DOMAGENT_AGENT_${id.toUpperCase().replaceAll('-', '_')}`;
  console.log(`API key (shown once; store it in the agent's secret manager):\n${key}\n`);
  console.log(`Add to the service environment and restart:\n${variable}="${name}|${homepage}|sha256:${hash(key)}"`);
  console.log(`\nMCP endpoint: <DOMAGENT_ORIGIN>/mcp/${id}  (Authorization: Bearer <key>)`);
  process.exit(0);
}
if (!command || command === 'help' || command === '--help') {
  console.log(usage);
  process.exit(command ? 0 : 2);
}

const store = new Store(process.env.DOMAGENT_DB || './data/domagent.db');
const time = (value: number) => new Date(value).toISOString();
try {
  if (command === 'browsers') {
    for (const row of store.listBrowsers()) {
      console.log(`${row.id}\t${row.name}\tpairings=${row.pairings}\tlast_seen=${time(row.last_seen)}`);
    }
  } else if (command === 'browser-revoke') {
    if (!store.deleteBrowser(args[0])) fail('No such browser.');
    console.log(`Revoked ${args[0]}.`);
  } else if (command === 'pairings') {
    for (const row of store.listPairings())
      console.log(`${row.agent_id}\t${row.browser_id}\tsince=${time(row.created_at)}`);
  } else if (command === 'pairing-revoke') {
    if (!store.unpair(args[0], args[1])) fail('No such pairing.');
    console.log(`Removed pairing ${args[0]} ↔ ${args[1]}.`);
  } else if (command === 'sessions') {
    for (const row of store.listSessions()) {
      console.log(`${row.id}\t${row.agent_id}\t${row.browser_id}\t${row.title}\texpires=${time(row.expires_at)}`);
    }
  } else fail(usage);
} finally {
  store.close();
}
