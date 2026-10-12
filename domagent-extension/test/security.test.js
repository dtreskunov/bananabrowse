import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  authPayload, connectionUrl, enrollmentPayload, grantPayload, parseConnectionUrl, sign, verify,
  validOperationArgs, OPERATIONS, validTargetId, waitErrorDetails,
  validDescription, inspectionErrorDetails,
} from '../../shared/protocol.js';
import {
  MAX_RESULT_BYTES, boundedResult, errorCode, isUiSender, needsSetup, protectedRegex, protectedUnion, validateCommand,
} from '../src/security.js';
import { DeviceKeys } from '../src/keys.js';

const origin = 'https://control.example';
const tenant_id = 't_abcdefghijklmnopqrstuv';
const otherTenant = 't_ABCDEFGHIJKLMNOPQRSTUV';
const binding = { tenant_id, epoch: 'epoch-1', connection_id: 'connection-1' };
const grant = { ...binding, state: 'active', client_id: 'client-1', target_id: 'target-1',
  capabilities: ['navigate', 'get_text', 'evaluate_script'] };
const command = { ...binding, type: 'command', request_id: 'request-1', target_id: 'target-1',
  client_id: 'client-1', operation: 'get_text', description: 'Read the page in the explicitly selected browser tab', args: {}, expires_at: Date.now() + 25_000 };

test('descriptions enforce exactly forty trimmed characters and safe page errors exclude browser/source data', () => {
  for (const description of ['x', 'a'.repeat(39), ' '.repeat(40), ` ${'a'.repeat(39)} `, 'a'.repeat(501),
    '😀'.repeat(39)]) {
    assert.equal(validDescription(description), false);
    assert.throws(() => validateCommand({ ...command, description }, grant, binding, [origin]), /INVALID_ARGUMENT/);
  }
  for (const description of ['a'.repeat(40), 'a'.repeat(500), ` ${'a'.repeat(40)} `, '😀'.repeat(40)]) {
    assert.equal(validDescription(description), true);
  }
  assert.deepEqual(inspectionErrorDetails({ code: 'PAGE_UNAVAILABLE', inspection_stage: 'document_injection',
    last_error: 'PAGE_UNAVAILABLE', timeout_ms: 10000, source: 'private', url: 'private' }),
    { inspection_stage: 'document_injection', last_error: 'PAGE_UNAVAILABLE', timeout_ms: 10000 });
  assert.deepEqual(inspectionErrorDetails({ code: 'PAGE_UNAVAILABLE', inspection_stage: 'private browser error' }), {});
  assert.deepEqual(inspectionErrorDetails({ code: 'WAIT_TIMEOUT', inspection_stage: 'tab_status',
    last_error: 'private text', timeout_ms: 10000 }), { inspection_stage: 'tab_status' });
});

