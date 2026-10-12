import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authPayload, grantPayload, LIVENESS_MS, POLICY_ID, verify } from '../../shared/protocol.js';
import { Controller } from '../src/controller.js';
import { DeviceKeys } from '../src/keys.js';

const origin = 'https://control.example';
const tenant_id = 't_abcdefghijklmnopqrstuv';
const binding = { tenant_id, epoch: 'epoch-1', connection_id: 'connection-1' };
const extensionUrl = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/';
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
class Socket {
  constructor() { this.readyState = 1; this.sent = []; }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
}

async function fixture(t) {
  let clock = 10_000;
  const calls = [];
  const saved = {};
  const keys = new DeviceKeys({ async get() {}, async put(record) { return record; } });
  const record = await keys.get(origin, tenant_id);
  record.identity = { tenant_id, tenant_label: 'Atlas', device_id: 'device-1', owner_id: 'owner-1', owner_label: 'Owner' };
  const adapter = {
    async browserInfo() { return { extension_version: '4.3.3', browser_name: 'chrome', browser_version: null }; },
    capabilities: () => ['navigate', 'get_text', 'evaluate_script', 'click', 'type_text'],
    async initialize(inventory) { calls.push(['initialize', inventory]); },
    async createWorkspace(id) { calls.push(['workspace', id]); return id + 1000; },
    async assertWorkspace(grant) { calls.push(['assertWorkspace', grant.tabId, grant.windowId]); },
    async closeWorkspace(id, windowId) { calls.push(['closeWorkspace', id, windowId]); },
    async selectedTabById(id) { calls.push(['select', id]); return { id, url: 'https://site.example/' }; },
    async requestWindow(id) { calls.push(['window', id]); },
    async closeRequestWindow(id) { calls.push(['closeWindow', id]); },
    async protect(id, origins) { calls.push(['protect', id, origins]); },
    async inspect() {},
    async attach(id) { calls.push(['attach', id]); },
    async release(id) { calls.push(['release', id]); },
    async execute(grant, operation, args, check) { check(); calls.push(['execute', grant.tabId, operation]); return { text: 'page' }; },
  };
  const controller = new Controller({
    adapter, keys, Socket, extensionUrl, now: () => clock,
    storage: { async get() { return saved; }, async set(value) { Object.assign(saved, value); } },
    inventoryStorage: { async get() { return { dedicatedTabs: [{ tabId: 999 }] }; }, async set() {} },
  });
  controller.report = error => controller.failures.push(error.message);
  controller.config = { service_origin: origin, tenant_id, local_protected_origins: ['https://idp.example'], enabled: true };
  controller.record = record;
  controller.connect();
  const socket = controller.socket;
  socket.onopen();
  const receive = message => controller.receive(JSON.stringify(message), socket, controller.generation);
  const challenge = { type: 'challenge', origin, ...binding, nonce: 'nonce-1', key_id: record.key_id };
  await receive(challenge);
  await receive({ type: 'authenticated', ...binding, ...record.identity, protected_origins: ['https://idp.example'],
    eligible_clients: [{ id: 'client-1', label: 'Atlas' }] });
  t.after(() => controller.dispose());
  return { controller, adapter, calls, socket, saved, record, challenge, receive,
    advance(ms) { clock += ms; controller.lastPing = clock; } };
}

