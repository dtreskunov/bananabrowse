import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { tools, callTool } from '../mcp.js';
import { Store, hash, token } from '../store.js';
import { authPayload, sign, validDescription, workspacePayload, OPERATIONS } from '../../shared/protocol.js';
import { fixture, appFixture, keys, bind, tab, flush, capture, responseMessage, post,
  ORIGIN, EXTENSION, DESCRIPTION } from './helpers.js';

test('v5 catalogue has exactly 21 scoped tools, Unicode policy and no old approval schema', () => {
  assert.equal(tools.length, 21);
  assert.equal(new Set(tools.map(t => t.name)).size, 21);
  for (const name of OPERATIONS) {
    const t = tools.find(t => t.name === name);
    assert(!Object.hasOwn(t.inputSchema.properties, 'wait_timeout_seconds'));
    assert(t.inputSchema.required.includes('description'));
    assert(t.inputSchema.required.includes('target_id'));
    assert.equal(t.inputSchema.additionalProperties, false);
  }
  assert(!tools.some(t => ['list_browser_targets','request_browser_access'].includes(t.name)));
  assert(tools.find(t => t.name === 'request_handoff').inputSchema.properties.wait_timeout_seconds);
  for (const char of ['a','界','😀']) {
    assert(!validDescription(char.repeat(39))); assert(validDescription(char.repeat(40)));
    assert(validDescription(char.repeat(500))); assert(!validDescription(char.repeat(501)));
    assert(validDescription(` ${char.repeat(498)} `)); assert(!validDescription(` ${char.repeat(499)} `));
    assert(!validDescription(` ${char.repeat(39)} `));
  }
});

test('HTTP MCP credentials, exact tenant endpoint, Origin and public metadata remain isolated', async () => {
  const f = await appFixture();
  try {
    const a = f.store.createClient('A'), b = f.store.createClient('B');
    const metadata = await (await fetch(`${f.base}/.well-known/domagent`)).json();
    assert.equal(metadata.protocol_version, 5); assert.equal(metadata.version, '5.0.0-beta.2');
    const health = await (await fetch(`${f.base}/health`)).json();
    assert.deepEqual(health, { service: 'domagent', status: 'ok', version: '5.0.0-beta.2', protocol_version: 5 });
    assert(!JSON.stringify(metadata).includes('oidc'));
    const request = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    for (const [credential, tenant, extra] of [
      [a.credential,b.tenant_id,{}], ['x'.repeat(43),a.tenant_id,{}],
      [a.credential,a.tenant_id,{ Origin: 'https://attacker.test' }],
    ]) {
      const response = await post(f.base, `/mcp/${tenant}`, request,
        { Authorization: `Bearer ${credential}`, Accept: 'application/json, text/event-stream', ...extra });
      assert([401,403].includes(response.status)); assert.equal((await response.json()).error, 'NOT_AUTHORIZED');
    }
    const response = await post(f.base, `/mcp/${a.tenant_id}`, request,
      { Authorization: `Bearer ${a.credential}`, Accept: 'application/json, text/event-stream' });
    assert.equal(response.status, 200); assert.equal((await response.json()).result.tools.length, 21);
    const initialized = await post(f.base, `/mcp/${a.tenant_id}`,
      { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-03-26',
        capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
      { Authorization: `Bearer ${a.credential}`, Accept: 'application/json, text/event-stream' });
    assert.equal((await initialized.json()).result.serverInfo.version, '5.0.0-beta.2');
    assert.equal((await fetch(`${f.base}/mcp/${a.tenant_id}`)).status, 405);
    assert.equal((await post(f.base, '/api/setup-requests', { agent_name: 'A' })).status, 404);
  } finally { await f.close(); }
});

test('real WSS rejects wire4, wrong Origin and replayed proof; v5 returns only client binding', async () => {
  const f = await appFixture();
  try {
    const created = f.store.createClient('Atlas'), client = f.store.client(created.id);
    const key = await keys(), device = bind(f.store, client, key);
    const connect = async () => {
      const ws = new WebSocket(`${f.base.replace('http:', 'ws:')}/extension/${client.tenant_id}`, { origin: EXTENSION });
      const queue = [], waiting = [];
      ws.on('message', data => { const m = JSON.parse(data); if (waiting.length) waiting.shift()(m); else queue.push(m); });
      const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => waiting.push(resolve));
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      return { ws, next, send: value => ws.send(JSON.stringify({ tenant_id: client.tenant_id, ...value })) };
    };
    let c = await connect();
    c.send({ type: 'hello', version: 4, key_id: key.key_id });
    assert.equal((await c.next()).code, 'UPGRADE_REQUIRED'); c.ws.terminate();
    c = await connect();
    c.send({ type: 'hello', version: 5, key_id: key.key_id });
    const challenge = await c.next(), signature = await sign(key.key, authPayload(challenge));
    c.send({ type: 'proof', signature });
    const authenticated = await c.next();
    assert.equal(authenticated.device_id, device.device_id); assert.equal(authenticated.client_id, client.id);
    assert(!Object.hasOwn(authenticated, 'owner_id')); assert(!Object.hasOwn(authenticated, 'eligible_clients'));
    c.send({ type: 'proof', signature }); assert.equal((await c.next()).code, 'INVALID_MESSAGE'); c.ws.terminate();
    const wrong = new WebSocket(`${f.base.replace('http:', 'ws:')}/extension/${client.tenant_id}`, { origin: 'https://attacker.test' });
    assert.match(await new Promise(resolve => wrong.once('error', error => resolve(error.message))), /403/);
  } finally { await f.close(); }
});

