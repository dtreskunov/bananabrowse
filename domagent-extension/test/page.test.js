import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { pageHelper, sharingIndicator } from '../src/page.js';
beforeEach(t => {
  const width = globalThis.innerWidth, height = globalThis.innerHeight;
  globalThis.innerWidth = 800; globalThis.innerHeight = 600;
  t.after(() => { globalThis.innerWidth = width; globalThis.innerHeight = height; });
});

test('password/CAPTCHA presence does not block normal inspection or page text', async () => {
  const originalDocument = globalThis.document;
  const originalComputed = globalThis.getComputedStyle;
  const originalLocation = globalThis.location;
  globalThis.location = { href: 'https://site.example/login' };
  globalThis.getComputedStyle = () => ({ visibility: 'visible' });
  const body = { nodeType: 1, tagName: 'BODY', matches: () => false, getRootNode: () => ({}),
    getBoundingClientRect: () => ({ width: 100, height: 100 }),
    childNodes: [{ nodeType: 3, textContent: 'Login page' }] };
  globalThis.document = {
    body, querySelectorAll: selector => selector === 'body' ? [body] : [],
  };
  try {
    assert.equal((await pageHelper('inspect')).url, 'https://site.example/login');
    assert.deepEqual(await pageHelper('get_text', { selector: 'body' }), {
      text: 'Login page', text_truncated: false, truncated: false, rendered: true, text_source: 'rendered',
    });
  } finally {
    globalThis.document = originalDocument;
    globalThis.getComputedStyle = originalComputed;
    globalThis.location = originalLocation;
  }
});


test('missing elements and invalid CSS selectors are distinct from a stale target', async () => {
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
      assert.deepEqual(await pageHelper(operation, { selector: 'button[type="submit"]' }),
        { error: 'ELEMENT_NOT_FOUND' });
      assert.deepEqual(await pageHelper(operation, { selector: 'button[' }), { error: 'INVALID_SELECTOR' });
    }
    assert(selectors.includes('button[type="submit"]'));
  } finally {
    globalThis.document = originalDocument;
  }
});

test('page decoration contains no positive consent controls; only a trusted negative Stop remains', async t => {
  const saved = { document: globalThis.document, location: globalThis.location, chrome: globalThis.chrome,
    __domagentSharingHost: globalThis.__domagentSharingHost };
  t.after(() => Object.assign(globalThis, saved));
  const elements = [];
  const messages = [];
  const element = () => {
    const node = { style: {}, handlers: {}, setAttribute() {}, append() {}, remove() {},
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
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0].textContent, 'Stop sharing and close tab');
    buttons[0].handlers.click({ isTrusted: false });
    assert.equal(messages.length, 0);
    buttons[0].handlers.click({ isTrusted: true });
    await Promise.resolve();
    assert.equal(messages.pop().type, 'page.stop');
  }
});

test('isolated document nonce rejects helper work targeting a different document', async t => {
  const saved = globalThis.document;
  t.after(() => { globalThis.document = saved; });
  globalThis.document = { querySelector() { throw new Error('Must not touch the new document'); } };
  assert.deepEqual(await pageHelper('click', { selector: 'button', document_nonce: 'old-document' }), { error: 'TARGET_STALE' });
});
