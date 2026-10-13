import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Controller } from '../src/controller.js';
import { DeviceKeys } from '../src/keys.js';
import { pairingStartPayload, pairingStatusPayload, pairingConfirmPayload, verify } from '../../shared/protocol.js';

test('domain-only reverse pairing binds an authenticated proposal only after trusted local confirmation', async () => {
  const origin = 'https://control.example';
  const records = new Map(), saved = {}, calls = [];
  const keys = new DeviceKeys({
    async get(key) { return records.get(key); },
    async put(record) { records.set(record.connection_url, record); return record; },
    async delete(key) { records.delete(key); },
  });
  let started;
  const tenant_id = 't_abcdefghijklmnopqrstuv';
  const proposal = { proposal_id: crypto.randomUUID(), tenant_id, client_id: 'client-1', client_label: 'Atlas', nonce: 'nonce-confirm' };
  const fetcher = async (url, args) => {
    const body = args.body ? JSON.parse(args.body) : null;
    calls.push({ url, body });
    let value;
    if (url.endsWith('/challenge')) value = { origin, nonce: 'nonce-start', expires_at: Date.now() + 300000 };
    else if (url.endsWith('/start')) {
      started = body;
      assert.equal(Object.hasOwn(body, 'origin'), false);
      assert.equal(body.pairing_code.length, 8);
      assert.equal(body.receipt.length, 43);
      assert(await verify(body.public_key, pairingStartPayload({ ...body, origin }), body.signature));
      value = { request_id: body.request_id, expires_at: Date.now() + 300000 };
    } else if (url.endsWith('/status')) {
      assert(await verify(started.public_key, pairingStatusPayload({ ...body, origin }), body.signature));
      value = { state: 'proposed', expires_at: Date.now() + 300000, ...proposal };
    } else if (url.endsWith('/confirm')) {
      assert(await verify(started.public_key, pairingConfirmPayload({ ...body, origin }), body.signature));
      value = { state: 'confirmed', device_id: 'device-1', ...proposal, protected_origins: [origin] };
    } else throw new Error('Unexpected API');
    return { ok: true, async text() { return JSON.stringify(value); } };
  };
  class Socket { constructor() { this.readyState = 1; } close() {} }
  const controller = new Controller({ adapter: {}, keys, storage: { async set(value) { Object.assign(saved, value); } },
    extensionUrl: 'moz-extension://11111111-1111-4111-8111-111111111111/', fetcher, Socket });
  try {
    await controller.configure({ service_origin: 'control.example' });
    await controller.beginPairing();
    assert.equal(controller.record, null);
    assert.equal(controller.snapshot().pairing.code.length, 9);
    assert.equal(JSON.stringify(controller.snapshot()).includes(started.receipt), false);
    await controller.pairingStatus();
    assert.equal(controller.record, null);
    await controller.confirmPairing();
    assert.equal(controller.record.identity.client_id, 'client-1');
    assert.equal(controller.record.privateKey.extractable, false);
    assert.equal(controller.record.key_id, started.key_id);
    assert.equal(controller.workspaces.size, 0);
    assert.equal(controller.config.tenant_id, tenant_id);
    assert.equal(saved.config.enabled, true);
    assert(!calls.some(call => /login|oidc|pair\/t_/.test(call.url)));
  } finally { controller.dispose(); }
});