test('signed active snapshots expose only this client tabs; foreign handles are generic', async () => {
  const f = await fixture();
  try {
    const other = f.store.createClient('Other');
    assert.equal(f.authenticated.client_id, f.client.id);
    assert.equal(f.bridge.listWorkspaces(f.client.id, f.client.tenant_id)[0].workspaces[0].tab_count, 1);
    assert.equal(f.bridge.listTabs(f.client.id, f.workspace.workspace_id, f.client.tenant_id)[0].title, 'Tab 1');
    assert.throws(() => f.bridge.listTabs(other.id, f.workspace.workspace_id, other.tenant_id), /NOT_AUTHORIZED/);
    const result = await callTool('get_text', { target_id: f.workspace.tabs[0].target_id, description: DESCRIPTION },
      f.store.client(other.id), f.bridge);
    assert.equal(JSON.parse(result.content[0].text).error, 'NOT_AUTHORIZED');
    assert.equal(f.ws.sent.at(-1).type, 'workspace.active');
    assert.equal(f.bridge.listWorkspaces(f.client.id, f.client.tenant_id)[0].browser_info.browser_version, '150.0');
  } finally { f.close(); }
});

test('workspace revisions, signatures, generation, tab uniqueness and target rebinding fail closed', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.sync(), /TARGET_STALE/);
    const snapshot = { ...f.workspace, revision: 2, tabs: f.workspace.tabs };
    snapshot.signature = await sign(f.key.key, workspacePayload({ ...snapshot, origin: ORIGIN,
      epoch: f.bridge.epoch, connection_id: randomUUID() }));
    await assert.rejects(f.bridge.message(f.session, snapshot), /NOT_AUTHORIZED/);
    const original = f.workspace.tabs[0];
    await assert.rejects(f.sync({ revision: 2, tabs: [original,{ ...tab(2), target_id: original.target_id }] }), /INVALID_WORKSPACE/);
    await assert.rejects(f.sync({ revision: 2, tabs: [original,tab(1)] }), /INVALID_WORKSPACE/);
    await assert.rejects(f.sync({ revision: 2, tabs: [{ ...original, tab_id: 99 }] }), /TARGET_STALE/);
    await assert.rejects(f.sync({ revision: 2, tabs: [{ ...original, capabilities: ['not_a_tool'] }] }), /INVALID_WORKSPACE/);
    await assert.rejects(f.sync({ revision: 2, tabs: [{ ...original, url: ORIGIN }] }), /NOT_AUTHORIZED/);
    await assert.rejects(f.sync({ revision: 2, group_id: 2, tabs: [original] }), /INVALID_WORKSPACE/);
    assert.equal(f.bridge.listTabs(f.client.id, f.workspace.workspace_id, f.client.tenant_id).length, 1);
  } finally { f.close(); }
});