async function pending(f, client_id = 'client-1', request_id = crypto.randomUUID()) {
  const request = { type: 'approval.request', ...binding, request_id, client_id,
    client_label: '<img src=x onerror=evil()>', description: 'Help me research a website in the explicitly selected browser tab',
    policy_id: POLICY_ID, nonce: `nonce-${request_id}`,
    expires_at: f.controller.now() + 600_000, protected_origins: ['https://idp.example'] };
  await f.receive(request);
  return request;
}
async function approve(f, clientId = 'client-1', tabId = 100, ack = true) {
  const request = await pending(f, clientId);
  await f.controller.approve(request.request_id, tabId);
  const grant = [...f.controller.grants.values()].find(grant => grant.tabId === tabId);
  if (ack) await f.receive({ type: 'grant.active', tenant_id, target_id: grant.target_id, tab_id: tabId,
    window_id: grant.windowId, client_id: clientId });
  return { grant, request };
}
function command(f, grant, extra = {}) {
  return { type: 'command', ...binding, request_id: crypto.randomUUID(), target_id: grant.target_id,
    client_id: grant.client_id, operation: 'get_text', args: {}, description: 'Read this page in the explicitly selected browser tab',
    expires_at: f.controller.now() + 600_000, ...extra };
}
async function execute(f, grant, message, action = 'approve') {
  f.controller.enqueue(message);
  f.controller.decide(grant.target_id, message.request_id, action);
  await f.receive({ type: 'command.execute', tenant_id, request_id: message.request_id,
    target_id: grant.target_id, expires_at: f.controller.now() + 25_000 });
  await flush();
  return f.socket.sent.find(value => value.type === 'result' && value.request_id === message.request_id);
}

test('v4 identity proofs preserve keys and require exact tenant/connection', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.socket.sent[0], { type: 'hello', version: 4, tenant_id, key_id: f.record.key_id });
  assert(await verify(f.record.public_key, authPayload(f.challenge), f.socket.sent[1].signature));
  await assert.rejects(f.receive({ type: 'ping', tenant_id: 'other' }), /NOT_AUTHORIZED/);
});
test('approved actions execute with bounded local budgets despite server/browser clock skew', async t => {
  for (const skew of [200, 120_000, -120_000]) {
    const f = await fixture(t);
    f.advance(200_000);
    const request = { type: 'approval.request', ...binding, request_id: crypto.randomUUID(),
      client_id: 'client-1', client_label: 'Atlas', description: 'Share a tab in the explicitly selected browser tab',
      policy_id: POLICY_ID, nonce: 'request-nonce', protected_origins: [],
      expires_at: f.controller.now() + 600_000 + skew, wait_timeout_ms: 600_000 };
    await f.receive(request);
    await f.controller.approve(request.request_id, 100);
    const grant = [...f.controller.grants.values()][0];
    await f.receive({ type: 'grant.active', tenant_id, client_id: grant.client_id, tab_id: 100,
      window_id: grant.windowId, target_id: grant.target_id });
    const action = command(f, grant, { expires_at: f.controller.now() + 600_000 + skew,
      wait_timeout_ms: 600_000, operation: 'navigate', args: { url: 'https://ordinary.example/' } });
    f.controller.enqueue(action);
    f.controller.decide(grant.target_id, action.request_id, 'approve');
    await f.receive({ type: 'command.execute', tenant_id, request_id: action.request_id,
      target_id: grant.target_id, expires_at: f.controller.now() + 25_000 + skew, execution_timeout_ms: 25_000 });
    await flush();
    const result = f.socket.sent.find(message => message.type === 'result' && message.request_id === action.request_id);
    assert.equal(result.error, undefined);
    assert.equal(f.controller.phase, 'authenticated');
    assert.equal(f.controller.grants.size, 1);
    assert(f.calls.some(call => call[0] === 'execute'));
  }
});

