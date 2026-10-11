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
  VERSION, keyId, sign, authPayload, startPayload, statusPayload,
  enrollmentPayload, grantPayload, OPERATIONS, tenantId, parseConnectionUrl,
} from '../../shared/protocol.js';

const EXTENSION_ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const ORIGIN = 'https://domagent.test';
const ISSUER = 'https://idp.test';
const api = (ctx, action) => `/api/tenants/${ctx.tenant.id}/enrollment/${action}`;
const ownerHeaders = ctx => ({
  Cookie: `__Host-domagent_session=${ctx.session.token}`, Origin: ORIGIN,
});

async function setup(t) {
  const store = new Store(':memory:');
  const ownerId = store.invite(ISSUER, 'owner', 'Browser owner');
  store.admit(ISSUER, 'owner');
  const session = store.createSession(ownerId);
  const tenant = store.createTenant(ownerId, 'Atlas');
  const client = store.createClient(ownerId, 'Atlas', tenant.id);
  const app = createApp(store, {
    origin: ORIGIN, issuer: ISSUER, bind: '127.0.0.1', port: 0,
    protectedOrigins: [ORIGIN, ISSUER, 'https://control.test'],
  }, {
    start: async flow => `${ISSUER}/authorize?state=${flow.state}`,
    finish: async () => ({ issuer: ISSUER, subject: 'owner' }),
  });
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); store.close(); });
  const request = (path, data, headers = {}, method = 'POST') => fetch(`${base}${path}`, {
    method, redirect: 'manual',
    headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: data ? JSON.stringify(data) : undefined,
  });
  return { store, app, base, ownerId, session, tenant, client, request };
}
function another(ctx) {
  const ownerId = ctx.store.invite(ISSUER, token(), 'Other owner');
  ctx.store.admit(ISSUER, ctx.store.db.prepare('SELECT subject FROM owners WHERE id=?').get(ownerId).subject);
  const tenant = ctx.store.createTenant(ownerId, 'Other assistant');
  const client = ctx.store.createClient(ownerId, 'Other assistant', tenant.id);
  return { ...ctx, ownerId, session: ctx.store.createSession(ownerId), tenant, client };
}
async function startEnrollment(ctx, { challengeOrigin = EXTENSION_ORIGIN } = {}) {
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const publicKey = await crypto.subtle.exportKey('jwk', key.publicKey);
  const id = await keyId(publicKey);
  const challenge = await (await ctx.request(api(ctx, 'challenge'), null,
    challengeOrigin ? { Origin: challengeOrigin } : {}, 'GET')).json();
  const intent = { origin: ORIGIN, tenant_id: ctx.tenant.id, nonce: challenge.nonce,
    key_id: id, extension_origin: EXTENSION_ORIGIN, label: 'Test browser' };
  const submission = { ...intent, public_key: publicKey, signature: await sign(key.privateKey, startPayload(intent)) };
  const response = await ctx.request(api(ctx, 'start'), submission, { Origin: EXTENSION_ORIGIN });
  assert.equal(response.status, 201);
  return { key, publicKey, id, submission, enrollment: await response.json() };
}
async function enroll(ctx) {
  const started = await startEnrollment(ctx);
  ctx.store.approveEnrollment(started.enrollment.enrollment_id, ctx.ownerId, ctx.tenant.id);
  const signedStatus = { origin: ORIGIN, tenant_id: ctx.tenant.id, enrollment_id: started.enrollment.enrollment_id };
  const status = await (await ctx.request(api(ctx, 'status'), {
    ...signedStatus, signature: await sign(started.key.privateKey, statusPayload(signedStatus)),
  })).json();
  const confirmation = { tenant_id: ctx.tenant.id, enrollment_id: status.enrollment_id,
    signature: await sign(started.key.privateKey, enrollmentPayload({ ...status, origin: ORIGIN })) };
  const response = await ctx.request(api(ctx, 'confirm'), confirmation);
  assert.equal(response.status, 201);
  return { ...started, device: await response.json(), confirmation };
}
async function connect(ctx, device, { pong = true } = {}) {
  const ws = new WebSocket(`${ctx.base.replace('http:', 'ws:')}/extension/${ctx.tenant.id}`,
    { origin: EXTENSION_ORIGIN });
  const send = ws.send.bind(ws);
  ws.send = raw => send(JSON.stringify({ tenant_id: ctx.tenant.id, ...JSON.parse(raw) }));
  const backlog = [];
  const waiters = [];
  ws.on('message', bytes => {
    const m = JSON.parse(bytes.toString());
    assert.equal(m.tenant_id, ctx.tenant.id);
    if (m.type === 'ping') { if (pong) ws.send(JSON.stringify({ type: 'pong' })); return; }
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
  ws.send(JSON.stringify({ type: 'hello', key_id: device.id, version: VERSION }));
  const challenge = await next('challenge');
  ws.send(JSON.stringify({ type: 'proof', signature: await sign(device.key.privateKey, authPayload(challenge)) }));
  return { ws, next, challenge, authenticated: await next('authenticated') };
}
async function activate(ctx, device, connection, client = ctx.client) {
  assert.equal(ctx.app.bridge.requestAccess(client.id, device.device.device_id).state, 'pending');
  const request = await connection.next('approval.request');
  const grant = { ...request, origin: ORIGIN, target_id: token(), capabilities: [...OPERATIONS] };
  connection.ws.send(JSON.stringify({ ...grant, type: 'grant.approve',
    signature: await sign(device.key.privateKey, grantPayload(grant)) }));
  assert.equal((await connection.next('grant.active')).target_id, grant.target_id);
  return grant;
}

test('config and connection link validation reject insecure and ambiguous inputs', () => {
  assert.throws(() => loadConfig({}), /SERVICE_ORIGIN_REQUIRED/);
  assert.throws(() => loadConfig({ DOMAGENT_ORIGIN: 'http://domagent.test', DOMAGENT_OIDC_ISSUER: ISSUER }),
    /INVALID_SERVICE_ORIGIN/);
  assert.throws(() => loadConfig({ DOMAGENT_ORIGIN: ORIGIN, DOMAGENT_OIDC_ISSUER: ISSUER,
    DOMAGENT_OIDC_CLIENT_ID: 'test', DOMAGENT_PORT: '0' }), /INVALID_PORT/);
  const tenant = `t_${'a'.repeat(22)}`;
  assert.equal(parseConnectionUrl(`${ORIGIN}/join/${tenant}`).tenant_id, tenant);
  for (const input of [`http://domagent.test/join/${tenant}`, `${ORIGIN}/join/${tenant}?token=bad`,
    `${ORIGIN}/connect/request#token=secret`, `${ORIGIN}/join/${tenant}/extra`]) {
    assert.throws(() => parseConnectionUrl(input));
  }
  assert.throws(() => tenantId('FJGHB'), /INVALID_TENANT/);
});

test('authenticated identities register without invitations; issuer/subject remain scoped and disabled accounts fail', () => {
  const store = new Store(':memory:');
  try {
    const id = store.invite(ISSUER, 'owner', 'Owner');
    const distinct = store.admit('https://other.test', 'owner', 'Different account');
    assert.notEqual(distinct.id, id);
    store.admit(ISSUER, 'owner');
    const session = store.createSession(id);
    assert(store.session(session.token));
    store.disableOwner(id);
    assert.equal(store.session(session.token), undefined);
    assert.throws(() => store.admit(ISSUER, 'owner'), /OWNER_DISABLED/);
    assert.throws(() => store.invite(ISSUER, 'owner', 'Owner'), /OWNER_ALREADY_REGISTERED/);
    const expired = store.invite(ISSUER, 'expired', 'Expired');
    store.db.prepare('UPDATE owners SET invitation_expires=0 WHERE id=?').run(expired);
    assert.equal(store.admit(ISSUER, 'expired').id, expired);
    const newOwner = store.admit(ISSUER, 'new-user', 'New user');
    assert.equal(newOwner.admitted, 1);
    assert.deepEqual(store.tenantsForOwner(newOwner.id), []);
    assert.equal(store.member(newOwner.id, store.createTenant(distinct.id, 'Separate tenant').id), false);
  } finally { store.close(); }
});

test('legacy unscoped endpoints explicitly reject use; public metadata has no tenant enumeration', async t => {
  const ctx = await setup(t);
  for (const path of ['/mcp', '/extension', '/api/enrollment/challenge']) {
    assert.equal((await ctx.request(path, null, {}, 'GET')).status, 410);
  }
  const metadata = await (await ctx.request('/.well-known/domagent', null, {}, 'GET')).json();
  assert.deepEqual(metadata, { service: 'domagent', protocol_version: 2, setup_requests: '/api/setup-requests' });
});

test('server approval still needs tenant-bound device-key proof and confirmation is one-time', async t => {
  const ctx = await setup(t);
  const started = await startEnrollment(ctx);
  assert.equal((await ctx.request(api(ctx, 'confirm'), { tenant_id: ctx.tenant.id,
    enrollment_id: started.enrollment.enrollment_id, signature: token() })).status, 404);
  const device = await enroll(ctx);
  assert.equal((await ctx.request(api(ctx, 'confirm'), device.confirmation)).status, 404);
  assert.equal(ctx.store.deviceByKey(device.id, ctx.tenant.id).id, device.device.device_id);
  assert.equal(ctx.app.bridge.grants.size, 0);
});

test('enrollment rejects cross-origin pages and proofs bound to another tenant', async t => {
  const ctx = await setup(t);
  const other = another(ctx);
  assert.equal((await ctx.request(api(ctx, 'challenge'), null, { Origin: 'https://evil.test' }, 'GET')).status, 403);
  const started = await startEnrollment(ctx);
  ctx.store.approveEnrollment(started.enrollment.enrollment_id, ctx.ownerId, ctx.tenant.id);
  const e = ctx.store.enrollment(started.enrollment.enrollment_id, ctx.tenant.id);
  const fake = { ...e, origin: ORIGIN, enrollment_id: e.id, tenant_id: other.tenant.id };
  assert.equal((await ctx.request(api(ctx, 'confirm'), { tenant_id: ctx.tenant.id, enrollment_id: e.id,
    signature: await sign(started.key.privateKey, enrollmentPayload(fake)) })).status, 403);
  assert(ctx.store.enrollment(e.id, ctx.tenant.id));
  assert.throws(() => ctx.store.approveEnrollment(e.id, other.ownerId, ctx.tenant.id), /ENROLLMENT_UNAVAILABLE/);
});

test('Chrome originless challenge supports signed POST without weakening origin or replay checks', async t => {
  const ctx = await setup(t);
  const started = await startEnrollment(ctx, { challengeOrigin: null });
  assert.equal((await ctx.request(api(ctx, 'start'), started.submission, { Origin: EXTENSION_ORIGIN })).status, 400);
  const challenge = await (await ctx.request(api(ctx, 'challenge'), null,
    { Origin: EXTENSION_ORIGIN }, 'GET')).json();
  const otherOrigin = `chrome-extension://${'b'.repeat(32)}`;
  const intent = { ...started.submission, nonce: challenge.nonce, extension_origin: otherOrigin };
  intent.signature = await sign(started.key.privateKey, startPayload(intent));
  assert.equal((await ctx.request(api(ctx, 'start'), intent, { Origin: otherOrigin })).status, 400);
});

test('tenant dashboard checks membership, owner privileges and same-origin CSRF', async t => {
  const ctx = await setup(t);
  const other = another(ctx);
  const path = `/dashboard/tenants/${ctx.tenant.id}`;
  const denied = await ctx.request(path, null, ownerHeaders(other), 'GET');
  assert.equal(denied.status, 403);
  assert((await denied.text()).includes("don&#39;t have access"));
  assert.equal((await ctx.request(`${path}/rotate`, { client_id: ctx.client.id, csrf: ctx.session.csrf },
    { ...ownerHeaders(ctx), Origin: 'null' })).status, 403);
  assert.equal((await ctx.request(`${path}/rotate`, { client_id: ctx.client.id, csrf: 'bad' },
    ownerHeaders(ctx))).status, 403);
  const response = await ctx.request(path, null, ownerHeaders(ctx), 'GET');
  assert.equal(response.headers.get('referrer-policy'), 'same-origin');
  assert.equal(response.status, 200);
  assert(!((await (await ctx.request('/dashboard', null, ownerHeaders(other), 'GET')).text()).includes(ctx.tenant.id)));
});

test('OIDC state is browser-bound, expires and is consumed once', async t => {
  const ctx = await setup(t);
  const login = await ctx.request('/login', null, {}, 'GET');
  const state = new URL(login.headers.get('location')).searchParams.get('state');
  assert.equal((await ctx.request(`/oidc/callback?state=${state}&code=private`, null, {}, 'GET')).status, 403);
  const fresh = await ctx.request('/login', null, {}, 'GET');
  const current = new URL(fresh.headers.get('location')).searchParams.get('state');
  const headers = { Cookie: `__Host-domagent_flow=${current}` };
  const callback = await ctx.request(`/oidc/callback?state=${current}&code=private`, null, headers, 'GET');
  assert.equal(callback.status, 303);
  assert(callback.headers.get('set-cookie').includes('Secure'));
  assert.equal((await ctx.request(`/oidc/callback?state=${current}&code=private`, null, headers, 'GET')).status, 403);
});

test('tenant pairing permits requests, not control; targets stay client/tenant bound', async t => {
  const ctx = await setup(t);
  const other = another(ctx);
  const d = await enroll(ctx);
  const connection = await connect(ctx, d);
  assert.equal(ctx.app.bridge.targets(ctx.client.id)[0].state, 'approval_required');
  const grant = await activate(ctx, d, connection);
  assert.deepEqual(ctx.app.bridge.targets(other.client.id), []);
  await assert.rejects(ctx.app.bridge.operate(other.client.id, grant.target_id, 'click', { selector: 'button' }), /NOT_AUTHORIZED/);
  await assert.rejects(ctx.app.bridge.operate(ctx.client.id, undefined, 'get_text', {}), /INVALID_ARGUMENTS/);
  await assert.rejects(ctx.app.bridge.operate(ctx.client.id, grant.target_id, 'Network.getCookies', {}), /INVALID_ARGUMENTS/);
  const work = ctx.app.bridge.operate(ctx.client.id, grant.target_id, 'get_text', { selector: 'body' });
  const command = await connection.next('command');
  assert.equal(command.tenant_id, ctx.tenant.id);
  connection.ws.send(JSON.stringify({ type: 'result', request_id: command.request_id,
    target_id: command.target_id, result: 'visible content' }));
  assert.equal(await work, 'visible content');
});

test('connection replacement never inherits grants and an old close cannot remove the new one', async t => {
  const ctx = await setup(t);
  const d = await enroll(ctx);
  const first = await connect(ctx, d);
  await activate(ctx, d, first);
  const second = await connect(ctx, d);
  assert.notEqual(first.authenticated.connection_id, second.authenticated.connection_id);
  assert.equal(ctx.app.bridge.grants.size, 0);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(ctx.app.bridge.connections.get(d.device.device_id).connection_id, second.authenticated.connection_id);
});

test('selector errors remain specific and failed inspection does not disrupt another tenant', async t => {
  const ctx = await setup(t);
  const other = another(ctx);
  const d = await enroll(ctx);
  const connection = await connect(ctx, d);
  const grant = await activate(ctx, d, connection);
  const otherDevice = await enroll(other);
  const otherConnection = await connect(other, otherDevice);
  const otherGrant = await activate(other, otherDevice, otherConnection);
  for (const code of ['ELEMENT_NOT_FOUND', 'INVALID_SELECTOR', 'CAPABILITY_UNAVAILABLE', 'COMMAND_EXPIRED', 'PAGE_UNAVAILABLE']) {
    const work = ctx.app.bridge.operate(ctx.client.id, grant.target_id, 'click', { selector: 'button' });
    const rejected = assert.rejects(work, error => error.code === code);
    const command = await connection.next('command');
    connection.ws.send(JSON.stringify({ type: 'result', request_id: command.request_id,
      target_id: command.target_id, error: { code } }));
    await rejected;
    assert.equal(ctx.app.bridge.targets(ctx.client.id)[0].state, code === 'PAGE_UNAVAILABLE' ? 'approval_required' : 'active');
  }
  assert.equal((await connection.next('grant.end')).reason, 'CAPABILITY_UNAVAILABLE');
  connection.ws.send(JSON.stringify({ type: 'grant.end', target_id: grant.target_id, reason: 'CAPABILITY_UNAVAILABLE' }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(ctx.app.bridge.connections.size, 2);
  assert.equal(ctx.app.bridge.targets(other.client.id)[0].target_id, otherGrant.target_id);
});

test('protected navigation, pending mutation and live credential revocation fail closed', async t => {
  const ctx = await setup(t);
  const d = await enroll(ctx);
  const connection = await connect(ctx, d);
  let grant = await activate(ctx, d, connection);
  await assert.rejects(ctx.app.bridge.operate(ctx.client.id, grant.target_id, 'navigate', { url: `${ORIGIN}/dashboard` }), /HANDOFF_REQUIRED/);
  grant = await activate(ctx, d, connection);
  const work = ctx.app.bridge.operate(ctx.client.id, grant.target_id, 'click', { selector: 'button' });
  const rejected = assert.rejects(work, /OUTCOME_UNKNOWN/);
  await connection.next('command');
  ctx.store.revoke(ctx.ownerId, 'client', ctx.client.id, ctx.tenant.id);
  ctx.app.bridge.reconcile();
  await rejected;
  assert.equal(ctx.app.bridge.grants.size, 0);
  assert.equal(ctx.store.authenticateClient(ctx.client.credential, ctx.tenant.id), undefined);
});

test('real HTTP MCP authenticates every request and rejects credentials on another tenant endpoint', async t => {
  const ctx = await setup(t);
  const other = another(ctx);
  const data = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  assert.equal((await ctx.request(`/mcp/${ctx.tenant.id}`, data)).status, 401);
  assert.equal((await ctx.request(`/mcp/${other.tenant.id}`, data,
    { Authorization: `Bearer ${ctx.client.credential}` })).status, 401);
  const sdk = new Client({ name: 'test', version: '1.0' });
  t.after(() => sdk.close());
  await sdk.connect(new StreamableHTTPClientTransport(new URL(`${ctx.base}/mcp/${ctx.tenant.id}`), {
    requestInit: { headers: { Authorization: `Bearer ${ctx.client.credential}` } },
  }));
  const list = await sdk.listTools();
  assert(list.tools.some(tool => tool.name === 'evaluate_script'));
  assert(!list.tools.some(tool => tool.name === 'use_current_tab'));
  assert(list.tools.find(tool => tool.name === 'click').inputSchema.required.includes('target_id'));
  assert.equal((await sdk.callTool({ name: 'list_browser_targets', arguments: {} })).content[0].text, '[]');
  assert.equal((await sdk.callTool({ name: 'click', arguments: { selector: 'button' } })).isError, true);
  ctx.store.revoke(ctx.ownerId, 'client', ctx.client.id, ctx.tenant.id);
  await assert.rejects(sdk.listTools());
});

test('credentials are hashed, rotation owner-scoped, and cross-owner browser membership explicit', async t => {
  const ctx = await setup(t);
  const other = another(ctx);
  assert(!JSON.stringify(ctx.store.client(ctx.client.id)).includes(ctx.client.credential));
  const rotated = ctx.store.rotateClient(ctx.ownerId, ctx.client.id, ctx.tenant.id);
  assert.equal(ctx.store.authenticateClient(ctx.client.credential, ctx.tenant.id), undefined);
  assert.equal(ctx.store.authenticateClient(rotated.credential, ctx.tenant.id).id, ctx.client.id);
  assert.throws(() => ctx.store.rotateClient(other.ownerId, ctx.client.id, ctx.tenant.id), /NOT_AUTHORIZED/);
  ctx.store.addMember(ctx.ownerId, ctx.tenant.id, other.ownerId);
  assert(ctx.store.member(other.ownerId, ctx.tenant.id));
  const foreign = { ...ctx, ownerId: other.ownerId };
  const d = await enroll(foreign);
  assert(ctx.store.linked(ctx.client.id, d.device.device_id, ctx.tenant.id));
  assert(!ctx.store.linked(other.client.id, d.device.device_id));
  ctx.store.removeMember(ctx.ownerId, ctx.tenant.id, other.ownerId);
  assert.equal(ctx.store.device(d.device.device_id), undefined);
});

test('denial cooldown is enforced while a local owner can request fresh approval', async t => {
  const ctx = await setup(t);
  const d = await enroll(ctx);
  const connection = await connect(ctx, d);
  ctx.app.bridge.requestAccess(ctx.client.id, d.device.device_id);
  const request = await connection.next('approval.request');
  connection.ws.send(JSON.stringify({ type: 'approval.deny', request_id: request.request_id }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.throws(() => ctx.app.bridge.requestAccess(ctx.client.id, d.device.device_id), /RATE_LIMITED/);
  assert.equal(ctx.app.bridge.requestAccess(ctx.client.id, d.device.device_id, true).state, 'pending');
});

test('silent devices lose authority at exactly 15 seconds', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: Date.now() });
  const ctx = await setup(t);
  const d = await enroll(ctx);
  const connection = await connect(ctx, d, { pong: false });
  await activate(ctx, d, connection);
  t.mock.timers.tick(14_999);
  assert.equal(ctx.app.bridge.grants.size, 1);
  t.mock.timers.tick(1);
  assert.equal(ctx.app.bridge.grants.size, 0);
  assert.equal(ctx.app.bridge.connections.size, 0);
  t.mock.timers.reset();
});

test('queue/input/deadline limits are exact and uncertain mutations never retry queued work', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: Date.now() });
  const ctx = await setup(t);
  const d = await enroll(ctx);
  const connection = await connect(ctx, d, { pong: false });
  const grant = await activate(ctx, d, connection);
  const bridge = ctx.app.bridge;
  await assert.rejects(bridge.operate(ctx.client.id, grant.target_id, 'evaluate_script',
    { script: 'x'.repeat(65_537) }), /INVALID_ARGUMENTS/);
  const work = [bridge.operate(ctx.client.id, grant.target_id, 'evaluate_script', { script: 'x'.repeat(65_536) }),
    ...Array.from({ length: 31 }, () => bridge.operate(ctx.client.id, grant.target_id, 'click', { selector: 'button' }))];
  const settled = Promise.allSettled(work);
  const command = await connection.next('command');
  assert.equal(command.args.script.length, 65_536);
  assert.equal(command.expires_at, Date.now() + 25_000);
  await assert.rejects(bridge.operate(ctx.client.id, grant.target_id, 'click', { selector: 'button' }), /QUEUE_FULL/);
  const session = bridge.connections.get(d.device.device_id);
  t.mock.timers.tick(10_000); bridge.refreshLiveness(session);
  t.mock.timers.tick(10_000); bridge.refreshLiveness(session);
  t.mock.timers.tick(4_999); assert.equal(bridge.grants.size, 1);
  t.mock.timers.tick(1);
  const outcomes = await settled;
  assert.match(outcomes[0].reason.message, /OUTCOME_UNKNOWN/);
  for (const outcome of outcomes.slice(1)) assert.match(outcome.reason.message, /COMMAND_EXPIRED/);
  assert.equal(bridge.grants.size, 0);
  assert.equal(bridge.calls.size, 0);
  t.mock.timers.reset();
});

