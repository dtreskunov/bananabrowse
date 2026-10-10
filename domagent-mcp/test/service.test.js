import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store, token } from '../store.js';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { audit } from '../errors.js';
import {
  keyId, sign, authPayload, startPayload, statusPayload, enrollmentPayload,
  grantPayload, OPERATIONS,
} from '../../shared/protocol.js';

const EXTENSION_ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const ORIGIN = 'https://domagent.test';
const ISSUER = 'https://idp.test';
const PUBLIC_CONFIG = {
  origin: ORIGIN, issuer: ISSUER, bind: '127.0.0.1', port: 0,
  protectedOrigins: [ORIGIN, ISSUER, 'https://bananaclaw.test'],
};

async function setup(t) {
  const store = new Store(':memory:');
  const ownerId = store.invite(ISSUER, 'owner', 'Browser owner');
  store.admit(ISSUER, 'owner');
  const session = store.createSession(ownerId);
  const oidc = {
    start: async flow => `${ISSUER}/authorize?state=${flow.state}`,
    finish: async () => ({ issuer: ISSUER, subject: 'owner' }),
  };
  const app = createApp(store, { ...PUBLIC_CONFIG }, oidc);
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); store.close(); });
  const request = async (path, data, headers = {}, method = 'POST') => {
    const response = await fetch(`${base}${path}`, {
      method, redirect: 'manual',
      headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: data ? JSON.stringify(data) : undefined,
    });
    return response;
  };
  return { store, app, base, ownerId, session, request };
}
async function startEnrollment(ctx, { challengeOrigin = EXTENSION_ORIGIN } = {}) {
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const publicKey = await crypto.subtle.exportKey('jwk', key.publicKey);
  const id = await keyId(publicKey);
  const challenge = await (await ctx.request('/api/enrollment/challenge', null,
    challengeOrigin ? { Origin: challengeOrigin } : {}, 'GET')).json();
  const intent = {
    origin: ORIGIN, nonce: challenge.nonce, key_id: id,
    extension_origin: EXTENSION_ORIGIN, label: 'Test browser',
  };
  const submission = {
    ...intent, public_key: publicKey, signature: await sign(key.privateKey, startPayload(intent)),
  };
  const response = await ctx.request('/api/enrollment/start', submission, { Origin: EXTENSION_ORIGIN });
  assert.equal(response.status, 201);
  return { key, publicKey, id, submission, enrollment: await response.json() };
}
async function enroll(ctx) {
  const started = await startEnrollment(ctx);
  ctx.store.approveEnrollment(started.enrollment.enrollment_id, ctx.ownerId);
  const status = await (await ctx.request('/api/enrollment/status', {
    enrollment_id: started.enrollment.enrollment_id,
    signature: await sign(started.key.privateKey, statusPayload({
      origin: ORIGIN, enrollment_id: started.enrollment.enrollment_id,
    })),
  })).json();
  const confirmation = {
    enrollment_id: status.enrollment_id,
    signature: await sign(started.key.privateKey, enrollmentPayload({ ...status, origin: ORIGIN })),
  };
  const response = await ctx.request('/api/enrollment/confirm', confirmation);
  assert.equal(response.status, 201);
  return { ...started, device: await response.json(), confirmation };
}
async function connect(ctx, device, { pong = true } = {}) {
  const ws = new WebSocket(`${ctx.base.replace('http:', 'ws:')}/extension`, { origin: EXTENSION_ORIGIN });
  const backlog = [];
  const waiters = [];
  ws.on('message', bytes => {
    const m = JSON.parse(bytes.toString());
    if (m.type === 'ping') {
      if (pong) ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }
    const index = waiters.findIndex(w => w.type === m.type);
    if (index >= 0) waiters.splice(index, 1)[0].resolve(m);
    else backlog.push(m);
  });
  const next = type => {
    const index = backlog.findIndex(m => m.type === type);
    if (index >= 0) return Promise.resolve(backlog.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 3000);
      waiters.push({ type, resolve: value => { clearTimeout(timeout); resolve(value); } });
    });
  };
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'hello', key_id: device.id, version: 1 }));
  const challenge = await next('challenge');
  ws.send(JSON.stringify({ type: 'proof', signature: await sign(device.key.privateKey, authPayload(challenge)) }));
  const authenticated = await next('authenticated');
  return { ws, next, challenge, authenticated };
}
async function activate(ctx, device, connection, client) {
  ctx.store.link(ctx.ownerId, client.id, device.device.device_id);
  const result = ctx.app.bridge.requestAccess(client.id, device.device.device_id);
  assert.equal(result.state, 'pending');
  const request = await connection.next('approval.request');
  const grant = { ...request, origin: ORIGIN, target_id: token(), capabilities: [...OPERATIONS] };
  connection.ws.send(JSON.stringify({
    ...grant, type: 'grant.approve',
    signature: await sign(device.key.privateKey, grantPayload(grant)),
  }));
  const active = await connection.next('grant.active');
  assert.equal(active.target_id, grant.target_id);
  return grant;
}