test('invalid execution budget rejects only its action without dropping the connection or another shared tab', async t => {
  const f = await fixture(t);
  const { grant } = await approve(f);
  await approve(f, 'client-2', 101);
  const message = command(f, grant);
  f.controller.enqueue(message);
  f.controller.decide(grant.target_id, message.request_id, 'approve');
  await f.receive({ type: 'command.execute', tenant_id, request_id: message.request_id,
    target_id: grant.target_id, expires_at: f.controller.now() + 25_000, execution_timeout_ms: 25_001 });
  assert.equal(f.socket.sent.at(-1).error.code, 'INVALID_MESSAGE');
  assert.equal(f.controller.phase, 'authenticated');
  assert.equal(f.controller.grants.size, 2);
  assert.equal(f.calls.some(call => call[0] === 'execute'), false);
});
test('native browser fetch has its global receiver', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async function () {
    assert.equal(this, globalThis);
    return { ok: true, async text() { return '{"nonce":"test"}'; } };
  };
  const f = await fixture(t);
  assert.deepEqual(await f.controller.api('challenge'), { nonce: 'test' });
});
test('every sharing request alerts trusted controls before any heartbeat; description is visible', async t => {
  const f = await fixture(t);
  const request = await pending(f);
  await flush();
  assert(f.calls.some(call => call[0] === 'window' && call[1] === request.request_id));
  assert.equal(f.controller.snapshot().pending[0].description, request.description);
});
test('actual selected tab and fixed capabilities are signed after protection and attachment', async t => {
  const f = await fixture(t);
  const { grant, request } = await approve(f, 'client-1', 42);
  const approval = f.socket.sent.find(message => message.type === 'grant.approve');
  assert.equal(grant.tabId, 42);
  assert.deepEqual(approval.capabilities, f.adapter.capabilities());
  assert.deepEqual(f.calls.filter(call => ['select', 'protect', 'attach'].includes(call[0])).map(call => call[0]),
    ['select', 'protect', 'attach']);
  assert(await verify(f.record.public_key, grantPayload({ ...request, origin,
    target_id: grant.target_id, tab_id: 42, window_id: grant.windowId, capabilities: approval.capabilities }), approval.signature));
  assert.equal(await verify(f.record.public_key, grantPayload({ ...request, origin,
    target_id: grant.target_id, tab_id: 43, window_id: grant.windowId, capabilities: approval.capabilities }), approval.signature), false);
});
test('failed protection and changed selection never grant authority', async t => {
  const f = await fixture(t);
  const request = await pending(f);
  f.adapter.selectedTabById = async () => { throw new Error('TARGET_STALE'); };
  await assert.rejects(f.controller.approve(request.request_id, 42), /TARGET_STALE/);
  f.adapter.selectedTabById = async id => ({ id });
  f.adapter.protect = async () => { throw new Error('PROTECTION_UNAVAILABLE'); };
  await assert.rejects(f.controller.approve(request.request_id, 42), /PROTECTION_UNAVAILABLE/);
  assert.equal(f.controller.grants.size, 0);
  assert(!f.socket.sent.some(message => message.type === 'grant.approve'));
});
test('multiple tabs per client are independent and another client cannot steal a shared tab', async t => {
  const f = await fixture(t);
  const { grant: a } = await approve(f, 'client-1', 1);
  const { grant: b } = await approve(f, 'client-1', 2);
  assert.notEqual(a.target_id, b.target_id);
  const other = await pending(f, 'client-2');
  await assert.rejects(f.controller.approve(other.request_id, 1), /APPROVAL_REQUIRED/);
  assert.equal(f.controller.grants.get(a.target_id), a);
  const { grant: reused } = await approve(f, 'client-1', 1);
  assert.equal(reused.target_id, a.target_id);
  assert.equal(f.controller.grants.size, 2);
});
test('grant ACK includes actual tab and no commands execute before ACK', async t => {
  const f = await fixture(t);
  const { grant } = await approve(f, 'client-1', 100, false);
  f.controller.enqueue(command(f, grant));
  assert.equal(f.socket.sent.at(-1).error.code, 'APPROVAL_REQUIRED');
  await assert.rejects(f.receive({ type: 'grant.active', tenant_id, target_id: grant.target_id,
    client_id: grant.client_id, tab_id: 200 }), /NOT_AUTHORIZED/);
});
test('commands wait for local decision and then server execution handshake', async t => {
  const f = await fixture(t);
  const { grant } = await approve(f);
  const message = command(f, grant);
  f.controller.enqueue(message);
  await flush();
  assert.equal(f.calls.some(call => call[0] === 'execute'), false);
  assert.equal(f.controller.snapshot().targets[0].commands[0].description, message.description);
  f.controller.decide(grant.target_id, message.request_id, 'approve');
  assert.equal(f.socket.sent.at(-1).type, 'command.ready');
  await flush();
  assert.equal(f.calls.some(call => call[0] === 'execute'), false);
  await f.receive({ type: 'command.execute', tenant_id, request_id: message.request_id,
    target_id: grant.target_id, expires_at: f.controller.now() + 25_000 });
  await flush();
  assert.equal(f.socket.sent.at(-1).result.text, 'page');
});
test('an unsolicited execute cannot bypass approval', async t => {
  const f = await fixture(t);
  const { grant } = await approve(f);
  const message = command(f, grant);
  f.controller.enqueue(message);
  await assert.rejects(f.receive({ type: 'command.execute', tenant_id, request_id: message.request_id,
    target_id: grant.target_id, expires_at: f.controller.now() + 25_000 }), /APPROVAL_REQUIRED/);
  assert(!f.calls.some(call => call[0] === 'execute'));
});
test('Decline returns ACTION_DECLINED without ending sharing', async t => {
  const f = await fixture(t);
  const { grant } = await approve(f);
  const message = command(f, grant);
  f.controller.enqueue(message);
  f.controller.decide(grant.target_id, message.request_id, 'decline');
  assert.equal(f.socket.sent.at(-1).error.code, 'ACTION_DECLINED');
  assert.equal(grant.state, 'active');
});
test('allow-all affects ordinary page commands in only this grant; never human Done', async t => {
  const f = await fixture(t);
  const { grant } = await approve(f);
  await execute(f, grant, command(f, grant), 'allow_all');
  const next = command(f, grant);
  f.controller.enqueue(next);
  assert.equal(grant.queue[0].state, 'ready');
  f.controller.cancelCommand(next);
  const human = command(f, grant, { operation: 'request_handoff' });
  f.controller.enqueue(human);
  assert.equal(grant.queue[0].state, 'pending');
  assert.throws(() => f.controller.decide(grant.target_id, human.request_id, 'approve'), /INVALID_ARGUMENT/);
  const { grant: other } = await approve(f, 'client-1', 200);
  f.controller.enqueue(command(f, other));
  assert.equal(other.queue[0].state, 'pending');
});
test('human Done survives login navigation, completes handshake, and retains sharing', async t => {
  const f = await fixture(t);
  const { grant } = await approve(f);
  const human = command(f, grant, { operation: 'request_handoff', description: 'Sign in yourself in the explicitly selected browser tab' });
  f.controller.enqueue(human);
  f.controller.tabEvent(grant.tabId, 'navigation', 'https://site.example/login');
  f.controller.decide(grant.target_id, human.request_id, 'done');
  assert.equal(f.socket.sent.at(-1).type, 'command.ready');
  await f.receive({ type: 'command.execute', tenant_id, request_id: human.request_id,
    target_id: grant.target_id, expires_at: f.controller.now() + 25_000 });
  await flush();
  assert.deepEqual(f.socket.sent.at(-1).result, { state: 'completed', user_confirmed: true });
  assert.equal(grant.state, 'active');
  assert(!f.calls.some(call => call[0] === 'execute'));
});
test('Cancel human assistance declines only that request', async t => {
  const f = await fixture(t);
  const { grant } = await approve(f);
  const message = command(f, grant, { operation: 'request_handoff' });
  f.controller.enqueue(message);
  f.controller.decide(grant.target_id, message.request_id, 'decline');
  assert.equal(f.socket.sent.at(-1).error.code, 'ACTION_DECLINED');
  assert.equal(grant.state, 'active');
});
test('navigation rejects old-document queued and ready actions without ending sharing', async t => {
  const f = await fixture(t);
  const { grant } = await approve(f);
  const message = command(f, grant);
  f.controller.enqueue(message);
  f.controller.decide(grant.target_id, message.request_id, 'approve');
  f.controller.tabEvent(grant.tabId, 'navigation', 'https://site.example/new');
  assert.equal(f.socket.sent.at(-1).error.code, 'TARGET_STALE');
  await f.receive({ type: 'command.execute', tenant_id, request_id: message.request_id,
    target_id: grant.target_id, expires_at: f.controller.now() + 25_000 });
  assert.equal(grant.state, 'active');
  assert(!f.calls.some(call => call[0] === 'execute'));
});