test('tenant-bound captured WSS proof cannot authenticate a device on another endpoint', async t => {
  const ctx = await setup(t);
  const d = await enroll(ctx);
  const other = another(ctx);
  const ws = new WebSocket(`${ctx.base.replace('http:', 'ws:')}/extension/${other.tenant.id}`, { origin: EXTENSION_ORIGIN });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const closed = new Promise(resolve => ws.once('close', resolve));
  ws.send(JSON.stringify({ type: 'hello', tenant_id: other.tenant.id, key_id: d.id, version: VERSION }));
  await closed;
  assert.equal(ctx.app.bridge.connections.size, 0);
  assert.notDeepEqual(authPayload({ origin: ORIGIN, tenant_id: ctx.tenant.id }),
    authPayload({ origin: ORIGIN, tenant_id: other.tenant.id }));
});

test('setup preview creates no authority; signed-in approval creates one tenant and reveals credential only once', async t => {
  const ctx = await setup(t);
  const create = await ctx.request('/api/setup-requests', { agent_name: '<b>Atlas</b>', request_description: 'Help me use a website.' });
  assert.equal(create.status, 201);
  const request = await create.json();
  const verification = new URL(request.verification_url);
  const credential = new URLSearchParams(verification.hash.slice(1)).get('token');
  const id = request.request_id;
  const count = ctx.store.db.prepare('SELECT count(*) AS n FROM tenants').get().n;
  assert.equal((await ctx.request(verification.pathname, null, {}, 'GET')).status, 200);
  assert.equal(ctx.store.db.prepare('SELECT count(*) AS n FROM tenants').get().n, count);
  const opened = await ctx.request(`/api/setup-requests/${id}/open`, { token: credential }, { Origin: ORIGIN });
  assert.equal(opened.status, 200);
  const setupCookie = opened.headers.get('set-cookie').split(';')[0];
  const headers = { ...ownerHeaders(ctx), Cookie: `${ownerHeaders(ctx).Cookie}; ${setupCookie}` };
  const approvalPage = await (await ctx.request(verification.pathname, null, headers, 'GET')).text();
  assert(approvalPage.includes('&lt;b&gt;Atlas&lt;/b&gt;'));
  assert(!approvalPage.includes('<b>Atlas</b>'));
  const approved = await ctx.request(`${verification.pathname}/approve`, { csrf: ctx.session.csrf }, headers);
  assert.equal(approved.status, 200);
  const once = await approved.text();
  assert(once.includes('Credential (shown once)'));
  const status = await (await ctx.request(`/api/setup-requests/${id}/status`, { status_receipt: request.status_receipt })).json();
  assert.equal(status.state, 'approved');
  assert(status.connection_url.startsWith(`${ORIGIN}/join/t_`));
  assert(!JSON.stringify(status).includes('credential'));
  assert.equal(ctx.store.db.prepare('SELECT count(*) AS n FROM tenants').get().n, count + 1);
  assert.equal((await ctx.request(`${verification.pathname}/approve`, { csrf: ctx.session.csrf }, headers)).status, 404);
  assert.equal((await ctx.request(`/api/setup-requests/${id}/open`, { token: credential }, { Origin: ORIGIN })).status, 404);
});

