import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { fixture, DESCRIPTION, capture, flush, tab } from './helpers.js';
import { sign, authPayload } from '../../shared/protocol.js';

function reply(f, request, type, fields = {}) {
  return f.bridge.message(f.session, { type, tenant_id: f.client.tenant_id, client_id: f.client.id,
    epoch: f.bridge.epoch, connection_id: f.session.connection_id, request_id: request.request_id, ...fields });
}

test('coalesced access notification cannot override Pause; only a fresh signed local activation resolves waiters', async () => {
  const f = await fixture();
  try {
    await f.sync({ revision: 2, state: 'paused', tabs: [] });
    const a = capture(f.bridge.waitWorkspace(f.client.id, f.device.device_id, DESCRIPTION, 300000, undefined, f.client.tenant_id));
    const b = capture(f.bridge.waitWorkspace(f.client.id, f.device.device_id, DESCRIPTION, 200000, undefined, f.client.tenant_id));
    const requests = f.ws.sent.filter(message => message.type === 'workspace.request');
    assert.equal(requests.length, 1);
    assert.equal(f.bridge.accessRequests.size, 1);
    assert.equal(f.bridge.targets.size, 0);
    assert.equal(f.bridge.workspaces.get(f.workspace.workspace_id).state, 'paused');
    await reply(f, requests[0], 'workspace.request.received', { status: 'created' });
    assert.equal(f.bridge.waiters.size, 2);
    await f.sync({ revision: 3, state: 'active', activation_id: randomUUID(), tabs: [tab(1)] });
    assert.equal((await a).value.state, 'active');
    assert.equal((await b).value.state, 'active');
    assert.equal(f.bridge.accessRequests.size, 0);
    assert.equal(f.ws.sent.at(-1).type, 'workspace.request.cancel');
  } finally { f.close(); }
});

test('decline and notification failure cancel the matching request and cannot grant or expose foreign scope', async () => {
  for (const outcome of ['decline', 'failed']) {
    const f = await fixture();
    try {
      await f.sync({ revision: 2, state: 'inactive', tabs: [] });
      const waiting = capture(f.bridge.waitWorkspace(f.client.id, f.device.device_id, DESCRIPTION, 300000, undefined, f.client.tenant_id));
      const request = f.ws.sent.at(-1);
      await assert.rejects(reply(f, request, 'workspace.request.decline', { client_id: randomUUID() }), /NOT_AUTHORIZED/);
      assert.equal(f.bridge.waiters.size, 1);
      if (outcome === 'decline') await reply(f, request, 'workspace.request.decline');
      else await reply(f, request, 'workspace.request.received', { status: 'failed', diagnostics: {
        name: 'Error', message: 'Synthetic OS failure', stack: 'Synthetic stack',
      } });
      const result = await waiting;
      assert.equal(result.error.code, outcome === 'decline' ? 'ACTION_DECLINED' : 'NOTIFICATION_UNAVAILABLE');
      if (outcome === 'failed') assert.equal(result.error.diagnostics.stack, 'Synthetic stack');
      assert.equal(f.bridge.accessRequests.size, 0);
      assert.equal(f.bridge.targets.size, 0);
    } finally { f.close(); }
  }
});

test('cancelled waits clear prompts, old peers fail clearly, and active old peers still return immediately', async () => {
  const f = await fixture();
  try {
    await f.sync({ revision: 2, state: 'inactive', tabs: [] });
    const controller = new AbortController();
    const waiting = capture(f.bridge.waitWorkspace(f.client.id, f.device.device_id, DESCRIPTION, 300000, controller.signal, f.client.tenant_id));
    await flush(); controller.abort();
    assert.equal((await waiting).error.code, 'COMMAND_CANCELLED');
    assert.equal(f.ws.sent.at(-1).type, 'workspace.request.cancel');
    assert.equal(f.bridge.accessRequests.size, 0);
    f.session.browser_info.extension_version = '5.0.6';
    await assert.rejects(f.bridge.waitWorkspace(f.client.id, f.device.device_id, DESCRIPTION, 300000, undefined, f.client.tenant_id), /UPGRADE_REQUIRED/);
    await f.sync({ revision: 3, state: 'active', activation_id: randomUUID(), tabs: [tab(1)] });
    assert.equal((await f.bridge.waitWorkspace(f.client.id, f.device.device_id, DESCRIPTION, 300000, undefined, f.client.tenant_id)).state, 'active');
  } finally { f.close(); }
});