test('lease expires at exactly five seconds; stale renewal cannot revive, fresh activation/handles can', async () => {
  const f = await fixture();
  try {
    f.clock.value += 4999; f.bridge.sweep();
    assert.equal(f.bridge.listTabs(f.client.id, f.workspace.workspace_id, f.client.tenant_id).length, 1);
    f.clock.value += 1; f.bridge.sweep();
    assert.equal(f.bridge.listTabs(f.client.id, f.workspace.workspace_id, f.client.tenant_id).length, 0);
    await assert.rejects(f.sync({ revision: 2 }), /WORKSPACE_INACTIVE/);
    await assert.rejects(f.sync({ revision: 3, activation_id: randomUUID() }), /TARGET_STALE/);
    await f.sync({ revision: 4, activation_id: randomUUID(), tabs: [tab(1)] });
    assert.equal(f.bridge.listTabs(f.client.id, f.workspace.workspace_id, f.client.tenant_id).length, 1);
    await assert.rejects(f.sync({ revision: 5, lease_ms: 5001 }), /INVALID_WORKSPACE/);
  } finally { f.close(); }
});

test('Pause/End/removal tombstones are caller scoped, immediate and cannot rebind retired handles', async () => {
  const f = await fixture();
  try {
    const old = f.workspace.tabs[0], foreign = f.store.createClient('Foreign');
    await f.sync({ revision: 2, state: 'paused', tabs: [] });
    assert.equal(f.bridge.listTabs(f.client.id, f.workspace.workspace_id, f.client.tenant_id).length, 0);
    await assert.rejects(f.bridge.operate(f.client.id, old.target_id, 'get_text', {}, undefined,
      f.client.tenant_id, DESCRIPTION), /WORKSPACE_PAUSED/);
    await assert.rejects(f.bridge.operate(foreign.id, old.target_id, 'get_text', {}, undefined,
      foreign.tenant_id, DESCRIPTION), /NOT_AUTHORIZED/);
    await assert.rejects(f.sync({ revision: 3, state: 'active', tabs: [tab(1)] }), /WORKSPACE_INACTIVE/);
    await f.sync({ revision: 4, activation_id: randomUUID(), state: 'active', tabs: [tab(1)] });
    const current = f.workspace.tabs[0];
    await f.sync({ revision: 5, tabs: [] });
    await assert.rejects(f.bridge.operate(f.client.id, current.target_id, 'get_text', {}, undefined,
      f.client.tenant_id, DESCRIPTION), /TAB_NOT_IN_WORKSPACE/);
    f.bridge.tombstones.clear();
    await assert.rejects(f.sync({ revision: 6, tabs: [current] }), /TARGET_STALE/);
    await f.sync({ revision: 7, state: 'inactive', tabs: [] });
    assert.equal(f.bridge.listWorkspaces(f.client.id, f.client.tenant_id)[0].workspaces[0].state, 'inactive');
  } finally { f.close(); }
});