test('only unapproved document-unbound reads refresh their preview through navigation; no approved work is rebound', async t => {
  const f = await fixture(t);
  const { grant } = await approve(f);
  let resolveOld;
  let preparations = 0;
  f.adapter.prepareAction = async () => {
    preparations++;
    if (preparations === 1) return new Promise(resolve => { resolveOld = resolve; });
    return { document_nonce: 'new-document', summary: ['Tab: new document'], approval_token: 'new-binding' };
  };
  f.adapter.releaseAction = async (_grant, preview) => { if (preview) f.calls.push(['releasePreview', preview.approval_token]); };
  const message = command(f, grant);
  f.controller.enqueue(message);
  f.controller.tabEvent(grant.tabId, 'navigation', 'https://site.example/new');
  assert.equal(grant.queue.length, 1);
  assert.equal(grant.queue[0].preparing, true);
  resolveOld({ document_nonce: 'old-document', summary: ['Tab: old document'], approval_token: 'old-binding' });
  await flush();
  assert.equal(grant.queue[0].preview.document_nonce, 'new-document');
  assert.equal(grant.queue[0].preparing, false);
  assert(f.calls.some(call => call[0] === 'releasePreview' && call[1] === 'old-binding'));
  assert(!f.socket.sent.some(frame => frame.type === 'command.ready'));
  f.controller.decide(grant.target_id, message.request_id, 'approve');
  f.controller.tabEvent(grant.tabId, 'navigation', 'https://site.example/another');
  assert.equal(f.socket.sent.at(-1).error.code, 'TARGET_STALE');
  assert.equal(grant.queue.length, 0);
  assert(!f.calls.some(call => call[0] === 'execute'));
  for (const extra of [
    { operation: 'type_text', args: { selector: '#input', text: 'value' } },
    { operation: 'evaluate_script', args: { script: 'document.title' } },
    { args: { ref: 'e1', document: 'previous-document' } },
  ]) {
    const bound = command(f, grant, extra);
    f.controller.enqueue(bound);
    f.controller.tabEvent(grant.tabId, 'navigation', 'https://site.example/next');
    assert.equal(f.socket.sent.find(frame => frame.type === 'result' && frame.request_id === bound.request_id).error.code, 'TARGET_STALE');
  }
});
test('expired human wait returns COMMAND_EXPIRED and keeps grant', async t => {
  const f = await fixture(t);
  const { grant } = await approve(f);
  f.controller.enqueue(command(f, grant, { expires_at: f.controller.now() + 100 }));
  f.advance(101);
  f.controller.tick();
  assert.equal(f.socket.sent.at(-1).error.code, 'COMMAND_EXPIRED');
  assert.equal(grant.state, 'active');
});
test('human wait is bounded at 16 without starving heartbeats', async t => {
  const f = await fixture(t);
  const { grant } = await approve(f);
  for (let i = 0; i < 17; i++) f.controller.enqueue(command(f, grant));
  assert.equal(grant.queue.length, 16);
  assert.equal(f.socket.sent.at(-1).error.code, 'QUEUE_FULL');
  await f.receive({ type: 'ping', tenant_id });
  assert.equal(f.socket.sent.at(-1).type, 'pong');
});
test('stop immediately invalidates pending/executing work; no late execute or results', async t => {
  const f = await fixture(t);
  const { grant } = await approve(f);
  let finish;
  f.adapter.execute = () => new Promise(resolve => { finish = resolve; });
  const message = command(f, grant);
  f.controller.enqueue(message);
  f.controller.decide(grant.target_id, message.request_id, 'approve');
  await f.receive({ type: 'command.execute', tenant_id, request_id: message.request_id,
    target_id: grant.target_id, expires_at: f.controller.now() + 25_000 });
  const ending = f.controller.end(grant.target_id, 'OWNER_PAUSED');
  assert.equal(f.controller.grants.size, 0);
  await ending;
  const resultCount = f.socket.sent.filter(value => value.type === 'result').length;
  finish({ text: 'late' });
  await flush();
  await f.receive({ type: 'command.execute', tenant_id, request_id: message.request_id,
    target_id: grant.target_id, expires_at: f.controller.now() + 25_000 });
  assert.equal(f.socket.sent.filter(value => value.type === 'result').length, resultCount);
});
test('server cancel removes waiting work but uncertain execution ends grant', async t => {
  const f = await fixture(t);
  const { grant } = await approve(f);
  const pending = command(f, grant);
  f.controller.enqueue(pending);
  await f.receive({ ...pending, type: 'command.cancel' });
  assert.equal(grant.queue.length, 0);
  assert.equal(grant.state, 'active');
  f.adapter.execute = () => new Promise(() => {});
  const running = command(f, grant);
  f.controller.enqueue(running);
  f.controller.decide(grant.target_id, running.request_id, 'approve');
  await f.receive({ type: 'command.execute', tenant_id, request_id: running.request_id,
    target_id: grant.target_id, expires_at: f.controller.now() + 25_000 });
  await f.receive({ ...running, type: 'command.cancel' });
  assert.equal(f.controller.grants.size, 0);
});
test('execution timeout never retries or advances another side effect', async t => {
  const f = await fixture(t);
  const { grant } = await approve(f);
  const result = await execute(f, grant, command(f, grant), 'allow_all');
  assert(result.result);
  f.adapter.execute = async () => { throw new Error('OUTCOME_UNKNOWN'); };
  const message = command(f, grant);
  f.controller.enqueue(message);
  f.controller.enqueue(command(f, grant));
  await f.receive({ type: 'command.execute', tenant_id, request_id: message.request_id,
    target_id: grant.target_id, expires_at: f.controller.now() + 25_000 });
  await flush();
  assert.equal(f.controller.grants.size, 0);
  assert.equal(f.socket.sent.filter(value => value.type === 'command.ready').length, 2);
  assert.equal(f.socket.sent.find(value => value.request_id === message.request_id && value.type === 'result').error.code, 'OUTCOME_UNKNOWN');
});
test('selector/handoff errors retain sharing; inspection failure ends unusable grant', async t => {
  const f = await fixture(t);
  const { grant } = await approve(f);
  for (const code of ['ELEMENT_NOT_FOUND', 'INVALID_SELECTOR', 'HANDOFF_REQUIRED',
    'ELEMENT_AMBIGUOUS', 'ELEMENT_STALE', 'ELEMENT_DISABLED', 'ELEMENT_READONLY',
    'ELEMENT_NOT_VISIBLE', 'ELEMENT_OBSCURED', 'ELEMENT_NOT_EDITABLE', 'OPTION_NOT_FOUND', 'WAIT_TIMEOUT', 'OPERATION_FAILED']) {
    f.adapter.execute = async () => { throw new Error(code); };
    assert.equal((await execute(f, grant, command(f, grant))).error.code, code);
    assert.equal(grant.state, 'active');
  }
  f.adapter.execute = async () => { throw new Error('PAGE_UNAVAILABLE'); };
  await execute(f, grant, command(f, grant));
  assert.equal(f.controller.grants.size, 0);
});
test('wait errors retain only fixed readiness diagnostics, not exception contents', async t => {
  const f = await fixture(t);
  const { grant } = await approve(f);
  f.adapter.execute = async () => {
    throw Object.assign(new Error('private source or page detail'), {
      code: 'WAIT_TIMEOUT', last_error: 'ELEMENT_OBSCURED', timeout_ms: 100,
    });

  };
  const result = await execute(f, grant, command(f, grant));
  assert.deepEqual(result.error, { code: 'WAIT_TIMEOUT', last_error: 'ELEMENT_OBSCURED', timeout_ms: 100 });
  assert.equal(JSON.stringify(result).includes('private source'), false);
  assert.equal(grant.state, 'active');
});
test('positive approval waits for target preparation and executes only the captured preview', async t => {
  const f = await fixture(t);
  const { grant } = await approve(f);
  let resolve;
  f.adapter.prepareAction = () => new Promise(done => { resolve = done; });
  const message = command(f, grant, { operation: 'click', args: { selector: '#button' }, description: 'Click the intended button in this shared browser tab' });
  f.controller.enqueue(message);
  assert.throws(() => f.controller.decide(grant.target_id, message.request_id, 'approve'), /APPROVAL_REQUIRED/);
  const preview = { summary: ['Operation: click', 'Selector: #button'], approval_token: 'bound-element' };
  resolve(preview);
  await flush();
  assert.deepEqual(f.controller.snapshot().targets[0].commands[0].summary, preview.summary);
  let usedPreview;
  f.adapter.execute = async (_grant, _operation, _args, check, bound) => {
    check();
    usedPreview = bound;
    return { clicked: true };
  };
  f.controller.decide(grant.target_id, message.request_id, 'approve');
  await f.receive({ type: 'command.execute', tenant_id, request_id: message.request_id,
    target_id: grant.target_id, expires_at: f.controller.now() + 25_000 });
  await flush();
  assert.equal(usedPreview, preview);
});
test('late action preparation after cancellation never restores an approval or executes', async t => {
  const f = await fixture(t);
  const { grant } = await approve(f);
  let resolve;
  let released = 0;
  f.adapter.prepareAction = () => new Promise(done => { resolve = done; });
  f.adapter.releaseAction = async () => { released++; };
  const message = command(f, grant);
  f.controller.enqueue(message);
  f.controller.cancelCommand({ request_id: message.request_id, target_id: grant.target_id });
  resolve({ summary: ['Read'], approval_token: 'cancelled-binding' });
  await flush();
  assert.equal(grant.queue.length, 0);
  assert.equal(f.socket.sent.some(frame => frame.type === 'command.ready'), false);
  assert(released >= 1);
});
test('page readiness follows ordinary navigation but targeted queued work remains document-bound', async t => {
  const f = await fixture(t);
  const oldCapabilities = f.adapter.capabilities();
  f.adapter.capabilities = () => [...oldCapabilities, 'wait_for_page'];
  const { grant } = await approve(f);
  const ready = command(f, grant, { operation: 'wait_for_page' });
  f.controller.enqueue(ready);
  f.controller.tabEvent(grant.tabId, 'navigation', 'https://site.example/new');
  assert.equal(grant.queue.length, 1);
  f.adapter.execute = async (_grant, operation, _args, check) => {
    assert.equal(operation, 'wait_for_page');
    f.controller.tabEvent(grant.tabId, 'navigation', 'https://site.example/new');
    check();
    return { state: 'loaded', document: 'new-document' };
  };
  f.controller.decide(grant.target_id, ready.request_id, 'approve');
  await f.receive({ type: 'command.execute', tenant_id, request_id: ready.request_id,
    target_id: grant.target_id, expires_at: f.controller.now() + 25_000 });
  await flush();
  assert.equal(f.socket.sent.find(message => message.type === 'result' && message.request_id === ready.request_id).result.state, 'loaded');
  const targeted = command(f, grant, { operation: 'click', args: { ref: 'e1', document: 'new-document' } });
  f.controller.enqueue(targeted);
  f.controller.tabEvent(grant.tabId, 'navigation', 'https://site.example/another');
  assert.equal(f.socket.sent.find(message => message.type === 'result' && message.request_id === targeted.request_id).error.code, 'TARGET_STALE');
  assert.equal(grant.state, 'active');
});
test('protected origins still end authority and retain redirect protection', async t => {
  const f = await fixture(t);
  const { grant } = await approve(f);
  f.controller.tabEvent(grant.tabId, 'protected_pending', `${origin}/account`);
  assert.equal(f.controller.grants.size, 0);
  assert.equal(f.socket.sent.at(-1).reason, 'HANDOFF');
});
test('request cancellation and closing a request window deny no other requests', async t => {
  const f = await fixture(t);
  const first = await pending(f);
  const second = await pending(f);
  f.adapter.onRequestClosed(first.request_id);
  assert.equal(f.controller.pending.size, 1);
  assert.equal(f.socket.sent.at(-1).type, 'approval.deny');
  await f.receive({ type: 'approval.cancel', tenant_id, request_id: second.request_id, reason: 'timeout' });
  assert.equal(f.controller.pending.size, 0);
});
test('page decisions are rejected even with the genuine nonce, sender and document', async t => {
  const f = await fixture(t);
  const { grant } = await approve(f);
  grant.indicatorToken = 'nonce';
  grant.indicatorDocument = { url: 'https://site.example/', documentId: 'document-1' };
  const message = command(f, grant);
  f.controller.enqueue(message);
  const sender = { id: 'extension', tab: { id: 100 }, frameId: 0, documentId: 'document-1', url: 'https://site.example/' };
  const decision = { type: 'page.decision', target_id: grant.target_id, request_id: message.request_id, token: 'nonce', action: 'approve' };
  for (const change of [{ id: 'other' }, { frameId: 2 }, { tab: { id: 999 } }, { documentId: 'old' }, { url: 'https://other.example/' }]) {
    assert.throws(() => f.controller.decisionFromPage(decision, { ...sender, ...change }, 'extension'), /NOT_AUTHORIZED/);
  }
  assert.throws(() => f.controller.decisionFromPage({ ...decision, token: 'old' }, sender, 'extension'), /NOT_AUTHORIZED/);
  for (const action of ['approve', 'allow_all', 'done', 'decline']) {
    assert.throws(() => f.controller.decisionFromPage({ ...decision, action }, sender, 'extension'), /NOT_AUTHORIZED/);
  }
  assert.equal(grant.queue[0].state, 'pending');
  assert.equal(grant.allowAll, undefined);
  assert(!f.socket.sent.some(frame => frame.type === 'command.ready'));
  for (const change of [{ id: 'other' }, { frameId: 2 }, { tab: { id: 999 } }, { documentId: 'old' }]) {
    assert.throws(() => f.controller.stopFromPage({ ...decision, type: 'page.stop' },
      { ...sender, ...change }, 'extension'), /NOT_AUTHORIZED/);
  }
  await f.controller.stopFromPage({ ...decision, type: 'page.stop' }, sender, 'extension');
  assert.equal(f.controller.grants.size, 0);
  assert(f.calls.some(call => call[0] === 'closeWorkspace' && call[1] === 100));
});

