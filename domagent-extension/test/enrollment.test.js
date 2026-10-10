import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Controller } from '../src/controller.js';
import { DeviceKeys } from '../src/keys.js';
import { enrollmentPayload, startPayload, statusPayload, verify } from '../../shared/protocol.js';

test('enrollment persists its key/identity but requires dashboard and explicit local owner confirmation', async () => {
  const records = new Map();
  const keys = new DeviceKeys({
    async get(origin) { return records.get(origin); },
    async put(record) { records.set(record.origin, record); return record; },
  });
  const origin = 'https://control.example';
  const extension_origin = 'moz-extension://11111111-1111-1111-1111-111111111111';
  let phase = 'pending';
  let confirmations = 0;
  const controller = new Controller({
    adapter: { capabilities: () => [], async release() {} },
    keys, storage: { async set() {} }, extensionUrl: `${extension_origin}/`,
    fetcher: async (url, options) => {
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'error');
      const body = options.body ? JSON.parse(options.body) : null;
      const path = new URL(url).pathname.split('/').at(-1);
      let value;
      if (path === 'challenge') value = { origin, nonce: 'challenge-nonce' };
      if (path === 'start') {
        assert.equal(body.extension_origin, extension_origin);
        assert.equal(await verify(body.public_key, startPayload({ ...body, origin }), body.signature), true);
        value = { enrollment_id: 'enrollment-1', verification_url: `${origin}/enroll/enrollment-1`,
          expires_at: Date.now() + 60_000 };
      }
      if (path === 'status') {
        assert.equal(await verify(controller.record.public_key,
          statusPayload({ ...body, origin }), body.signature), true);
        value = { state: phase, enrollment_id: 'enrollment-1' };
        if (phase === 'approved') Object.assign(value, { owner_id: 'owner-1', owner_label: 'Owner',
          key_id: controller.record.key_id, nonce: 'approval-nonce', extension_origin,
          protected_origins: ['https://idp.example'], expires_at: Date.now() + 60_000 });
      }
      if (path === 'confirm') {
        confirmations++;
        assert.equal(await verify(controller.record.public_key,
          enrollmentPayload({ ...controller.record.enrollment, origin }), body.signature), true);
        value = { ...controller.record.enrollment, device_id: 'device-1' };
      }
      return { ok: true, async text() { return JSON.stringify(value); } };
    },
  });
  await controller.configure({ service_origin: origin, local_protected_origins: ['https://banana.example'] });
  await controller.enroll('My Firefox');
  const key = controller.record.key_id;
  await assert.rejects(controller.confirmEnrollment(), /ENROLLMENT_EXPIRED/);
  await controller.enrollmentStatus();
  assert.equal(controller.record.enrollment.owner_id, undefined);
  phase = 'approved';
  await controller.enrollmentStatus();
  assert.equal(confirmations, 0);
  assert.equal(controller.record.identity, null);
  await controller.confirmEnrollment();
  assert.equal(confirmations, 1);
  assert.equal(controller.record.key_id, key);
  assert.equal(controller.record.enrollment, null);
  assert.equal(controller.record.identity.owner_id, 'owner-1');
  assert.deepEqual(controller.protectedOrigins(), [origin, 'https://banana.example', 'https://idp.example']);
  assert.equal((await new DeviceKeys(keys.store).get(origin)).identity.device_id, 'device-1');
});