test('ordinary command ready/execute is fresh and checks pause/cancellation before any execution', async () => {
  const f = await fixture();
  try {
    const id = f.workspace.tabs[0].target_id;
    const action = capture(f.bridge.operate(f.client.id, id, 'get_text', {}, undefined, f.client.tenant_id, DESCRIPTION));
    await flush();
    const command = f.ws.sent.find(m => m.type === 'command');
    assert.equal(command.workspace_id, f.workspace.workspace_id); assert.equal(command.activation_id, f.workspace.activation_id);
    assert(command.wait_timeout_ms <= 25_000); assert.equal(command.description, DESCRIPTION);
    f.clock.value += 1000;
    await responseMessage(f, command, 'command.ready');
    const execute = f.ws.sent.at(-1);
    assert.equal(execute.type, 'command.execute'); assert.equal(execute.expires_at, f.now() + 25_000);
    await responseMessage(f, command, 'command.ready');
    assert.equal(f.ws.sent.filter(m => m.type === 'command.execute').length, 1);
    await responseMessage(f, command, 'result', { result: { text: 'safe' } });
    assert.equal((await action).value.text, 'safe');
    const next = capture(f.bridge.operate(f.client.id, id, 'get_text', {}, undefined, f.client.tenant_id, DESCRIPTION));
    await flush(); const second = f.ws.sent.filter(m => m.type === 'command').at(-1);
    await f.sync({ revision: 2, state: 'paused', tabs: [] });
    assert.equal((await next).error.code, 'WORKSPACE_PAUSED');
    await responseMessage(f, second, 'command.ready');
    assert.equal(f.ws.sent.filter(m => m.type === 'command.execute').length, 1);
  } finally { f.close(); }
});

test('per-tab tails do not overtake after queued cancellation; workspace concurrency is two', async () => {
  const f = await fixture();
  try {
    await f.sync({ revision: 2, tabs: [f.workspace.tabs[0],tab(2),tab(3)] });
    const ids = f.workspace.tabs.map(t => t.target_id), cancel = new AbortController();
    const first = capture(f.bridge.operate(f.client.id, ids[0], 'get_text', {}, undefined, f.client.tenant_id, DESCRIPTION));
    const skipped = capture(f.bridge.operate(f.client.id, ids[0], 'get_text', {}, cancel.signal, f.client.tenant_id, DESCRIPTION));
    const third = capture(f.bridge.operate(f.client.id, ids[0], 'get_text', {}, undefined, f.client.tenant_id, DESCRIPTION));
    cancel.abort(); assert.equal((await skipped).error.code, 'COMMAND_CANCELLED'); await flush();
    assert.equal(f.ws.sent.filter(m => m.type === 'command').length, 1);
    const parallel = capture(f.bridge.operate(f.client.id, ids[1], 'get_text', {}, undefined, f.client.tenant_id, DESCRIPTION));
    const extra = capture(f.bridge.operate(f.client.id, ids[2], 'get_text', {}, undefined, f.client.tenant_id, DESCRIPTION));
    await flush(); assert.equal(f.ws.sent.filter(m => m.type === 'command').length, 2);
    const commands = f.ws.sent.filter(m => m.type === 'command');
    for (const c of commands) await responseMessage(f, c, 'command.ready');
    await responseMessage(f, commands[1], 'result', { result: { text: 'parallel' } });
    assert.equal((await parallel).value.text, 'parallel'); await flush();
    assert.equal(f.ws.sent.filter(m => m.type === 'command').length, 3);
    await responseMessage(f, commands[0], 'result', { result: { text: 'first' } });
    assert.equal((await first).value.text, 'first'); await flush();
    assert.equal(f.ws.sent.filter(m => m.type === 'command').length, 4);
    await f.sync({ revision: 3, state: 'inactive', tabs: [] });
    assert.equal((await third).error.code, 'WORKSPACE_INACTIVE');
    assert.equal((await extra).error.code, 'WORKSPACE_INACTIVE');
  } finally { f.close(); }
});

test('removed target immediately cancels queued slot work; executing cancellation stays uncertain', async () => {
  const f = await fixture();
  try {
    await f.sync({ revision: 2, tabs: [f.workspace.tabs[0],tab(2),tab(3)] });
    const pending = f.workspace.tabs.map(t => capture(f.bridge.operate(f.client.id, t.target_id,
      'get_text', {}, undefined, f.client.tenant_id, DESCRIPTION)));
    await flush(); const commands = f.ws.sent.filter(m => m.type === 'command');
    await responseMessage(f, commands[0], 'command.ready');
    await f.sync({ revision: 3, tabs: [f.workspace.tabs[1]] });
    assert.equal((await pending[0]).error.code, 'OUTCOME_UNKNOWN');
    assert.equal((await pending[2]).error.code, 'TAB_NOT_IN_WORKSPACE');
    assert.equal(f.ws.sent.filter(m => m.type === 'command').length, 2);
    await f.sync({ revision: 4, state: 'inactive', tabs: [] }); await pending[1];
  } finally { f.close(); }
});