test('a clean database completes agent-initiated setup after OIDC sign-in without pre-inviting the account', async t => {
  const store = new Store(':memory:');
  const app = createApp(store, {
    origin: ORIGIN, issuer: ISSUER, bind: '127.0.0.1', port: 0, protectedOrigins: [ORIGIN, ISSUER],
  }, {
    start: async flow => `${ISSUER}/authorize?state=${flow.state}`,
    finish: async () => ({ issuer: ISSUER, subject: 'fresh-pocketid-user', label: 'Denis' }),
  });
  const address = await app.listen();
  t.after(async () => { await app.close(); store.close(); });
  const request = (path, data, headers = {}, method = 'POST') => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method, redirect: 'manual', headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: data ? JSON.stringify(data) : undefined,
  });
  const created = await (await request('/api/setup-requests', {
    agent_name: 'Atlas', request_description: 'Help with my browser.',
  })).json();
  const link = new URL(created.verification_url);
  const opened = await request(`/api/setup-requests/${created.request_id}/open`,
    { token: new URLSearchParams(link.hash.slice(1)).get('token') }, { Origin: ORIGIN });
  const setupCookie = opened.headers.get('set-cookie').split(';')[0];
  const login = await request(`/login?setup=${created.request_id}`, null, { Cookie: setupCookie }, 'GET');
  const state = new URL(login.headers.get('location')).searchParams.get('state');
  const callback = await request(`/oidc/callback?state=${state}&code=fixture`, null,
    { Cookie: `${setupCookie}; __Host-domagent_flow=${state}` }, 'GET');
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get('location'), link.pathname);
  const account = store.db.prepare('SELECT * FROM owners WHERE subject=?').get('fresh-pocketid-user');
  assert.equal(account.label, 'Denis');
  assert.equal(account.admitted, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM tenants').get().n, 0);
  const sessionCookie = callback.headers.getSetCookie().find(cookie => cookie.startsWith('__Host-domagent_session=')).split(';')[0];
  const cookie = `${setupCookie}; ${sessionCookie}`;
  const approval = await request(link.pathname, null, { Cookie: cookie }, 'GET');
  assert.equal(approval.status, 200);
  const csrf = (await approval.text()).match(/name="csrf" value="([^"]+)"/)[1];
  const confirmed = await request(`${link.pathname}/approve`, { csrf }, { Cookie: cookie, Origin: ORIGIN });
  assert.equal(confirmed.status, 200);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM tenants').get().n, 1);
  store.disableOwner(account.id);
  const again = await request('/login', null, {}, 'GET');
  const newState = new URL(again.headers.get('location')).searchParams.get('state');
  const disabled = await request(`/oidc/callback?state=${newState}&code=fixture`, null,
    { Cookie: `__Host-domagent_flow=${newState}` }, 'GET');
  assert.equal(disabled.status, 403);
  assert((await disabled.text()).includes('disabled'));
});

