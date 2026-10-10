import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  authPayload, enrollmentPayload, grantPayload, sign, verify,
} from '../../shared/protocol.js';
import {
  MAX_RESULT_BYTES, boundedResult, errorCode, isUiSender, protectedRegex, protectedUnion, validateCommand,
} from '../src/security.js';
import { DeviceKeys } from '../src/keys.js';

const origin = 'https://control.example';
const binding = { epoch: 'epoch-1', connection_id: 'connection-1' };
const grant = { ...binding, state: 'active', client_id: 'client-1', target_id: 'target-1',
  capabilities: ['navigate', 'get_text', 'evaluate_script'] };
const command = { ...binding, type: 'command', request_id: 'request-1', target_id: 'target-1',
  client_id: 'client-1', operation: 'get_text', args: {}, expires_at: Date.now() + 25_000 };

test('server command expiry remains an explicit known failure', () => {
  assert.equal(errorCode(new Error('COMMAND_EXPIRED')), 'COMMAND_EXPIRED');
});

test('only top-level exact packaged UI pages may send local decisions', () => {
  const runtime = { id: 'extension-id', getURL: page => `chrome-extension://extension-id/${page}` };
  const ui = { id: runtime.id, url: runtime.getURL('options.html'), frameId: 0, tab: { id: 1 } };
  assert.equal(isUiSender(ui, runtime), true);
  for (const sender of [
    { ...ui, url: 'https://site.example/' },
    { ...ui, url: runtime.getURL('options.html#approve') },
    { ...ui, url: runtime.getURL('background.js') },
    { ...ui, frameId: 3 }, { ...ui, id: 'other' }, {},
  ]) assert.equal(isUiSender(sender, runtime), false);
});

test('target, client, capability, ACK and connection binding are mandatory', () => {
  assert.deepEqual(validateCommand(command, grant, binding, [origin]), {});
  for (const change of [
    { target_id: 'other' }, { client_id: 'other' }, { epoch: 'old' }, { connection_id: 'old' },
    { operation: 'forwardCDPCommand' }, { operation: 'Browser.getCookies' },
    { args: { tabId: 7 } }, { args: { target_id: 'other' } },
    { expires_at: undefined }, { expires_at: 'future' }, { expires_at: Date.now() - 1 },
  ]) assert.throws(() => validateCommand({ ...command, ...change }, grant, binding, [origin]));
  assert.throws(() => validateCommand(command, { ...grant, state: 'awaiting_ack' }, binding, [origin]));
  assert.throws(() => validateCommand(command, null, binding, [origin]));
});

test('navigation accepts only credential-free HTTP(S), excluding complete protected origins', () => {
  const navigation = { ...command, operation: 'navigate' };
  for (const url of [
    'file:///etc/passwd', 'chrome://settings', 'moz-extension://abc/options.html',
    'javascript:alert(1)', 'https://user:pass@site.example', `${origin}/dashboard`,
    'https://CONTROL.example:443/a', 'data:text/html,x',
  ]) assert.throws(() => validateCommand({ ...navigation, args: { url } }, grant, binding, [origin]));
  validateCommand({ ...navigation, args: { url: 'http://intranet.local/app' } }, grant, binding, [origin]);
  validateCommand({ ...navigation, args: { url: 'https://control.example.evil/app' } }, grant, binding, [origin]);
});

test('protected filters anchor scheme, port and hostname and cover all URL paths', () => {
  const pattern = new RegExp(protectedRegex(origin), 'i');
  for (const url of [`${origin}/api`, 'https://CONTROL.example:443/login',
    'https://user:password@control.example/login']) assert.match(url, pattern);
  for (const url of [
    'https://control.example.evil/a', 'http://control.example/a',
    'https://control.example:8443/a', 'https://evil.example/?url=https://control.example/',
  ]) assert.doesNotMatch(url, pattern);
  const port = new RegExp(protectedRegex('https://control.example:8443'));
  assert.match('https://control.example:8443/x', port);
  assert.doesNotMatch(`${origin}/x`, port);
  assert.deepEqual(protectedUnion(origin, ['https://idp.example'], []),
    [origin, 'https://idp.example']);
});

test('results are data-only and bounded', () => {
  assert.deepEqual(boundedResult({ value: '<script>chrome.runtime.sendMessage()</script>' }),
    { value: '<script>chrome.runtime.sendMessage()</script>' });
  assert.throws(() => boundedResult({ value: 'x'.repeat(MAX_RESULT_BYTES + 1) }), /RESULT_TOO_LARGE/);
});

function memoryStore() {
  const records = new Map();
  return {
    async get(origin) { return structuredClone(records.get(origin)); },
    async put(record) { records.set(record.origin, structuredClone(record)); return record; },
  };
}

test('P256 private keys persist nonextractably per canonical service origin across restarts', async () => {
  const store = memoryStore();
  const keys = new DeviceKeys(store);
  const [first, concurrent] = await Promise.all([keys.get(origin), keys.get(origin)]);
  assert.equal(first.key_id, concurrent.key_id);
  assert.equal(first.privateKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('jwk', first.privateKey));
  first.identity = { device_id: 'device-1', owner_id: 'owner-1' };
  await keys.save(first);
  const restarted = await new DeviceKeys(store).get(`${origin}/`);
  assert.equal(first.key_id, restarted.key_id);
  assert.equal(restarted.identity.device_id, 'device-1');
  assert.equal((await keys.get('https://different.example')).key_id === first.key_id, false);
  assert.equal(await verify(restarted.public_key, authPayload({ origin }),
    await sign(restarted.privateKey, authPayload({ origin }))), true);
});

test('proof signatures bind service, enrollment, target, capability, client and connection fields', async () => {
  const record = await new DeviceKeys(memoryStore()).get(origin);
  const auth = { origin, ...binding, nonce: 'nonce', key_id: record.key_id };
  const signature = await sign(record.privateKey, authPayload(auth));
  assert.equal(await verify(record.public_key, authPayload(auth), signature), true);
  for (const field of ['origin', 'epoch', 'connection_id', 'nonce', 'key_id']) {
    assert.equal(await verify(record.public_key, authPayload({ ...auth, [field]: 'changed' }), signature), false);
  }
  const approval = { ...auth, request_id: 'request', target_id: 'target', client_id: 'client',
    policy_id: 'page-control-v1', capabilities: ['navigate', 'get_text'] };
  const grantSignature = await sign(record.privateKey, grantPayload(approval));
  for (const field of ['origin', 'epoch', 'connection_id', 'request_id', 'client_id', 'target_id', 'policy_id', 'nonce']) {
    assert.equal(await verify(record.public_key, grantPayload({ ...approval, [field]: 'changed' }), grantSignature), false);
  }
  assert.equal(await verify(record.public_key, grantPayload({ ...approval, capabilities: ['evaluate_script'] }), grantSignature), false);
  const enrollment = { origin, enrollment_id: 'enrollment', owner_id: 'owner',
    key_id: record.key_id, nonce: 'nonce', extension_origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
  const enrollmentSignature = await sign(record.privateKey, enrollmentPayload(enrollment));
  assert.equal(await verify(record.public_key, enrollmentPayload({ ...enrollment, owner_id: 'other' }),
    enrollmentSignature), false);
});
