import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authPayload, grantPayload, LIVENESS_MS, verify } from '../../shared/protocol.js';
import { Controller } from '../src/controller.js';
import { DeviceKeys } from '../src/keys.js';

const origin = 'https://control.example';
const binding = { epoch: 'epoch-1', connection_id: 'connection-1' };
const extensionUrl = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/';
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };

class Socket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.sent = [];
    Socket.instances.push(this);
  }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
}

async function fixture() {
  let clock = 10_000;
  let tab = 100;
  const calls = [];
  const saved = {};
  const keys = new DeviceKeys({
    async get() { return undefined; }, async put(record) { return record; },
  });
  const record = await keys.get(origin);
  record.identity = { device_id: 'device-1', owner_id: 'owner-1', owner_label: 'Owner' };
  const adapter = {
    capabilities: () => ['navigate', 'get_text', 'evaluate_script', 'click', 'type_text'],
    async initialize() {},
    async createTab(previous) { calls.push(['create', previous]); return { id: previous || tab++ }; },
    async protect(tabId, origins) { calls.push(['protect', tabId, origins]); },
    async inspect() {},
    async attach(tabId) { calls.push(['attach', tabId]); },
    async release(tabId) { calls.push(['release', tabId]); },
    async execute(grant, operation, args, check) { check(); calls.push(['execute', grant.tabId, operation]); return { text: 'page' }; },
  };
  const controller = new Controller({
    adapter, keys, Socket, extensionUrl, now: () => clock,
    storage: { async get() { return saved; }, async set(value) { Object.assign(saved, value); } },
    inventoryStorage: { async get() { return saved; }, async set(value) { Object.assign(saved, value); } },
  });
  controller.report = error => controller.failures.push(error.message);
  controller.config = { service_origin: origin, local_protected_origins: ['https://idp.example'], enabled: true };
  controller.record = record;
  controller.connect();
  const socket = controller.socket;
  socket.onopen();
  const challenge = { type: 'challenge', origin, ...binding, nonce: 'nonce-1', key_id: record.key_id };
  await controller.receive(JSON.stringify(challenge), socket, controller.generation);
  await controller.receive(JSON.stringify({ type: 'authenticated', ...binding, ...record.identity,
    protected_origins: ['https://idp.example'] }), socket, controller.generation);
  return { controller, adapter, calls, socket, saved, record, challenge,
    advance(ms) { clock += ms; }, flush };
}

async function pending(f, clientId = 'client-1', requestId = 'approval-1') {
  const request = { type: 'approval.request', ...binding, request_id: requestId, client_id: clientId,
    client_label: '<img src=x onerror=evil()>', policy_id: 'page-control-v1', nonce: `nonce-${requestId}`,
    expires_at: f.controller.now() + 60_000, protected_origins: ['https://idp.example'] };
  await f.controller.receive(JSON.stringify(request), f.socket, f.controller.generation);
  return request;
}

function command(grant, extra = {}) {
  return { type: 'command', ...binding, request_id: crypto.randomUUID(), target_id: grant.target_id,
    client_id: grant.client_id, operation: 'get_text', args: {}, expires_at: 25_000, ...extra };
}

async function approve(f, clientId = 'client-1', requestId = 'approval-1', ack = true) {
  const request = await pending(f, clientId, requestId);
  await f.controller.approve(requestId, ['navigate', 'get_text']);
  const grant = [...f.controller.grants.values()].find(grant => grant.client_id === clientId);
  if (ack) await f.controller.receive(JSON.stringify({ type: 'grant.active',
    target_id: grant.target_id, client_id: clientId }), f.socket, f.controller.generation);
  return { grant, request };
}

