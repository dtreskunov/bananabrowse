import { randomUUID } from 'node:crypto';
import { Store, token } from '../store.js';
import { createApp } from '../app.js';
import { BridgeServer } from '../server.js';
import { keyId, sign, authPayload, workspacePayload, OPERATIONS } from '../../shared/protocol.js';

export const ORIGIN = 'https://service.test';
export const EXTENSION = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const DESCRIPTION = 'Read the requested page details in this authorized workspace.';
export const flush = () => new Promise(resolve => setImmediate(resolve));
export async function keys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign','verify']);
  const public_key = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { key: pair.privateKey, public_key, key_id: await keyId(public_key) };
}
export function bind(store, client, key) {
  const request = { ...key, request_id: randomUUID(), extension_origin: EXTENSION,
    pairing_code: token().replace(/[^0-9A-HJKMNP-TV-Z]/g, '').padEnd(8,'A').slice(0,8),
    receipt: token(), label: 'Browser' };
  store.pairingStart(request); store.adopt(client.id, client.tenant_id, request.pairing_code);
  const row = store.pairing(request.request_id, key.key_id, request.receipt);
  const result = store.pairingConfirm({ ...request, proposal_id: row.proposal_id,
    tenant_id: row.tenant_id, client_id: row.client_id, nonce: row.nonce });
  return { ...result, ...request };
}
export async function fixture(options = {}) {
  const clock = { value: 1_800_000_000_000 }, now = options.now || (() => clock.value);
  const store = new Store(':memory:', { now });
  const created = store.createClient('Atlas'), client = store.client(created.id);
  const key = await keys(), device = bind(store, client, key);
  const config = { origin: ORIGIN, protectedOrigins: [ORIGIN,'https://control.test'],
    bind: '127.0.0.1', port: 0, now, ...options };
  const bridge = new BridgeServer(store, config);
  const ws = { readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); }, close() {}, terminate() {} };
  const session = { ws, origin: EXTENSION, tenant_id: client.tenant_id, connection_id: randomUUID(),
    lastSeen: now(), lastPing: now(), authenticated: false, device: null, challenge: null,
    workspaces: new Set(), usedTargets: new Set() };
  await bridge.message(session, { type: 'hello', version: 5, tenant_id: client.tenant_id, key_id: key.key_id,
    browser_info: Object.hasOwn(options, 'browserInfo') ? options.browserInfo :
      { extension_version: '5.0.7', browser_name: 'chrome', browser_version: '150.0' } });
  const challenge = ws.sent.pop();
  await bridge.message(session, { type: 'proof', tenant_id: client.tenant_id,
    signature: await sign(key.key, authPayload(challenge)) });
  const authenticated = ws.sent.pop();
  const workspace = { type: 'workspace.sync', tenant_id: client.tenant_id, client_id: client.id,
    workspace_id: randomUUID(), activation_id: randomUUID(), group_id: 1, window_id: 1,
    state: 'active', revision: 1, lease_ms: 5000, tabs: [tab(1)] };
  const sync = async (patch = {}, value = workspace) => {
    Object.assign(value, patch);
    const snapshot = { ...value, tabs: value.tabs.map(t => ({ ...t, capabilities: [...t.capabilities] })) };
    snapshot.signature = await sign(key.key, workspacePayload({ ...snapshot, origin: ORIGIN,
      epoch: bridge.epoch, connection_id: session.connection_id }));
    await bridge.message(session, snapshot);
    return snapshot;
  };
  await sync();
  return { clock, now, store, client, created, key, device, config, bridge, ws, session, workspace,
    authenticated, sync, close() { bridge.close(); store.close(); } };
}
export const tab = (tab_id, extra = {}) => ({ target_id: randomUUID(), tab_id, title: `Tab ${tab_id}`,
  url: 'https://page.test/', page_state: 'ready', capabilities: [...OPERATIONS], ...extra });
export async function appFixture(options = {}) {
  const store = new Store(':memory:'), config = { origin: ORIGIN, protectedOrigins: [ORIGIN],
    bind: '127.0.0.1', port: 0, ...options };
  const app = createApp(store, config), address = await app.listen(), base = `http://127.0.0.1:${address.port}`;
  return { store, app, base, async close() { await app.close(); store.close(); } };
}
export async function post(base, path, data, headers = {}) {
  return fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(data), redirect: 'manual' });
}
export async function pairingStart(f, key, code = 'K7MP-4QTX') {
  const challenge = await (await fetch(`${f.base}/api/pairing/challenge`, { headers: { Origin: EXTENSION } })).json();
  const data = { request_id: randomUUID(), key_id: key.key_id, public_key: key.public_key,
    extension_origin: EXTENSION, pairing_code: code, receipt: token(), nonce: challenge.nonce, label: 'Laptop' };
  const { pairingStartPayload } = await import('../../shared/protocol.js');
  data.signature = await sign(key.key, pairingStartPayload({ ...data, origin: ORIGIN }));
  return { data, response: await post(f.base, '/api/pairing/start', data, { Origin: EXTENSION }) };
}
export const capture = promise => promise.then(value => ({ value }), error => ({ error }));
export async function responseMessage(f, command, type, fields = {}) {
  await f.bridge.message(f.session, { type, tenant_id: f.client.tenant_id, request_id: command.request_id,
    target_id: command.target_id, workspace_id: command.workspace_id, activation_id: command.activation_id, ...fields });
}