test('Firefox uses a persistent background without broadening website permissions', () => {
  const manifest = JSON.parse(readFileSync(new URL('../firefox/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.manifest_version, 2);
  assert.equal(manifest.background.persistent, true);
  assert.deepEqual(manifest.background.scripts, ['background.js']);
  assert.deepEqual(manifest.optional_permissions, ['http://*/*', 'https://*/*']);
  assert(!manifest.permissions.some(permission => permission.startsWith('http')));
  assert.equal(manifest.externally_connectable, undefined);
});

test('only a fresh installation opens setup; updates/restarts never pop up or restore sharing', () => {
  assert.equal(needsSetup('install', null), true);
  for (const reason of ['update', 'chrome_update', 'shared_module_update']) {
    assert.equal(needsSetup(reason, { device_id: 'existing' }), false);
    assert.equal(needsSetup(reason, null), false);
  }
  assert.equal(needsSetup('install', { device_id: 'existing' }), false);
});

test('server command expiry remains an explicit known failure', () => {
  assert.equal(errorCode(new Error('COMMAND_EXPIRED')), 'COMMAND_EXPIRED');
});

test('only top-level exact packaged UI pages may send local decisions', () => {
  const runtime = { id: 'extension-id', getURL: page => `chrome-extension://extension-id/${page}` };
  const ui = { id: runtime.id, url: runtime.getURL('options.html'), frameId: 0, tab: { id: 1 } };
  assert.equal(isUiSender(ui, runtime), true);
  assert.equal(isUiSender({ ...ui, url: runtime.getURL('panel.html?window_id=123') }, runtime), true);
  assert.equal(isUiSender({ ...ui, url: runtime.getURL('request.html?request_id=one') }, runtime), true);
  for (const sender of [
    { ...ui, url: 'https://site.example/' },
    { ...ui, url: runtime.getURL('request.html.evil') },
    { ...ui, url: runtime.getURL('background.js') },
    { ...ui, frameId: 3 }, { ...ui, id: 'other' }, {},
  ]) assert.equal(isUiSender(sender, runtime), false);
});

test('target, client, capability, ACK and connection binding are mandatory', () => {
  assert.deepEqual(validateCommand(command, grant, binding, [origin]), {});
  for (const change of [
    { target_id: 'other' }, { client_id: 'other' }, { epoch: 'old' }, { connection_id: 'old' },
    { tenant_id: undefined }, { tenant_id: otherTenant },
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

test('operation schemas accept ref/document targets and typed actions without broadening authority', () => {
  for (const operation of ['click', 'type_text', 'select_option', 'set_checked', 'press_key']) {
    const fields = { type_text: { text: '' }, select_option: { value: '' },
      set_checked: { checked: false }, press_key: { key: 'Enter' } }[operation] || {};
    assert(validOperationArgs(operation, { selector: 'button', ...fields }));
    assert(validOperationArgs(operation, { ref: 'e1', document: 'document-1', ...fields }));
    for (const invalid of [
      fields, { ref: 'e1', ...fields }, { document: 'document-1', ...fields },
      { selector: 'button', ref: 'e1', document: 'document-1', ...fields },
      { ref: 'invalid', document: 'document-1', ...fields },
      { selector: 'button', ...fields, timeout_ms: 10_001 },
      { selector: 'button', ...fields, tabId: 12 },
    ]) assert.equal(validOperationArgs(operation, invalid), false);
  }
  assert.equal(validOperationArgs('set_checked', { selector: 'input', checked: 'false' }), false);
  assert.equal(validOperationArgs('press_key', { selector: 'input', key: 'Control+L' }), false);
  assert.equal(validOperationArgs('scroll', { delta_y: 50 }), true);
  assert.equal(validOperationArgs('scroll', { delta_y: Infinity }), false);
  assert.equal(validOperationArgs('wait_for_page', { timeout_ms: 0 }), true);
  assert.equal(validOperationArgs('get_page_snapshot', { frameId: 1 }), false);
  assert.equal(validOperationArgs('inspect_element', { selector: '#search', max_output_bytes: 4096 }), true);
  assert.equal(validOperationArgs('inspect_element', { selector: '#search', max_output_bytes: 4097 }), false);
  assert.equal(validOperationArgs('inspect_element', { selector: '#search', approval_token: 'remote' }), false);
  assert.equal(validOperationArgs('get_page_snapshot', { selector: 'main', max_text_chars: 0, max_elements: 100, max_output_bytes: 65536 }), true);
  for (const args of [{ max_elements: 101 }, { max_text_chars: 16001 }, { max_output_bytes: 65537 }]) {
    assert.equal(validOperationArgs('get_page_snapshot', args), false);
  }
  const snapshot = { ...command, operation: 'get_page_snapshot', args: {} };
  assert.throws(() => validateCommand(snapshot, grant, binding, [origin]), /CAPABILITY_UNAVAILABLE/);
  const extended = { ...grant, capabilities: [...OPERATIONS] };
  assert.deepEqual(validateCommand(snapshot, extended, binding, [origin]), {});
});

test('target shapes and timeout diagnostics are bounded and preserve legacy opaque tokens', () => {
  assert.equal(validTargetId('not-a-uuid'), false);
  assert.equal(validTargetId(crypto.randomUUID()), true);
  assert.equal(validTargetId('a'.repeat(43)), true);
  for (const invalid of [null, 12, 'a'.repeat(42), 'a'.repeat(44), 'a'.repeat(43) + '\n',
    crypto.randomUUID() + '\n', 'https://site.example/']) {
    assert.equal(validTargetId(invalid), false);
  }
  assert.deepEqual(waitErrorDetails({ code: 'WAIT_TIMEOUT', last_error: 'ELEMENT_NOT_FOUND', timeout_ms: 3000 }),
    { last_error: 'ELEMENT_NOT_FOUND', timeout_ms: 3000 });
  assert.deepEqual(waitErrorDetails({ code: 'WAIT_TIMEOUT', last_error: 'private exception text', timeout_ms: 3000 }), {});
  assert.deepEqual(waitErrorDetails({ code: 'WAIT_TIMEOUT', last_error: 'ELEMENT_NOT_FOUND', timeout_ms: 10_001 }), {});
  assert.deepEqual(waitErrorDetails({ code: 'OTHER', last_error: 'ELEMENT_NOT_FOUND', timeout_ms: 3000 }), {});
});

function memoryStore() {
  const records = new Map();
  return {
    async get(origin) { return structuredClone(records.get(origin)); },
    async put(record) { records.set(record.connection_url, structuredClone(record)); return record; },
  };
}

test('P256 keys persist nonextractably per origin and tenant across restarts, never adopting legacy records', async () => {
  const store = memoryStore();
  const keys = new DeviceKeys(store);
  const [first, concurrent] = await Promise.all([keys.get(origin, tenant_id), keys.get(origin, tenant_id)]);
  assert.equal(first.key_id, concurrent.key_id);
  assert.equal(first.privateKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('jwk', first.privateKey));
  first.identity = { tenant_id, device_id: 'device-1', owner_id: 'owner-1' };
  await keys.save(first);
  const restarted = await new DeviceKeys(store).get(`${origin}/`, tenant_id);
  assert.equal(first.key_id, restarted.key_id);
  assert.equal(restarted.identity.device_id, 'device-1');
  assert.equal((await keys.get('https://different.example', tenant_id)).key_id === first.key_id, false);
  assert.equal((await keys.get(origin, otherTenant)).key_id === first.key_id, false);
  await assert.rejects(keys.get(origin), /INVALID_TENANT/);
  const legacy = new DeviceKeys({ async get(connection) { return connection === origin ? first : null; },
    async put(record) { return record; } });
  assert.notEqual((await legacy.get(origin, tenant_id)).key_id, first.key_id);
  assert.equal(await verify(restarted.public_key, authPayload({ origin, ...binding }),
    await sign(restarted.privateKey, authPayload({ origin, ...binding }))), true);
});

test('proof signatures bind service, enrollment, target, capability, client and connection fields', async () => {
  const record = await new DeviceKeys(memoryStore()).get(origin, tenant_id);
  const auth = { origin, ...binding, nonce: 'nonce', key_id: record.key_id };
  const signature = await sign(record.privateKey, authPayload(auth));
  assert.equal(await verify(record.public_key, authPayload(auth), signature), true);
  for (const field of ['origin', 'epoch', 'connection_id', 'nonce', 'key_id']) {
    assert.equal(await verify(record.public_key, authPayload({ ...auth, [field]: 'changed' }), signature), false);
  }
  assert.equal(await verify(record.public_key, authPayload({ ...auth, tenant_id: otherTenant }), signature), false);
  assert.throws(() => authPayload({ ...auth, tenant_id: undefined }), /INVALID_TENANT/);
  const approval = { ...auth, request_id: 'request', target_id: 'target', client_id: 'client',
    policy_id: 'single-tab-workspace-v1', tab_id: 7, window_id: 17, capabilities: ['navigate', 'get_text'] };
  const grantSignature = await sign(record.privateKey, grantPayload(approval));
  assert.equal(await verify(record.public_key, grantPayload({ ...approval, window_id: 18 }), grantSignature), false);
  assert.throws(() => grantPayload({ ...approval, window_id: undefined }), /INVALID_WINDOW/);
  for (const field of ['origin', 'epoch', 'connection_id', 'request_id', 'client_id', 'target_id', 'policy_id', 'nonce']) {
    assert.equal(await verify(record.public_key, grantPayload({ ...approval, [field]: 'changed' }), grantSignature), false);
  }
  assert.equal(await verify(record.public_key, grantPayload({ ...approval, capabilities: ['evaluate_script'] }), grantSignature), false);
  const enrollment = { origin, tenant_id, enrollment_id: 'enrollment', owner_id: 'owner',
    key_id: record.key_id, nonce: 'nonce', extension_origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
  const enrollmentSignature = await sign(record.privateKey, enrollmentPayload(enrollment));
  assert.equal(await verify(record.public_key, enrollmentPayload({ ...enrollment, owner_id: 'other' }),
    enrollmentSignature), false);
});

test('one connection link is canonical and rejects secrets, redirects, credentials and malformed tenants', () => {
  const link = connectionUrl(origin, tenant_id);
  assert.deepEqual(parseConnectionUrl(`${link}/`), { origin, tenant_id, connection_url: link });
  for (const value of [`http://control.example/join/${tenant_id}`, `${origin}/connect/request#token=secret`,
    `${link}?secret=1`, `${link}#approve`, `${origin}/join/FJGHB`, `${origin}/join/${tenant_id}/extra`,
    `https://user:password@control.example/join/${tenant_id}`]) assert.throws(() => parseConnectionUrl(value));
});
