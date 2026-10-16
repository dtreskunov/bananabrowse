import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  validOperationArgs, OPERATIONS, validTabId, waitErrorDetails, navigationUrl,
  validDescription, inspectionErrorDetails, validBrowserInfo,
} from '../../shared/protocol.js';
import { MAX_RESULT_BYTES, boundedResult, errorCode, protectedRegex, protectedUnion } from '../src/security.js';
import { reattachCandidates, defaultBrowserName } from '../src/controller.js';

const origin = 'https://control.example';

test('descriptions enforce exactly forty trimmed characters and safe page errors exclude browser/source data', () => {
  for (const description of ['x', 'a'.repeat(39), ' '.repeat(40), ` ${'a'.repeat(39)} `, 'a'.repeat(501),
    '😀'.repeat(39)]) {
    assert.equal(validDescription(description), false);
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

test('manifests open the app window from the toolbar and keep site access optional', () => {
  for (const browser of ['chrome', 'firefox']) {
    const manifest = JSON.parse(readFileSync(new URL(`../${browser}/manifest.json`, import.meta.url), 'utf8'));
    assert.equal(manifest.action.default_popup, undefined);
    assert.equal(manifest.side_panel, undefined);
    assert.equal(manifest.sidebar_action, undefined);
    assert.equal(manifest.host_permissions, undefined);
    assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
    assert.equal(manifest.version, '6.1.2');
  }
  const manifest = JSON.parse(readFileSync(new URL('../firefox/manifest.json', import.meta.url), 'utf8'));
  assert(manifest.permissions.includes('sessions'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.persistent, undefined);
  assert.deepEqual(manifest.background.scripts, ['background.js']);
  assert.deepEqual(manifest.optional_permissions, ['userScripts']);
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
  assert.equal(manifest.browser_specific_settings.gecko.id, 'domagent-secure@domagent');
  assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, '153.0');
  assert(!manifest.permissions.some(permission => permission.startsWith('http')));
  assert.equal(manifest.externally_connectable, undefined);
});

test('browser metadata and inspection reasons are bounded allowlists, never authorization or exception text', () => {
  const info = { extension_version: '4.3.3', browser_name: 'firefox', browser_version: '147.0a1' };
  assert.equal(validBrowserInfo(info), true);
  for (const change of [
    { browser_name: 'private browser name' }, { browser_version: 'https://private.example' },
    { extension_version: '4.3.3<script>' }, { browser_version: '1'.repeat(65) }, { source: 'private' },
  ]) assert.equal(validBrowserInfo({ ...info, ...change }), false);
  assert.equal(validBrowserInfo({ ...info, browser_version: null }), true);
  assert.deepEqual(inspectionErrorDetails({ code: 'PAGE_UNAVAILABLE', inspection_stage: 'document_injection',
    injection_reason: 'browser_restricted' }), { inspection_stage: 'document_injection', injection_reason: 'browser_restricted' });
  assert.deepEqual(inspectionErrorDetails({ code: 'PAGE_UNAVAILABLE', inspection_stage: 'document_injection',
    injection_reason: 'private exception text' }), { inspection_stage: 'document_injection' });
});
test('server command expiry remains an explicit known failure', () => {
  assert.equal(errorCode(new Error('COMMAND_EXPIRED')), 'COMMAND_EXPIRED');
});

test('navigation accepts only credential-free HTTP(S), excluding complete protected origins', () => {
  for (const url of [
    'file:///etc/passwd', 'chrome://settings', 'moz-extension://abc/options.html',
    'javascript:alert(1)', 'https://user:pass@site.example', `${origin}/dashboard`,
    'https://CONTROL.example:443/a', 'data:text/html,x',
  ]) assert.throws(() => navigationUrl(url, [origin]));
  navigationUrl('http://intranet.local/app', [origin]);
  navigationUrl('https://control.example.evil/app', [origin]);
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
  assert(OPERATIONS.includes('get_page_snapshot'));
});

test('tab IDs are short server-issued handles and timeout diagnostics stay bounded', () => {
  assert.equal(validTabId('t1'), true);
  assert.equal(validTabId('t2kq9'), true);
  for (const invalid of [null, 12, 't', 'T1', 's1', 't1\n', crypto.randomUUID(), 'https://site.example/']) {
    assert.equal(validTabId(invalid), false);
  }
  assert.deepEqual(waitErrorDetails({ code: 'WAIT_TIMEOUT', last_error: 'ELEMENT_NOT_FOUND', timeout_ms: 3000 }),
    { last_error: 'ELEMENT_NOT_FOUND', timeout_ms: 3000 });
  assert.deepEqual(waitErrorDetails({ code: 'WAIT_TIMEOUT', last_error: 'private exception text', timeout_ms: 3000 }), {});
  assert.deepEqual(waitErrorDetails({ code: 'WAIT_TIMEOUT', last_error: 'ELEMENT_NOT_FOUND', timeout_ms: 10_001 }), {});
  assert.deepEqual(waitErrorDetails({ code: 'OTHER', last_error: 'ELEMENT_NOT_FOUND', timeout_ms: 3000 }), {});
});



test('Chrome reattach candidates match by exact title and rank by matching URLs', () => {
  const record = { title: 'Flights', tabs: [{ url: 'https://a.example/' }, { url: 'https://b.example/' }] };
  const groups = [{ id: 1, title: 'Flights' }, { id: 2, title: 'Flights' }, { id: 3, title: 'Hotels' }];
  const tabs = new Map([[1, [{ url: 'https://z.example/' }]], [2, [{ url: 'https://a.example/' }, { url: 'https://b.example/' }]]]);
  assert.deepEqual(reattachCandidates(record, groups, tabs).map(c => [c.groupId, c.matching]), [[2, 2], [1, 0]]);
  assert.deepEqual(reattachCandidates({ title: 'None', tabs: [] }, groups, tabs), []);
});

test('the suggested browser name is plain and platform-specific', () => {
  assert.equal(defaultBrowserName('firefox', 'MacIntel'), 'Firefox on Mac');
  assert.equal(defaultBrowserName('chrome', 'Win32'), 'Chrome on Windows');
  assert.equal(defaultBrowserName('chrome', 'Linux x86_64'), 'Chrome on Linux');
});