test('handoff does not consume workspace execution capacity and notification failure is explicit', async () => {
  const f = await fixture();
  try {
    await f.sync({ revision: 2, tabs: [f.workspace.tabs[0],tab(2),tab(3)] });
    const ids = f.workspace.tabs.map(t => t.target_id);
    const handoff = capture(f.bridge.operate(f.client.id, ids[0], 'request_handoff', {}, undefined,
      f.client.tenant_id, DESCRIPTION, 60_000));
    const others = ids.slice(1).map(id => capture(f.bridge.operate(f.client.id, id, 'get_text', {}, undefined,
      f.client.tenant_id, DESCRIPTION)));
    await flush(); const commands = f.ws.sent.filter(m => m.type === 'command');
    assert.equal(commands.length, 3);
    for (const c of commands) await responseMessage(f, c, 'command.ready');
    assert.equal(f.bridge.listTabs(f.client.id, f.workspace.workspace_id, f.client.tenant_id)[0].execution_state, 'waiting_for_human');
    const c = commands.find(c => c.operation === 'request_handoff');
    assert.equal(f.ws.sent.find(m => m.type === 'command.execute' && m.request_id === c.request_id).execution_timeout_ms, 60_000);
    await responseMessage(f, c, 'result', { error: { code: 'NOTIFICATION_UNAVAILABLE', message: 'secret raw exception' } });
    assert.equal((await handoff).error.code, 'NOTIFICATION_UNAVAILABLE');
    for (const p of commands.filter(c => c.operation === 'get_text')) await responseMessage(f, p, 'result', { result: { text: 'ok' } });
    assert((await Promise.all(others)).every(r => r.value.text === 'ok'));
    assert.equal(f.bridge.listTabs(f.client.id, f.workspace.workspace_id, f.client.tenant_id).length, 3);
  } finally { f.close(); }
});

test('navigation-only privileged/refused documents never receive DOM authority or new URL allowlists', async () => {
  const f = await fixture();
  try {
    const original = f.workspace.tabs[0];
    await f.sync({ revision: 2, tabs: [{ ...original, url: 'about:blank', page_state: 'navigation_only', capabilities: ['navigate'] }] });
    await assert.rejects(f.bridge.operate(f.client.id, original.target_id, 'get_text', {}, undefined,
      f.client.tenant_id, DESCRIPTION), /DOCUMENT_NOT_CONTROLLABLE/);
    await assert.rejects(f.bridge.operate(f.client.id, original.target_id, 'navigate', { url: ORIGIN }, undefined,
      f.client.tenant_id, DESCRIPTION), /HANDOFF_REQUIRED/);
    await assert.rejects(f.bridge.operate(f.client.id, original.target_id, 'navigate', { url: 'chrome://settings/' }, undefined,
      f.client.tenant_id, DESCRIPTION), /HANDOFF_REQUIRED/);
    const action = capture(f.bridge.operate(f.client.id, original.target_id, 'navigate', { url: 'https://any-ordinary-site.test/' },
      undefined, f.client.tenant_id, DESCRIPTION));
    await flush(); const command = f.ws.sent.filter(m => m.type === 'command').at(-1);
    await responseMessage(f, command, 'command.ready');
    await responseMessage(f, command, 'result', { result: { navigation_started: true } });
    assert.equal((await action).value.navigation_started, true);
    await f.sync({ revision: 3, tabs: [{ ...original, url: 'https://page.test/', page_state: 'unavailable', capabilities: ['navigate'] }] });
    assert.equal(f.bridge.listTabs(f.client.id, f.workspace.workspace_id, f.client.tenant_id)[0].target_id, original.target_id);
    await f.sync({ revision: 4, tabs: [original] });
    const fail = capture(f.bridge.operate(f.client.id, original.target_id, 'get_text', {}, undefined, f.client.tenant_id, DESCRIPTION));
    await flush(); const c = f.ws.sent.filter(m => m.type === 'command').at(-1);
    await responseMessage(f, c, 'command.ready');
    await responseMessage(f, c, 'result', { error: { code: 'DOCUMENT_NOT_CONTROLLABLE' } });
    assert.equal((await fail).error.code, 'DOCUMENT_NOT_CONTROLLABLE');
    assert.equal(f.bridge.listTabs(f.client.id, f.workspace.workspace_id, f.client.tenant_id).length, 1);
  } finally { f.close(); }
});