test('toolbar sharing captures a one-shot intent; navigation cancels it and ambiguity never guesses', { timeout: 2000 }, async t => {
  const f = await fixture(t);
  const sent = f.controller.send.bind(f.controller);
  let acknowledge;
  const approval = new Promise(resolve => { acknowledge = resolve; });
  f.controller.send = message => {
    sent(message);
    if (message.type === 'grant.approve') acknowledge();
  };
  await f.controller.shareSelected(100);
  assert.equal(f.socket.sent.at(-1).type, 'access.request');
  await pending(f);
  await approval;
  assert.equal(f.socket.sent.at(-1).type, 'grant.approve');
  assert.equal(f.controller.toolbarIntent, null);
  assert.equal([...f.controller.grants.values()][0].allowAll, undefined);
  const other = await fixture(t);
  await other.controller.shareSelected(100);
  other.controller.tabEvent(100, 'navigation', 'https://site.example/new');
  await pending(other);
  await flush();
  assert.equal(other.controller.grants.size, 0);
  await pending(other, 'client-2');
  await assert.rejects(other.controller.shareSelected(100), /APPROVAL_REQUIRED/);
});

test('workspace boundary loss revokes before cleanup and explicit disconnect closes each owned tab', async t => {
  const f = await fixture(t);
  const { grant } = await approve(f);
  f.controller.tabEvent(grant.tabId, 'workspace_changed');
  assert.equal(f.controller.grants.size, 0);
  assert(f.controller.history.entries.some(entry => entry.event === 'workspace_changed'));
  const { grant: a } = await approve(f, 'client-1', 101);
  const { grant: b } = await approve(f, 'client-1', 102);
  const closing = f.controller.disconnect();
  assert.equal(f.controller.grants.size, 0);
  await closing;
  assert.deepEqual(f.calls.filter(call => call[0] === 'closeWorkspace').map(call => call.slice(1)),
    [[a.tabId, a.windowId], [b.tabId, b.windowId]]);
});
test('liveness loss and restart preserve pairing but never restore user-tab authority', async t => {
  const f = await fixture(t);
  await approve(f);
  f.advance(LIVENESS_MS);
  f.controller.lastPing = f.controller.now() - LIVENESS_MS;
  f.controller.tick();
  assert.equal(f.controller.grants.size, 0);
  assert.equal(f.record.identity.device_id, 'device-1');
  f.saved.config = undefined;
  await f.controller.initialize();
  assert.deepEqual(f.calls.find(call => call[0] === 'initialize')[1], []);
  assert.equal(f.controller.inventory.length, 0);
});
