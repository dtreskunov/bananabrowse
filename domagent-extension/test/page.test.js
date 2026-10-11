import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageEvaluate, pageHelper, sharingIndicator } from '../src/page.js';

test('password/CAPTCHA presence does not block normal inspection or page text', () => {
  const originalDocument = globalThis.document;
  const originalComputed = globalThis.getComputedStyle;
  const originalLocation = globalThis.location;
  globalThis.location = { href: 'https://site.example/login' };
  globalThis.getComputedStyle = () => ({ visibility: 'visible' });
  const body = { nodeType: 1, tagName: 'BODY', matches: () => false, getRootNode: () => ({}),
    childNodes: [{ nodeType: 3, textContent: 'Login page' }] };
  globalThis.document = {
    body, querySelectorAll: selector => selector === 'body' ? [body] : [],
  };
  try {
    assert.equal(pageHelper('inspect').url, 'https://site.example/login');
    assert.deepEqual(pageHelper('get_text', { selector: 'body' }), { text: 'Login page' });
  } finally {
    globalThis.document = originalDocument;
    globalThis.getComputedStyle = originalComputed;
    globalThis.location = originalLocation;
  }
});

test('page eval returns structured data or an explicit unavailable result without privileged fallback', async () => {
  assert.deepEqual(await pageEvaluate('1 + 1'), { value: 2 });
  assert.deepEqual(await pageEvaluate('undefined'), { value: null });
  assert.deepEqual(await pageEvaluate('throw new Error("CSP or runtime failure")'), { error: 'CAPABILITY_UNAVAILABLE' });
  assert.deepEqual(await pageEvaluate('({ data: "<script>not markup</script>" })'),
    { value: { data: '<script>not markup</script>' } });
});

test('missing elements and invalid CSS selectors are distinct from a stale target', () => {
  const originalDocument = globalThis.document;
  const selectors = [];
  globalThis.document = {
    querySelectorAll(selector) {
      selectors.push(selector);
      if (selector === 'button[') throw Object.assign(new Error('Invalid selector'), { name: 'SyntaxError' });
      return [];
    },
  };
  try {
    for (const operation of ['click', 'type_text', 'get_text']) {
      assert.deepEqual(pageHelper(operation, { selector: 'button[type="submit"]' }),
        { error: 'ELEMENT_NOT_FOUND' });
      assert.deepEqual(pageHelper(operation, { selector: 'button[' }), { error: 'INVALID_SELECTOR' });
    }
    assert(selectors.includes('button[type="submit"]'));
  } finally {
    globalThis.document = originalDocument;
  }
});

test('packaged positive decision handlers reject synthetic page clicks', async t => {
  const saved = { document: globalThis.document, location: globalThis.location, chrome: globalThis.chrome };
  t.after(() => Object.assign(globalThis, saved));
  const elements = [];
  const messages = [];
  const element = () => {
    const node = { style: {}, handlers: {}, setAttribute() {}, append() {},
      addEventListener(type, handler) { this.handlers[type] = handler; },
      attachShadow() { return element(); } };
    elements.push(node);
    return node;
  };
  globalThis.document = { querySelector: () => null, createElement: element, documentElement: { append() {} } };
  globalThis.location = { href: 'https://site.example/' };
  globalThis.chrome = { runtime: { async sendMessage(message) { messages.push(message); return { ok: true }; } } };
  for (const operation of ['get_text', 'request_handoff']) {
    elements.length = 0;
    sharingIndicator({ target_id: 'target', token: 'nonce', label: 'Client',
      command: { request_id: 'request', operation, description: 'Human instructions', state: 'pending' } });
    const buttons = elements.filter(node => node.handlers.click);
    for (const button of buttons.filter(node => node.textContent !== 'Stop sharing')) {
      button.handlers.click({ isTrusted: false });
    }
    assert.equal(messages.length, 0);
    buttons[0].handlers.click({ isTrusted: true });
    await Promise.resolve();
    assert.equal(messages.pop().action, operation === 'request_handoff' ? 'done' : 'approve');
  }
});

test('isolated document nonce rejects helper work targeting a different document', t => {
  const saved = globalThis.document;
  t.after(() => { globalThis.document = saved; });
  globalThis.document = { querySelector() { throw new Error('Must not touch the new document'); } };
  assert.deepEqual(pageHelper('click', { selector: 'button', document_nonce: 'old-document' }), { error: 'TARGET_STALE' });
});