test('create reserves eight-tab capacity, shares handshake and returns only signed fresh targets', async () => {
  const f = await fixture();
  try {
    await f.sync({ revision: 2, tabs: [f.workspace.tabs[0], ...Array.from({ length: 6 }, (_, i) => tab(i + 2))] });
    const pending = capture(f.bridge.createTab(f.client.id, f.workspace.workspace_id, {}, DESCRIPTION, undefined, f.client.tenant_id));
    await assert.rejects(f.bridge.createTab(f.client.id, f.workspace.workspace_id, {}, DESCRIPTION, undefined, f.client.tenant_id), /TAB_LIMIT_REACHED/);
    await flush(); const command = f.ws.sent.find(m => m.type === 'command');
    assert.equal(command.target_id, f.workspace.workspace_id); assert.equal(command.operation, 'create_workspace_tab');
    await responseMessage(f, command, 'command.ready');
    const fresh = tab(99, { url: 'about:blank', page_state: 'navigation_only', capabilities: ['navigate'] });
    await f.sync({ revision: 3, tabs: [...f.workspace.tabs, fresh] });
    await responseMessage(f, command, 'result', { result: { target_id: fresh.target_id, tab_handle: 'forged', private_field: 'secret' } });
    const receipt = (await pending).value;
    assert.equal(receipt.target_id, fresh.target_id); assert.equal(receipt.tab_handle, fresh.target_id);
    assert(!Object.hasOwn(receipt, 'private_field'));
    await assert.rejects(f.bridge.createTab(f.client.id, f.workspace.workspace_id, {}, DESCRIPTION, undefined, f.client.tenant_id), /TAB_LIMIT_REACHED/);
  } finally { f.close(); }
});

test('create result cannot invent authority, protected destination denied, interrupted create never retried', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.bridge.createTab(f.client.id, f.workspace.workspace_id, { url: ORIGIN },
      DESCRIPTION, undefined, f.client.tenant_id), /HANDOFF_REQUIRED/);
    const control = new AbortController();
    const p = capture(f.bridge.createTab(f.client.id, f.workspace.workspace_id, {}, DESCRIPTION, control.signal, f.client.tenant_id));
    await flush(); const c = f.ws.sent.find(m => m.type === 'command');
    await responseMessage(f, c, 'command.ready');
    await assert.rejects(responseMessage(f, c, 'result', { result: { target_id: randomUUID() } }), /INVALID_RESULT/);
    control.abort(); assert.equal((await p).error.code, 'OUTCOME_UNKNOWN');
    assert.equal(f.ws.sent.filter(m => m.type === 'command').length, 1);
    assert.equal(f.bridge.listTabs(f.client.id, f.workspace.workspace_id, f.client.tenant_id).length, 1);
  } finally { f.close(); }
});