test('setup receipts cannot redeem links; invalid, expired and cross-origin requests fail', async t => {
  const ctx = await setup(t);
  const request = await (await ctx.request('/api/setup-requests', { agent_name: 'Atlas', request_description: 'Website help' })).json();
  assert.equal((await ctx.request(`/api/setup-requests/${request.request_id}/open`,
    { token: request.status_receipt }, { Origin: ORIGIN })).status, 404);
  assert.equal((await ctx.request('/api/setup-requests', { agent_name: 'Atlas', request_description: 'Help' },
    { Origin: 'https://evil.test' })).status, 403);
  ctx.store.db.prepare('UPDATE setup_requests SET expires=0 WHERE id=?').run(request.request_id);
  assert.equal((await ctx.request(`/api/setup-requests/${request.request_id}/status`,
    { status_receipt: request.status_receipt })).status, 404);
});

test('tenant member approval is required before automatic key confirmation and rotation ends live grants', async t => {
  const ctx = await setup(t);
  const other = another(ctx);
  const started = await startEnrollment(ctx);
  const approve = `/pair/${ctx.tenant.id}/approve`;
  const values = { enrollment_id: started.enrollment.enrollment_id, csrf: other.session.csrf };
  assert.equal((await ctx.request(approve, values, ownerHeaders(other))).status, 403);
  assert.equal(ctx.store.enrollment(started.enrollment.enrollment_id, ctx.tenant.id).owner_id, null);
  assert.equal((await ctx.request(approve, { ...values, csrf: ctx.session.csrf }, ownerHeaders(ctx))).status, 200);
  const d = await enroll(ctx);
  const connection = await connect(ctx, d);
  await activate(ctx, d, connection);
  const rotated = await ctx.request(`/dashboard/tenants/${ctx.tenant.id}/rotate`,
    { client_id: ctx.client.id, csrf: ctx.session.csrf }, ownerHeaders(ctx));
  assert.equal(rotated.status, 200);
  assert.equal(ctx.app.bridge.grants.size, 0);
  assert.equal(ctx.store.authenticateClient(ctx.client.credential, ctx.tenant.id), undefined);
  assert.equal(ctx.app.bridge.connections.size, 1);
});

test('audit retains only allowed metadata and never page contents or credentials', () => {
  const original = process.stdout.write;
  let output = '';
  try {
    process.stdout.write = chunk => { output += chunk; return true; };
    audit('operation_finished', { code: 'OK', operation: 'evaluate_script', client_id: 'public-id',
      script: 'private-script', text: 'private-text', result: 'private-content', authorization: 'private-token' });
  } finally { process.stdout.write = original; }
  assert.deepEqual(JSON.parse(output), { event: 'operation_finished', code: 'OK', operation: 'evaluate_script', client_id: 'public-id' });
  assert(!output.includes('private-'));
});