test('startup rejects insecure service origins and invalid ports', () => {
  assert.throws(() => loadConfig({}), /SERVICE_ORIGIN_REQUIRED/);
  assert.throws(() => loadConfig({
    DOMAGENT_ORIGIN: 'http://domagent.test', DOMAGENT_OIDC_ISSUER: ISSUER,
  }), /INVALID_SERVICE_ORIGIN/);
  assert.throws(() => loadConfig({
    DOMAGENT_ORIGIN: ORIGIN, DOMAGENT_OIDC_ISSUER: ISSUER,
    DOMAGENT_OIDC_CLIENT_ID: 'test', DOMAGENT_PORT: '0',
  }), /INVALID_PORT/);
});

test('owner admission is issuer/subject scoped; disabled and expired invitations fail', () => {
  const store = new Store(':memory:');
  try {
    const ownerId = store.invite(ISSUER, 'owner', 'Owner');
    assert.throws(() => store.admit('https://other.test', 'owner'), /OWNER_NOT_INVITED/);
    const owner = store.admit(ISSUER, 'owner');
    assert.equal(owner.id, ownerId);
    const session = store.createSession(ownerId);
    assert(store.session(session.token));
    store.disableOwner(ownerId);
    assert.equal(store.session(session.token), undefined);
    assert.throws(() => store.admit(ISSUER, 'owner'), /OWNER_NOT_INVITED/);
    assert.throws(() => store.invite(ISSUER, 'owner', 'Owner'), /OWNER_ALREADY_REGISTERED/);
    const expired = store.invite(ISSUER, 'expired', 'Expired');
    store.db.prepare('UPDATE owners SET invitation_expires=0 WHERE id=?').run(expired);
    assert.throws(() => store.admit(ISSUER, 'expired'), /OWNER_NOT_INVITED/);
    assert.equal(store.invite(ISSUER, 'expired', 'Renewed invitation'), expired);
    assert.equal(store.admit(ISSUER, 'expired').id, expired);
  } finally { store.close(); }
});

test('dashboard-only approval cannot enroll; key confirmation is bound and one-time', async t => {
  const ctx = await setup(t);
  assert.equal((await ctx.request('/health', null, {}, 'GET')).status, 200);
  const start = await startEnrollment(ctx);
  assert.equal((await ctx.request('/api/enrollment/confirm', {
    enrollment_id: start.enrollment.enrollment_id, signature: token(),
  })).status, 404);
  const device = await enroll(ctx);
  assert.equal((await ctx.request('/api/enrollment/confirm', device.confirmation)).status, 404);
  assert.equal(ctx.store.deviceByKey(device.id).id, device.device.device_id);
  assert.equal(ctx.app.bridge.grants.size, 0);
});