test('handshake sends key-only hello and challenge-bound proof; no preauth commands', async () => {
  const f = await fixture();
  assert.deepEqual(f.socket.sent[0], { type: 'hello', version: 1, key_id: f.record.key_id });
  assert.equal(await verify(f.record.public_key, authPayload(f.challenge), f.socket.sent[1].signature), true);
  assert.match(f.socket.url, /^wss:/);
  const generation = f.controller.generation;
  f.controller.connection = null;
  await assert.rejects(f.controller.receive(JSON.stringify(command({ target_id: 'target', client_id: 'client' })),
    f.socket, generation), /NOT_AUTHORIZED/);
  f.controller.dispose();
});

test('native browser fetch is invoked with its required global receiver', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function () {
    assert.equal(this, globalThis);
    return { ok: true, async text() { return '{"nonce":"test"}'; } };
  };
  try {
    const controller = new Controller({
      adapter: {}, extensionUrl, keys: {}, storage: {}, inventoryStorage: {},
    });
    controller.config.service_origin = origin;
    assert.deepEqual(await controller.api('challenge'), { nonce: 'test' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('wrong service-origin challenge and mismatched authenticated generation are rejected', async () => {
  const f = await fixture();
  f.controller.phase = 'authenticating';
  await assert.rejects(f.controller.receive(JSON.stringify({ ...f.challenge, origin: 'https://evil.example' }),
    f.socket, f.controller.generation), /NOT_AUTHORIZED/);
  f.controller.phase = 'proving';
  await assert.rejects(f.controller.receive(JSON.stringify({ type: 'authenticated', ...binding,
    connection_id: 'other', ...f.record.identity, protected_origins: [] }),
  f.socket, f.controller.generation), /NOT_AUTHORIZED/);
  f.controller.dispose();
});

test('rules precede privileged attachment and signed approval; commands need ACK', async () => {
  const f = await fixture();
  const { grant, request } = await approve(f, 'client-1', 'approval-1', false);
  assert.deepEqual(f.calls.map(call => call[0]).slice(0, 3), ['create', 'protect', 'attach']);
  const approval = f.socket.sent.find(message => message.type === 'grant.approve');
  assert.equal(await verify(f.record.public_key, grantPayload({
    ...request, origin, target_id: grant.target_id, capabilities: approval.capabilities,
  }), approval.signature), true);
  f.controller.enqueue(command(grant));
  await flush();
  assert.equal(f.calls.some(call => call[0] === 'execute'), false);
  assert.equal(f.socket.sent.at(-1).error.code, 'APPROVAL_REQUIRED');
  f.controller.dispose();
});

test('failed protection never signs/activates a grant', async () => {
  const f = await fixture();
  f.adapter.protect = async () => { throw new Error('PROTECTION_UNAVAILABLE'); };
  await pending(f);
  await assert.rejects(f.controller.approve('approval-1', ['get_text']), /PROTECTION_UNAVAILABLE/);
  assert.equal(f.controller.grants.size, 0);
  assert.equal(f.socket.sent.some(message => message.type === 'grant.approve'), false);
  assert.equal(f.calls.some(call => call[0] === 'attach'), false);
  f.controller.dispose();
});

test('two clients remain isolated; no method or target fallback exists', async () => {
  const f = await fixture();
  const { grant: first } = await approve(f);
  const { grant: second } = await approve(f, 'client-2', 'approval-2');
  assert.notEqual(first.tabId, second.tabId);
  for (const extra of [
    { target_id: second.target_id }, { client_id: 'client-2' },
    { args: { target_id: second.target_id } }, { operation: 'forwardCDPCommand' },
    { epoch: 'old' }, { connection_id: 'old' },
  ]) f.controller.enqueue(command(first, extra));
  await flush();
  assert.equal(f.calls.some(call => call[0] === 'execute'), false);
  f.controller.enqueue(command(first));
  await flush();
  assert.deepEqual(f.calls.find(call => call[0] === 'execute'), ['execute', first.tabId, 'get_text']);
  f.controller.dispose();
});

test('local approval binds a stable public client ID, not an assumed client registration owner', async () => {
  const f = await fixture();
  const request = await pending(f, 'client-from-another-owner', 'cross-owner');
  await f.controller.approve(request.request_id, ['get_text']);
  const grant = [...f.controller.grants.values()][0];
  assert.equal(grant.client_id, 'client-from-another-owner');
  assert.equal(f.controller.record.identity.owner_id, 'owner-1');
  const approval = f.socket.sent.find(message => message.type === 'grant.approve');
  assert.equal(approval.client_id, request.client_id);
  assert.equal(await verify(f.record.public_key, grantPayload({
    ...request, origin, target_id: grant.target_id, capabilities: ['get_text'],
  }), approval.signature), true);
  f.controller.dispose();
});

test('pause disables authority synchronously, keeps tab and fresh request generates a new target', async () => {
  const f = await fixture();
  const { grant } = await approve(f);
  const ending = f.controller.end(grant.target_id, 'OWNER_PAUSED');
  assert.equal(f.controller.grants.size, 0);
  f.controller.enqueue(command(grant));
  await ending;
  assert.equal(f.controller.inventory.length, 1);
  assert.equal(f.socket.sent.find(message => message.type === 'grant.end').reason, 'OWNER_PAUSED');
  f.controller.resume(grant.client_id);
  assert.equal(f.socket.sent.at(-1).type, 'access.request');
  assert.equal(f.controller.grants.size, 0);
  const { grant: fresh } = await approve(f, 'client-1', 'fresh');
  assert.notEqual(fresh.target_id, grant.target_id);
  f.controller.dispose();
});

test('missing heartbeat, disconnect and old socket close cannot carry grants into reconnect', async () => {
  const f = await fixture();
  await approve(f);
  f.advance(LIVENESS_MS);
  f.controller.tick();
  assert.equal(f.controller.grants.size, 0);
  assert.equal(f.controller.pending.size, 0);
  assert.equal(f.controller.connection, null);
  f.controller.connect();
  const freshSocket = f.controller.socket;
  f.socket.onclose();
  assert.equal(f.controller.socket, freshSocket);
  assert.equal(f.controller.grants.size, 0);
  assert.equal(f.controller.record.identity.device_id, 'device-1');
  f.controller.dispose();
});

test('queues are serialized, bounded and reject stale-document work without retry', async () => {
  const f = await fixture();
  const { grant } = await approve(f);
  let release;
  f.adapter.execute = async (local, operation, args, check) => {
    check();
    f.calls.push(['execute', local.tabId]);
    await new Promise(resolve => { release = resolve; });
    return { text: 'page' };
  };
  f.controller.enqueue(command(grant));
  await flush();
  for (let i = 0; i < 17; i++) f.controller.enqueue(command(grant));
  assert.equal(grant.queue.length, 16);
  assert.equal(f.socket.sent.at(-1).error.code, 'QUEUE_FULL');
  f.controller.tabEvent(grant.tabId, 'navigation', 'https://ordinary.example/');
  release();
  await flush();
  assert.equal(f.calls.filter(call => call[0] === 'execute').length, 1);
  assert.equal(f.socket.sent.at(-1).error.code, 'TARGET_STALE');
  f.controller.dispose();
});

test('protected navigation requires handoff, and remote lists cannot remove pinned origins', async () => {
  const f = await fixture();
  const { grant } = await approve(f);
  f.controller.enqueue(command(grant, { operation: 'navigate', args: { url: `${origin}/dashboard` } }));
  await flush();
  assert.equal(f.controller.grants.size, 0);
  assert.equal(f.socket.sent.find(message => message.type === 'result').error.code, 'HANDOFF_REQUIRED');
  const request = await pending(f, 'client-1', 'next');
  request.protected_origins = [];
  await f.controller.receive(JSON.stringify({ ...request, request_id: 'next-2' }),
    f.socket, f.controller.generation);
  assert.ok(f.controller.protectedOrigins().includes('https://idp.example'));
  f.controller.dispose();
});

test('restart reads persistent identity but never grants or pending decisions', async () => {
  const f = await fixture();
  await approve(f);
  assert.equal('grants' in f.saved, false);
  assert.equal('pending' in f.saved, false);
  assert.equal(JSON.stringify(f.controller.snapshot()).includes('privateKey'), false);
  f.controller.dispose();
});

test('disconnect while a protection install is pending cannot later attach or sign approval', async () => {
  const f = await fixture();
  let unblock;
  f.adapter.protect = async () => new Promise(resolve => { unblock = resolve; });
  await pending(f);
  const approval = f.controller.approve('approval-1', ['get_text']);
  await flush();
  await f.controller.disconnect();
  unblock();
  await assert.rejects(approval, /APPROVAL_REQUIRED/);
  assert.equal(f.controller.grants.size, 0);
  assert.equal(f.calls.some(call => call[0] === 'attach'), false);
  assert.equal(f.socket.sent.some(message => message.type === 'grant.approve'), false);
  assert.equal(f.controller.busyTabs.size, 0);
  f.controller.dispose();
});

test('a newly protected remote origin ends old grants rather than retaining incomplete filters', async () => {
  const f = await fixture();
  await approve(f);
  const request = { type: 'approval.request', ...binding, request_id: 'new-protection',
    client_id: 'client-2', client_label: 'client-2', policy_id: 'page-control-v1',
    nonce: 'nonce-new', expires_at: f.controller.now() + 60_000,
    protected_origins: ['https://new-idp.example'] };
  await f.controller.receive(JSON.stringify(request), f.socket, f.controller.generation);
  assert.equal(f.controller.grants.size, 0);
  assert.ok(f.controller.protectedOrigins().includes('https://new-idp.example'));
  assert.ok(f.controller.protectedOrigins().includes('https://idp.example'));
  assert.equal(f.calls.some(call => call[0] === 'release'), true);
  f.controller.dispose();
});

test('no new command starts after liveness expires, even before the timer runs', async () => {
  const f = await fixture();
  const { grant } = await approve(f);
  f.advance(LIVENESS_MS);
  f.controller.enqueue(command(grant));
  await flush();
  assert.equal(f.calls.some(call => call[0] === 'execute'), false);
  f.controller.tick();
  assert.equal(f.controller.grants.size, 0);
  f.controller.dispose();
});

test('server expiry is checked at arrival and again after asynchronous inspection before execution', async () => {
  const f = await fixture();
  const { grant } = await approve(f);
  f.controller.enqueue(command(grant, { expires_at: f.controller.now() }));
  await flush();
  assert.equal(f.calls.some(call => call[0] === 'execute'), false);
  assert.equal(f.socket.sent.at(-1).error.code, 'OUTCOME_UNKNOWN');
  let inspectDone;
  f.adapter.execute = async (local, operation, args, check) => {
    await new Promise(resolve => { inspectDone = resolve; });
    check();
    f.calls.push(['executed_after_inspection', local.tabId]);
    return {};
  };
  f.controller.enqueue(command(grant, { expires_at: f.controller.now() + 10 }));
  await flush();
  f.advance(11);
  inspectDone();
  await flush();
  assert.equal(f.calls.some(call => call[0] === 'executed_after_inspection'), false);
  assert.equal(f.socket.sent.findLast(message => message.type === 'result').error.code, 'OUTCOME_UNKNOWN');
  f.controller.dispose();
});

test('a command expiring behind an earlier serialized operation never starts', async () => {
  const f = await fixture();
  const { grant } = await approve(f);
  let completeFirst;
  const started = [];
  f.adapter.execute = async (local, operation, args, check) => {
    check();
    started.push(args.selector);
    await new Promise(resolve => { completeFirst = resolve; });
    return { text: 'first result' };
  };
  const first = command(grant, { args: { selector: '#first' }, expires_at: f.controller.now() + 1000 });
  const second = command(grant, { args: { selector: '#second' }, expires_at: f.controller.now() + 50 });
  f.controller.enqueue(first);
  f.controller.enqueue(second);
  await flush();
  assert.deepEqual(started, ['#first']);
  f.advance(100);
  completeFirst();
  await flush();
  assert.deepEqual(started, ['#first']);
  const result = f.socket.sent.find(message => message.type === 'result' && message.request_id === second.request_id);
  assert.equal(result.error.code, 'OUTCOME_UNKNOWN');
  assert.equal(f.controller.grants.size, 0);
  f.controller.dispose();
});

test('server COMMAND_EXPIRED is reported and invalidates all local command authority', async () => {
  const f = await fixture();
  await approve(f);
  f.socket.onmessage({ data: JSON.stringify({ type: 'error', code: 'COMMAND_EXPIRED' }) });
  await flush();
  assert.ok(f.controller.failures.includes('COMMAND_EXPIRED'));
  assert.equal(f.controller.grants.size, 0);
  assert.equal(f.controller.connection, null);
  assert.equal(f.socket.readyState, 3);
  f.controller.dispose();
});

test('a late ping after background suspension cannot resurrect a stale grant', async () => {
  const f = await fixture();
  await approve(f);
  f.advance(LIVENESS_MS + 1);
  await assert.rejects(f.controller.receive(JSON.stringify({ type: 'ping' }),
    f.socket, f.controller.generation), /BROWSER_OFFLINE/);
  assert.equal(f.controller.grants.size, 0);
  assert.equal(f.controller.connection, null);
  f.controller.dispose();
});

test('an expired ACK cannot activate a grant before the timer sweep', async () => {
  const f = await fixture();
  const { grant } = await approve(f, 'client-1', 'approval-1', false);
  f.advance(10_001);
  await assert.rejects(f.controller.receive(JSON.stringify({ type: 'grant.active',
    target_id: grant.target_id, client_id: grant.client_id }),
  f.socket, f.controller.generation), /APPROVAL_REQUIRED/);
  assert.equal(f.controller.grants.size, 0);
  f.controller.dispose();
});

test('browser restart ignores local tab ID inventory; only session-store provenance is trusted', async () => {
  const f = await fixture();
  const localStorage = {
    async get() {
      return { config: { ...f.controller.config, enabled: false },
        dedicatedTabs: [{ tabId: 1, client_id: 'client-1' }] };
    },
    async set() {},
  };
  const restarted = new Controller({
    adapter: f.adapter, keys: { async get() { return f.record; } }, storage: localStorage,
    inventoryStorage: { async get() { return {}; }, async set() {} },
    extensionUrl, Socket,
  });
  await restarted.initialize();
  assert.equal(restarted.inventory.length, 0);
  assert.equal(restarted.grants.size, 0);
  restarted.dispose();
  f.controller.dispose();
});

test('server-requested human handoff ends authority and explicitly notifies the owner', async () => {
  const f = await fixture();
  const notifications = [];
  f.controller.notify = (...args) => notifications.push(args);
  const { grant } = await approve(f);
  await f.controller.receive(JSON.stringify({ type: 'grant.end', target_id: grant.target_id, reason: 'HANDOFF' }),
    f.socket, f.controller.generation);
  assert.equal(f.controller.grants.size, 0);
  assert.match(notifications.at(-1)[1], /Prior\/scheduled JavaScript is not undone/);
  f.controller.dispose();
});

test('service timeout/offline/replacement reasons tear down grants without emitting an invalid local end', async () => {
  for (const reason of ['OUTCOME_UNKNOWN', 'BROWSER_OFFLINE', 'REPLACED']) {
    const f = await fixture();
    const { grant } = await approve(f);
    await f.controller.receive(JSON.stringify({ type: 'grant.end', target_id: grant.target_id, reason }),
      f.socket, f.controller.generation);
    assert.equal(f.controller.grants.size, 0);
    assert.equal(f.socket.sent.some(message => message.type === 'grant.end'), false);
    f.controller.dispose();
  }
});

test('closing a dedicated tab uses the agreed TARGET_CLOSED reason and removes its session provenance', async () => {
  const f = await fixture();
  const { grant } = await approve(f);
  f.controller.tabEvent(grant.tabId, 'closed');
  await flush();
  assert.equal(f.controller.inventory.length, 0);
  assert.equal(f.socket.sent.find(message => message.type === 'grant.end').reason, 'TARGET_CLOSED');
  f.controller.dispose();
});

test('uninspectable documents end authority and queued work instead of leaving an active wedged target', async () => {
  const f = await fixture();
  const { grant } = await approve(f);
  const first = command(grant);
  const queued = command(grant);
  f.adapter.execute = async () => { throw new Error('PAGE_UNAVAILABLE'); };
  f.controller.enqueue(first);
  f.controller.enqueue(queued);
  await flush();
  assert.equal(f.socket.sent.find(message => message.request_id === first.request_id).error.code, 'PAGE_UNAVAILABLE');
  assert.equal(f.socket.sent.find(message => message.request_id === queued.request_id).error.code, 'APPROVAL_REQUIRED');
  assert.equal(f.socket.sent.find(message => message.type === 'grant.end').reason, 'CAPABILITY_UNAVAILABLE');
  assert.equal(f.controller.grants.size, 0);
  assert.equal(f.controller.snapshot().targets[0].state, 'inactive');
  assert.equal(f.controller.inventory[0].tabId, grant.tabId);
  assert.deepEqual(f.calls.at(-1), ['release', grant.tabId]);
  assert.equal(f.controller.connection.connection_id, binding.connection_id);
  f.controller.dispose();
});

test('optional-operation capability failures do not end otherwise inspectable grants', async () => {
  const f = await fixture();
  const { grant } = await approve(f);
  f.adapter.execute = async () => { throw new Error('CAPABILITY_UNAVAILABLE'); };
  f.controller.enqueue(command(grant));
  await flush();
  assert.equal(f.socket.sent.at(-1).error.code, 'CAPABILITY_UNAVAILABLE');
  assert.equal(f.controller.grants.size, 1);
  assert.equal(f.controller.snapshot().targets[0].state, 'active');
  f.controller.dispose();
});

test('completed submit clicks acknowledge the action without authorizing queued work for the new document', async () => {
  const f = await fixture();
  await pending(f);
  await f.controller.approve('approval-1', ['navigate', 'get_text', 'click']);
  const grant = [...f.controller.grants.values()][0];
  await f.controller.receive(JSON.stringify({
    type: 'grant.active', target_id: grant.target_id, client_id: grant.client_id,
  }), f.socket, f.controller.generation);
  let completeClick;
  f.adapter.execute = async (local, operation, args, check) => {
    check();
    f.calls.push(['execute', operation]);
    await new Promise(resolve => { completeClick = resolve; });
    f.controller.tabEvent(local.tabId, 'navigation', 'https://ordinary.example/submitted');
    return { clicked: true };
  };
  const click = command(grant, { operation: 'click', args: { selector: 'button' } });
  const queued = command(grant);
  f.controller.enqueue(click);
  f.controller.enqueue(queued);
  completeClick();
  await flush();
  assert.deepEqual(f.socket.sent.find(message => message.request_id === click.request_id).result, { clicked: true });
  assert.equal(f.socket.sent.find(message => message.request_id === queued.request_id).error.code, 'TARGET_STALE');
  assert.deepEqual(f.calls.filter(call => call[0] === 'execute'), [['execute', 'click']]);
  assert.equal(f.controller.grants.size, 1);
  f.controller.dispose();
});