test('expiry and revocation retire prompts and never resurrect pending authority', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'], now: Date.now() });
  const f = await fixture();
  try {
    await f.sync({ revision: 2, state: 'inactive', tabs: [] });
    const expiry = capture(f.bridge.waitWorkspace(f.client.id, f.device.device_id, DESCRIPTION, 1000, undefined, f.client.tenant_id));
    t.mock.timers.tick(1000);
    assert.equal((await expiry).error.code, 'COMMAND_EXPIRED');
    assert.equal(f.bridge.accessRequests.size, 0);
    assert.equal(f.ws.sent.at(-1).type, 'workspace.request.cancel');
    const revoked = capture(f.bridge.waitWorkspace(f.client.id, f.device.device_id, DESCRIPTION, 300000, undefined, f.client.tenant_id));
    f.store.rotateClient(f.client.id); f.bridge.reconcile();
    assert.equal((await revoked).error.code, 'NOT_AUTHORIZED');
    assert.equal(f.bridge.accessRequests.size, 0);
    assert.equal(f.bridge.targets.size, 0);
  } finally { f.close(); }
});

test('offline bound devices receive the prompt after real proof reconnect, never automatic workspace activation', async () => {
  const f = await fixture();
  try {
    f.bridge.disconnected(f.session);
    const abort = new AbortController();
    const waiting = capture(f.bridge.waitWorkspace(f.client.id, f.device.device_id, DESCRIPTION, 300000, abort.signal, f.client.tenant_id));
    assert.equal(f.bridge.accessRequests.size, 0);
    const next = { ...f.session, authenticated: false, challenge: null, connection_id: randomUUID(),
      workspaces: new Set(), usedTargets: new Set() };
    await f.bridge.message(next, { type: 'hello', version: 5, tenant_id: f.client.tenant_id, key_id: f.key.key_id,
      browser_info: { extension_version: '5.0.7', browser_name: 'chrome', browser_version: '145.0' } });
    const challenge = f.ws.sent.at(-1);
    await f.bridge.message(next, { type: 'proof', tenant_id: f.client.tenant_id,
      signature: await sign(f.key.key, authPayload(challenge)) });
    const prompt = f.ws.sent.at(-1);
    assert.equal(prompt.type, 'workspace.request');
    assert.equal(prompt.connection_id, next.connection_id);
    assert.equal(f.bridge.targets.size, 0);
    assert.equal(f.bridge.waiters.size, 1);
    abort.abort(); assert.equal((await waiting).error.code, 'COMMAND_CANCELLED');
    assert.equal(f.bridge.accessRequests.size, 0);
  } finally { f.close(); }
});

test('repeated new access requests are rate-limited without leaked waiters or grants', async () => {
  const f = await fixture();
  try {
    await f.sync({ revision: 2, state: 'inactive', tabs: [] });
    for (let index = 0; index < 8; index++) {
      const abort = new AbortController();
      const waiting = capture(f.bridge.waitWorkspace(f.client.id, f.device.device_id, DESCRIPTION, 300000, abort.signal, f.client.tenant_id));
      abort.abort(); assert.equal((await waiting).error.code, 'COMMAND_CANCELLED');
    }
    await assert.rejects(f.bridge.waitWorkspace(f.client.id, f.device.device_id, DESCRIPTION, 300000, undefined, f.client.tenant_id), /RATE_LIMITED/);
    assert.equal(f.bridge.waiters.size, 0);
    assert.equal(f.bridge.accessRequests.size, 0);
    assert.equal(f.bridge.targets.size, 0);
  } finally { f.close(); }
});