test('cross-origin pages cannot use enrollment API; invalid proof cannot consume an enrollment', async t => {
  const ctx = await setup(t);
  assert.equal((await ctx.request('/api/enrollment/challenge', null,
    { Origin: 'https://evil.test' }, 'GET')).status, 403);
  const start = await startEnrollment(ctx);
  ctx.store.approveEnrollment(start.enrollment.enrollment_id, ctx.ownerId);
  const wrongKey = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const e = ctx.store.enrollment(start.enrollment.enrollment_id);
  const fake = {
    origin: ORIGIN, enrollment_id: e.id, key_id: e.key_id, owner_id: e.owner_id,
    nonce: e.nonce, extension_origin: e.extension_origin,
  };
  assert.equal((await ctx.request('/api/enrollment/confirm', {
    enrollment_id: e.id, signature: await sign(wrongKey.privateKey, enrollmentPayload(fake)),
  })).status, 403);
  assert(ctx.store.enrollment(e.id));
});

test('originless challenge GET supports signed Chrome POST without weakening origin or replay checks', async t => {
  const ctx = await setup(t);
  const started = await startEnrollment(ctx, { challengeOrigin: null });
  assert.equal((await ctx.request('/api/enrollment/start', started.submission,
    { Origin: EXTENSION_ORIGIN })).status, 400);
  const challenge = await (await ctx.request('/api/enrollment/challenge', null,
    { Origin: EXTENSION_ORIGIN }, 'GET')).json();
  const otherOrigin = `chrome-extension://${'b'.repeat(32)}`;
  const intent = { ...started.submission, nonce: challenge.nonce, extension_origin: otherOrigin };
  intent.signature = await sign(started.key.privateKey, startPayload(intent));
  assert.equal((await ctx.request('/api/enrollment/start', intent,
    { Origin: otherOrigin })).status, 400);
  const originless = await (await ctx.request('/api/enrollment/challenge', null, {}, 'GET')).json();
  const mismatched = { ...started.submission, nonce: originless.nonce };
  mismatched.signature = await sign(started.key.privateKey, startPayload(mismatched));
  assert.equal((await ctx.request('/api/enrollment/start', mismatched,
    { Origin: otherOrigin })).status, 403);
  assert.equal((await ctx.request('/api/enrollment/start', mismatched,
    { Origin: 'https://evil.test' })).status, 403);
});

test('dashboard requires owner cookie and same-origin CSRF; credentials do not authenticate management', async t => {
  const ctx = await setup(t);
  const client = ctx.store.createClient(ctx.ownerId, 'Agent');
  assert.equal((await ctx.request('/dashboard/link', {}, {
    Authorization: `Bearer ${client.credential}`, Origin: ORIGIN,
  })).status, 401);
  const headers = { Cookie: `__Host-domagent_session=${ctx.session.token}`, Origin: ORIGIN };
  assert.equal((await ctx.request('/dashboard/create-client', {
    label: 'Attack', csrf: ctx.session.csrf,
  }, { ...headers, Origin: 'https://evil.test' })).status, 403);
  assert.equal((await ctx.request('/dashboard/create-client', {
    label: 'Attack', csrf: ctx.session.csrf,
  }, { ...headers, Origin: 'null' })).status, 403);
  assert.equal((await ctx.request('/dashboard/create-client', {
    label: 'Attack', csrf: 'bad',
  }, headers)).status, 403);
  assert.equal((await ctx.request('/dashboard/create-client', {
    label: '<img src=x onerror=alert(1)>', csrf: ctx.session.csrf,
  }, headers)).status, 200);
  const dashboardResponse = await ctx.request('/dashboard', null, headers, 'GET');
  assert.equal(dashboardResponse.headers.get('referrer-policy'), 'same-origin');
  const dashboard = await dashboardResponse.text();
  assert(!dashboard.includes('<img src=x'));
  assert(dashboard.includes('&lt;img'));
});

