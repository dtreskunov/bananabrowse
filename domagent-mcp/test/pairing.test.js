import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { pairingStartPayload, pairingStatusPayload, pairingConfirmPayload, pairingCancelPayload, sign } from '../../shared/protocol.js';
import { appFixture, keys, post, EXTENSION, ORIGIN } from './helpers.js';
import { token } from '../store.js';

async function start(f, code = 'K7MP4QTX') {
  const key = await keys();
  const challenge = await (await fetch(`${f.base}/api/pairing/challenge`, {
    headers: { 'X-DomAgent-Extension-Origin': EXTENSION },
  })).json();
  const value = { request_id: randomUUID(), key_id: key.key_id, public_key: key.public_key,
    extension_origin: EXTENSION, pairing_code: code, receipt: token(), nonce: challenge.nonce, label: 'Fixture browser' };
  value.signature = await sign(key.key, pairingStartPayload({ ...value, origin: ORIGIN }));
  const response = await post(f.base, '/api/pairing/start', value, { Origin: EXTENSION });
  assert.equal(response.status, 201);
  return { ...value, key, result: await response.json() };
}
async function signed(f, action, pairing, fields = {}) {
  const value = { request_id: pairing.request_id, key_id: pairing.key_id, receipt: pairing.receipt, ...fields };
  const payload = action === 'confirm' ? pairingConfirmPayload : action === 'cancel' ? pairingCancelPayload : pairingStatusPayload;
  value.signature = await sign(pairing.key.key, payload({ ...value, origin: ORIGIN }));
  return post(f.base, `/api/pairing/${action}`, value, { Origin: EXTENSION });
}

test('reverse pairing uses short-code adoption and long signed receipts without browser login', async () => {
  const f = await appFixture();
  try {
    const client = f.store.createClient('Atlas'), other = f.store.createClient('Other');
    const pairing = await start(f);
    const before = await (await signed(f, 'status', pairing)).json();
    assert.equal(before.state, 'pending');
    const adopted = f.store.adopt(client.id, client.tenant_id, 'k7mp-4qtx');
    assert.equal(adopted.state, 'proposed');
    assert.equal(adopted.nonce, undefined);
    assert.throws(() => f.store.adopt(other.id, other.tenant_id, pairing.pairing_code), /PAIRING_UNAVAILABLE/);
    const status = await (await signed(f, 'status', pairing)).json();
    assert.equal(status.client_id, client.id);
    const fields = { proposal_id: status.proposal_id, client_id: status.client_id, tenant_id: status.tenant_id, nonce: status.nonce };
    const confirmed = await (await signed(f, 'confirm', pairing, fields)).json();
    assert.equal(confirmed.state, 'confirmed');
    assert.equal(f.store.linked(client.id, confirmed.device_id, client.tenant_id), true);
    assert.equal(f.store.linked(other.id, confirmed.device_id, other.tenant_id), false);
    const duplicate = await (await signed(f, 'confirm', pairing, fields)).json();
    assert.equal(duplicate.device_id, confirmed.device_id);
    assert.equal(f.store.listDevices().length, 1);
    assert.equal((await fetch(`${f.base}/login`)).status, 404);
    assert.equal((await fetch(`${f.base}/dashboard`)).status, 404);
    assert.equal((await signed(f, 'status', { ...pairing, receipt: token() })).status, 404);
    assert.equal((await post(f.base, '/api/pairing/status', { request_id: pairing.request_id,
      key_id: pairing.key_id, receipt: pairing.pairing_code, signature: pairing.signature }, { Origin: EXTENSION })).status, 400);
  } finally { await f.close(); }
});

test('pairing collision, revoked claimant, cancellation, proof replay and expiry grant no authority', async () => {
  const f = await appFixture();
  try {
    const client = f.store.createClient('Atlas');
    const pairing = await start(f);
    const replay = await post(f.base, '/api/pairing/start', {
      request_id: pairing.request_id, key_id: pairing.key_id, public_key: pairing.public_key,
      extension_origin: EXTENSION, pairing_code: pairing.pairing_code, receipt: pairing.receipt,
      nonce: pairing.nonce, label: pairing.label, signature: pairing.signature,
    }, { Origin: EXTENSION });
    assert.equal(replay.status, 403);
    f.store.adopt(client.id, client.tenant_id, pairing.pairing_code);
    const proposed = await (await signed(f, 'status', pairing)).json();
    f.store.revoke('client', client.id);
    assert.equal((await signed(f, 'confirm', pairing, {
      proposal_id: proposed.proposal_id, tenant_id: proposed.tenant_id, client_id: proposed.client_id, nonce: proposed.nonce,
    })).status, 404);
    assert.equal(f.store.listDevices().length, 0);
    const another = await start(f, 'V8MP4QTX');
    assert.equal((await signed(f, 'cancel', another)).status, 200);
    assert.equal((await signed(f, 'status', another)).status, 404);
    assert.throws(() => f.store.adopt(client.id, client.tenant_id, another.pairing_code), /NOT_AUTHORIZED/);
    const expired = await start(f, 'V9MP4QTX');
    f.store.db.prepare('UPDATE pairings SET expires=0 WHERE id=?').run(expired.request_id);
    assert.equal((await signed(f, 'status', expired)).status, 404);
    assert.equal((await fetch(`${f.base}/api/pairing/challenge`, {
      headers: { Origin: 'https://attacker.test', 'X-DomAgent-Extension-Origin': EXTENSION },
    })).status, 403);
  } finally { await f.close(); }
});