test('passive workspace wait sends no prompt; bounded/cancelled waits grant nothing', async () => {
  const f = await fixture();
  try {
    const immediate = await f.bridge.waitWorkspace(f.client.id, f.device.device_id, DESCRIPTION, 300_000, undefined, f.client.tenant_id);
    assert.equal(immediate.workspace_id, f.workspace.workspace_id);
    await f.sync({ revision: 2, state: 'inactive', tabs: [] });
    const length = f.ws.sent.length, signal = new AbortController();
    const waiting = capture(f.bridge.waitWorkspace(f.client.id, f.device.device_id, DESCRIPTION, 300_000, signal.signal, f.client.tenant_id));
    await flush(); assert.equal(f.ws.sent.length, length);
    signal.abort(); assert.equal((await waiting).error.code, 'COMMAND_CANCELLED');
    assert.equal(f.bridge.targets.size, 0);
    assert.throws(() => f.bridge.waitWorkspace(f.client.id, f.device.device_id, DESCRIPTION, 601_000, undefined, f.client.tenant_id), /INVALID_ARGUMENTS/);
    const next = f.bridge.waitWorkspace(f.client.id, f.device.device_id, DESCRIPTION, 300_000, undefined, f.client.tenant_id);
    await f.sync({ revision: 3, activation_id: randomUUID(), state: 'active', tabs: [tab(1)] });
    assert.equal((await next).state, 'active'); assert.equal(f.bridge.waiters.size, 0);
  } finally { f.close(); }
});

test('MCP runtime preserves output/schema/Unicode/error redaction protections', async () => {
  const f = await fixture();
  try {
    const id = f.workspace.tabs[0].target_id;
    for (const args of [{ description: '😀'.repeat(501) }, { description: 'a'.repeat(39) },
      { description: DESCRIPTION, wait_timeout_seconds: 300 }, { description: DESCRIPTION, ref: 'e1' },
      { description: DESCRIPTION, max_output_bytes: 65_537 }]) {
      const r = await callTool('get_text', { target_id: id, ...args }, f.client, f.bridge);
      assert.equal(JSON.parse(r.content[0].text).error, 'INVALID_ARGUMENTS');
    }
    const promise = callTool('evaluate_script', { target_id: id, description: '😀'.repeat(40), script: 'document.title' }, f.client, f.bridge);
    await flush(); const command = f.ws.sent.filter(m => m.type === 'command').at(-1);
    await responseMessage(f, command, 'command.ready');
    await responseMessage(f, command, 'result', { result: { value: 'x'.repeat(100_000) } });
    assert.equal(JSON.parse((await promise).content[0].text).error, 'RESULT_TOO_LARGE');
    const errorPromise = callTool('get_text', { target_id: id, description: DESCRIPTION }, f.client, f.bridge);
    await flush(); const second = f.ws.sent.filter(m => m.type === 'command').at(-1);
    await responseMessage(f, second, 'command.ready');
    await responseMessage(f, second, 'result', { error: { code: 'PAGE_UNAVAILABLE', message: 'private',
      injection_reason: 'permission_denied', inspection_stage: 'document_injection', url: 'secret' } });
    const error = JSON.parse((await errorPromise).content[0].text);
    assert.deepEqual(error, { error: 'PAGE_UNAVAILABLE', inspection_stage: 'document_injection', injection_reason: 'permission_denied' });
    assert.equal(f.bridge.targets.size, 1);
  } finally { f.close(); }
});

test('rotation/revocation immediately cancels authority and never rescues revoked credentials', async () => {
  const f = await fixture();
  try {
    const control = new AbortController();
    const p = capture(f.bridge.operate(f.client.id, f.workspace.tabs[0].target_id, 'get_text', {},
      control.signal, f.client.tenant_id, DESCRIPTION));
    await flush(); f.store.rotateClient(f.client.id); f.bridge.reconcile();
    assert.equal((await p).error.code, 'REVOKED');
    assert.equal(f.bridge.targets.size, 0);
    assert(!f.store.authenticateClient(f.created.credential, f.client.tenant_id));
    f.store.revoke('client', f.client.id);
    assert.throws(() => f.store.rotateClient(f.client.id), /NOT_AUTHORIZED/);
    assert.equal(f.store.client(f.client.id), undefined);
    f.store.revoke('device', f.device.device_id);
    assert.equal(f.store.device(f.device.device_id), undefined);
    assert.equal(f.store.db.prepare('SELECT revoked FROM devices WHERE id=?').get(f.device.device_id).revoked, 1);
  } finally { f.close(); }
});