test('OIDC state is browser-bound and consumed exactly once', async t => {
  const ctx = await setup(t);
  const login = await ctx.request('/login', null, {}, 'GET');
  const state = new URL(login.headers.get('location')).searchParams.get('state');
  assert.equal((await ctx.request(`/oidc/callback?state=${state}&code=private`, null, {}, 'GET')).status, 403);
  const fresh = await ctx.request('/login', null, {}, 'GET');
  const freshState = new URL(fresh.headers.get('location')).searchParams.get('state');
  const headers = { Cookie: `__Host-domagent_flow=${freshState}` };
  const callback = await ctx.request(`/oidc/callback?state=${freshState}&code=private`, null, headers, 'GET');
  assert.equal(callback.status, 303);
  assert(callback.headers.get('set-cookie').includes('Secure'));
  assert.equal((await ctx.request(`/oidc/callback?state=${freshState}&code=private`, null, headers, 'GET')).status, 403);
});

test('client eligibility requires fresh device-key approval and explicit per-client targets', async t => {
  const ctx = await setup(t);
  const d = await enroll(ctx);
  const connection = await connect(ctx, d);
  const client = ctx.store.createClient(ctx.ownerId, 'Agent A');
  const other = ctx.store.createClient(ctx.ownerId, 'Agent B');
  const grant = await activate(ctx, d, connection, client);
  assert.equal(ctx.app.bridge.targets(client.id)[0].target_id, grant.target_id);
  assert.deepEqual(ctx.app.bridge.targets(other.id), []);
  await assert.rejects(ctx.app.bridge.operate(other.id, grant.target_id, 'click', { selector: 'button' }), /NOT_AUTHORIZED/);
  await assert.rejects(ctx.app.bridge.operate(client.id, undefined, 'get_text', { selector: 'body' }), /INVALID_ARGUMENTS/);
  await assert.rejects(ctx.app.bridge.operate(client.id, grant.target_id, 'Network.getCookies', {}), /INVALID_ARGUMENTS/);
  const operation = ctx.app.bridge.operate(client.id, grant.target_id, 'get_text', { selector: 'body' });
  const command = await connection.next('command');
  assert.equal(command.client_id, client.id);
  connection.ws.send(JSON.stringify({ type: 'result', request_id: command.request_id,
    target_id: command.target_id, result: 'visible content' }));
  assert.equal(await operation, 'visible content');
  const expired = ctx.app.bridge.operate(client.id, grant.target_id, 'click', { selector: 'button' });
  const rejected = assert.rejects(expired, /COMMAND_EXPIRED/);
  const expiredCommand = await connection.next('command');
  connection.ws.send(JSON.stringify({
    type: 'result', request_id: expiredCommand.request_id, target_id: expiredCommand.target_id,
    error: { code: 'COMMAND_EXPIRED' },
  }));
  await rejected;
});

test('connection replacement invalidates grants; an old close cannot remove the new connection', async t => {
  const ctx = await setup(t);
  const d = await enroll(ctx);
  const first = await connect(ctx, d);
  const client = ctx.store.createClient(ctx.ownerId, 'Agent');
  const grant = await activate(ctx, d, first, client);
  const second = await connect(ctx, d);
  assert.notEqual(first.authenticated.connection_id, second.authenticated.connection_id);
  assert.equal(ctx.app.bridge.grants.size, 0);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(ctx.app.bridge.connections.get(d.device.device_id).connection_id, second.authenticated.connection_id);
  await assert.rejects(ctx.app.bridge.operate(client.id, grant.target_id, 'get_text', { selector: 'body' }), /NOT_AUTHORIZED/);
  assert.equal(ctx.app.bridge.targets(client.id)[0].state, 'approval_required');
});

test('selector failures remain specific; failed inspection clears active status even without a local end message', async t => {
  const ctx = await setup(t);
  const device = await enroll(ctx);
  const connection = await connect(ctx, device);
  const client = ctx.store.createClient(ctx.ownerId, 'Agent');
  const grant = await activate(ctx, device, connection, client);
  const other = ctx.store.createClient(ctx.ownerId, 'Unaffected client');
  const otherGrant = await activate(ctx, device, connection, other);
  for (const code of ['ELEMENT_NOT_FOUND', 'INVALID_SELECTOR', 'CAPABILITY_UNAVAILABLE', 'PAGE_UNAVAILABLE']) {
    const work = ctx.app.bridge.operate(client.id, grant.target_id, 'click', { selector: 'button' });
    const rejected = assert.rejects(work, error => error.code === code);
    const command = await connection.next('command');
    connection.ws.send(JSON.stringify({
      type: 'result', request_id: command.request_id, target_id: command.target_id, error: { code },
    }));
    await rejected;
    const target = ctx.app.bridge.targets(client.id)[0];
    assert.equal(target.state, code === 'PAGE_UNAVAILABLE' ? 'approval_required' : 'active');
    assert.equal(target.target_id, code === 'PAGE_UNAVAILABLE' ? null : grant.target_id);
  }
  const ended = await connection.next('grant.end');
  assert.equal(ended.reason, 'CAPABILITY_UNAVAILABLE');
  connection.ws.send(JSON.stringify({
    type: 'grant.end', target_id: grant.target_id, reason: 'CAPABILITY_UNAVAILABLE',
  }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(ctx.app.bridge.connections.size, 1);
  assert.equal(ctx.app.bridge.targets(other.id)[0].target_id, otherGrant.target_id);
  await assert.rejects(ctx.app.bridge.operate(client.id, grant.target_id, 'navigate',
    { url: 'https://ordinary.example/' }), /NOT_AUTHORIZED/);
});

test('pause discards pending work, protected navigation pauses, and revocation affects live grants', async t => {
  const ctx = await setup(t);
  const d = await enroll(ctx);
  const connection = await connect(ctx, d);
  const client = ctx.store.createClient(ctx.ownerId, 'Agent');
  let grant = await activate(ctx, d, connection, client);
  await assert.rejects(ctx.app.bridge.operate(client.id, grant.target_id, 'navigate',
    { url: `${ORIGIN}/dashboard` }), /HANDOFF_REQUIRED/);
  assert.equal(ctx.app.bridge.grants.size, 0);
  grant = await activate(ctx, d, connection, client);
  const operation = ctx.app.bridge.operate(client.id, grant.target_id, 'click', { selector: 'button' });
  const rejected = assert.rejects(operation, /OUTCOME_UNKNOWN/);
  await connection.next('command');
  ctx.store.revoke(ctx.ownerId, 'client', client.id);
  ctx.app.bridge.reconcile();
  await rejected;
  assert.equal(ctx.app.bridge.grants.size, 0);
  assert.equal(ctx.store.authenticateClient(client.credential), undefined);
});

test('HTTP MCP authenticates every request and runs stateless discovery/status end to end', async t => {
  const ctx = await setup(t);
  const client = ctx.store.createClient(ctx.ownerId, 'Agent');
  assert.equal((await ctx.request('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);
  const sdk = new Client({ name: 'test', version: '1.0' });
  t.after(() => sdk.close());
  await sdk.connect(new StreamableHTTPClientTransport(new URL(`${ctx.base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${client.credential}` } },
  }));
  const list = await sdk.listTools();
  assert(list.tools.some(tool => tool.name === 'evaluate_script'));
  assert(!list.tools.some(tool => tool.name === 'use_current_tab'));
  assert(list.tools.find(tool => tool.name === 'click').inputSchema.required.includes('target_id'));
  const status = await sdk.callTool({ name: 'list_browser_targets', arguments: {} });
  assert.equal(status.isError, undefined);
  assert.equal(status.content[0].text, '[]');
  const invalid = await sdk.callTool({ name: 'click', arguments: { selector: 'button' } });
  assert.equal(invalid.isError, true);
  ctx.store.revoke(ctx.ownerId, 'client', client.id);
  await assert.rejects(sdk.listTools());
});

test('credentials are hashed, rotation is owner-scoped, and only the browser owner can authorize links', () => {
  const store = new Store(':memory:');
  try {
    const owner = store.invite(ISSUER, 'owner', 'Owner');
    const other = store.invite(ISSUER, 'other', 'Other');
    store.admit(ISSUER, 'owner');
    store.admit(ISSUER, 'other');
    const client = store.createClient(owner, 'Client');
    assert(!JSON.stringify(store.client(client.id)).includes(client.credential));
    const rotated = store.rotateClient(owner, client.id);
    assert.equal(store.authenticateClient(client.credential), undefined);
    assert.equal(store.authenticateClient(rotated.credential).id, client.id);
    assert.throws(() => store.rotateClient(other, client.id), /NOT_AUTHORIZED/);
    store.enrollmentStart({
      id: 'fixture', key_id: 'fixture-key', public_key: {}, extension_origin: EXTENSION_ORIGIN,
      label: 'Other browser', nonce: token(), expires: Date.now() + 60_000,
    });
    store.approveEnrollment('fixture', other);
    const device = store.confirmEnrollment('fixture');
    assert.throws(() => store.link(owner, client.id, device.id), /NOT_AUTHORIZED/);
    store.link(other, client.id, device.id);
    assert.equal(store.devicesForClient(client.id)[0].id, device.id);
    assert.equal(store.linksForOwner(owner).length, 0);
    assert.equal(store.linksForOwner(other)[0].client_id, client.id);
    assert.throws(() => store.unlink(owner, client.id, device.id), /NOT_AUTHORIZED/);
    store.unlink(other, client.id, device.id);
    assert.equal(store.devicesForClient(client.id).length, 0);
  } finally { store.close(); }
});

test('one device can have distinct active tabs for two clients without target confusion', async t => {
  const ctx = await setup(t);
  const device = await enroll(ctx);
  const connection = await connect(ctx, device);
  const first = ctx.store.createClient(ctx.ownerId, 'First group');
  const second = ctx.store.createClient(ctx.ownerId, 'Second group');
  const a = await activate(ctx, device, connection, first);
  const b = await activate(ctx, device, connection, second);
  assert.equal(ctx.app.bridge.grants.size, 2);
  assert.notEqual(a.target_id, b.target_id);
  await assert.rejects(ctx.app.bridge.operate(first.id, b.target_id, 'get_screenshot', {}), /NOT_AUTHORIZED/);
  ctx.app.bridge.endGrant(a.target_id, 'OWNER_PAUSED');
  connection.ws.send(JSON.stringify({
    type: 'result', request_id: token(), target_id: a.target_id, result: 'late private content',
  }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert(ctx.app.bridge.connections.has(device.device.device_id));
  assert.equal(ctx.app.bridge.targets(first.id)[0].state, 'approval_required');
  assert.equal(ctx.app.bridge.targets(second.id)[0].target_id, b.target_id);
});

test('denied clients cannot immediately re-prompt, while an owner can initiate a fresh request', async t => {
  const ctx = await setup(t);
  const device = await enroll(ctx);
  const connection = await connect(ctx, device);
  const client = ctx.store.createClient(ctx.ownerId, 'Agent');
  ctx.store.link(ctx.ownerId, client.id, device.device.device_id);
  ctx.app.bridge.requestAccess(client.id, device.device.device_id);
  const request = await connection.next('approval.request');
  connection.ws.send(JSON.stringify({ type: 'approval.deny', request_id: request.request_id }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.throws(() => ctx.app.bridge.requestAccess(client.id, device.device.device_id), /RATE_LIMITED/);
  const fresh = ctx.app.bridge.requestAccess(client.id, device.device.device_id, true);
  assert.equal(fresh.state, 'pending');
  assert.notEqual(fresh.request_id, request.request_id);
});

test('a live silent partition fails closed at the liveness boundary', async t => {
  const ctx = await setup(t);
  const device = await enroll(ctx);
  const connection = await connect(ctx, device);
  const client = ctx.store.createClient(ctx.ownerId, 'Agent');
  await activate(ctx, device, connection, client);
  ctx.app.bridge.connections.get(device.device.device_id).lastSeen = Date.now() - 15_001;
  ctx.app.bridge.sweep();
  assert.equal(ctx.app.bridge.connections.size, 0);
  assert.equal(ctx.app.bridge.grants.size, 0);
  assert.equal(ctx.app.bridge.targets(client.id)[0].state, 'offline');
});

test('silent devices lose authority at exactly the configured 15-second deadline', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: Date.now() });
  const ctx = await setup(t);
  const device = await enroll(ctx);
  const connection = await connect(ctx, device, { pong: false });
  const client = ctx.store.createClient(ctx.ownerId, 'Agent');
  await activate(ctx, device, connection, client);
  t.mock.timers.tick(14_999);
  assert.equal(ctx.app.bridge.grants.size, 1);
  t.mock.timers.tick(1);
  assert.equal(ctx.app.bridge.grants.size, 0);
  assert.equal(ctx.app.bridge.connections.size, 0);
  t.mock.timers.reset();
});

test('command input and queue limits are exact; timeout ends uncertain work without executing the queue', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: Date.now() });
  const ctx = await setup(t);
  const device = await enroll(ctx);
  const connection = await connect(ctx, device, { pong: false });
  const client = ctx.store.createClient(ctx.ownerId, 'Agent');
  const approved = await activate(ctx, device, connection, client);
  const bridge = ctx.app.bridge;
  await assert.rejects(bridge.operate(client.id, approved.target_id, 'evaluate_script',
    { script: 'x'.repeat(65_537) }), /INVALID_ARGUMENTS/);
  const first = bridge.operate(client.id, approved.target_id, 'evaluate_script',
    { script: 'x'.repeat(65_536) });
  const work = [first, ...Array.from({ length: 31 }, () =>
    bridge.operate(client.id, approved.target_id, 'click', { selector: 'button' }))];
  const settled = Promise.allSettled(work);
  const command = await connection.next('command');
  assert.equal(command.args.script.length, 65_536);
  assert.equal(command.expires_at, Date.now() + 25_000);
  assert.equal(bridge.grants.get(approved.target_id).queued, 32);
  assert.equal(bridge.calls.size, 1);
  await assert.rejects(bridge.operate(client.id, approved.target_id, 'click',
    { selector: 'button' }), /QUEUE_FULL/);

  const session = bridge.connections.get(device.device.device_id);
  t.mock.timers.tick(10_000);
  bridge.refreshLiveness(session);
  t.mock.timers.tick(10_000);
  bridge.refreshLiveness(session);
  t.mock.timers.tick(4_999);
  assert.equal(bridge.grants.size, 1);
  assert.equal(bridge.calls.size, 1);
  t.mock.timers.tick(1);
  const outcomes = await settled;
  assert.equal(outcomes[0].status, 'rejected');
  assert.match(outcomes[0].reason.message, /OUTCOME_UNKNOWN/);
  for (const outcome of outcomes.slice(1)) {
    assert.equal(outcome.status, 'rejected');
    assert.match(outcome.reason.message, /COMMAND_EXPIRED/);
  }
  assert.equal(bridge.grants.size, 0);
  assert.equal(bridge.calls.size, 0);
  t.mock.timers.reset();
});

test('audit retains only allowlisted metadata and never operation payloads', () => {
  const original = process.stdout.write;
  let output = '';
  try {
    process.stdout.write = chunk => { output += chunk; return true; };
    audit('operation_finished', {
      code: 'OK', operation: 'evaluate_script', client_id: 'public-id',
      url: 'https://private.test/?credential=private-token',
      script: 'private-script', text: 'private-text', result: 'private-content',
      authorization: 'private-token', label: 'private-label',
    });
  } finally { process.stdout.write = original; }
  const event = JSON.parse(output);
  assert.deepEqual(event, { event: 'operation_finished', code: 'OK', operation: 'evaluate_script', client_id: 'public-id' });
  assert(!output.includes('private-'));
});
