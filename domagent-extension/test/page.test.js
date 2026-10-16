import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { pageHelper } from '../src/page.js';
beforeEach((t) => {
  const width = globalThis.innerWidth,
    height = globalThis.innerHeight;
  globalThis.innerWidth = 800;
  globalThis.innerHeight = 600;
  t.after(() => {
    globalThis.innerWidth = width;
    globalThis.innerHeight = height;
  });
});

test('password/CAPTCHA presence does not block normal inspection or page text', async () => {
  const originalDocument = globalThis.document;
  const originalComputed = globalThis.getComputedStyle;
  const originalLocation = globalThis.location;
  globalThis.location = { href: 'https://site.example/login' };
  globalThis.getComputedStyle = () => ({ visibility: 'visible' });
  const body = {
    nodeType: 1,
    tagName: 'BODY',
    matches: () => false,
    getRootNode: () => ({}),
    getBoundingClientRect: () => ({ width: 100, height: 100 }),
    childNodes: [{ nodeType: 3, textContent: 'Login page' }],
  };
  globalThis.document = {
    body,
    querySelectorAll: (selector) => (selector === 'body' ? [body] : []),
  };
  try {
    assert.equal((await pageHelper('inspect')).url, 'https://site.example/login');
    assert.deepEqual(await pageHelper('get_text', { selector: 'body' }), {
      text: 'Login page',
      text_truncated: false,
      truncated: false,
      rendered: true,
      text_source: 'rendered',
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
      assert.deepEqual(await pageHelper(operation, { selector: 'button[type="submit"]' }), {
        error: 'ELEMENT_NOT_FOUND',
      });
      assert.deepEqual(await pageHelper(operation, { selector: 'button[' }), { error: 'INVALID_SELECTOR' });
    }
    assert(selectors.includes('button[type="submit"]'));
  } finally {
    globalThis.document = originalDocument;
  }
});

test('isolated document nonce rejects helper work targeting a different document', async (t) => {
  const saved = globalThis.document;
  t.after(() => {
    globalThis.document = saved;
  });
  globalThis.document = {
    querySelector() {
      throw new Error('Must not touch the new document');
    },
  };
  assert.deepEqual(await pageHelper('click', { selector: 'button', document_nonce: 'old-document' }), {
    error: 'TARGET_STALE',
  });
});

function fakeDocument(spec) {
  const SVG = 'http://www.w3.org/2000/svg';
  const all = [];
  const doc = { title: 'Fixture', contentType: 'text/html', readyState: 'complete' };
  const build = (node, parent, svgOwner) => {
    const element = {
      nodeType: 1,
      tagName: node.tag.toUpperCase(),
      namespaceURI: node.svg ? SVG : 'http://www.w3.org/1999/xhtml',
      ownerSVGElement: svgOwner,
      id: '',
      attrs: node.attrs || {},
      parentElement: parent,
      isConnected: true,
      isContentEditable: false,
      shadowRoot: null,
      ...(node.href ? { href: new URL(node.href, 'https://site.example/app/').href } : {}),
      getAttribute(name) {
        return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null;
      },
      hasAttribute(name) {
        return Object.hasOwn(this.attrs, name) || (name === 'href' && Boolean(node.href));
      },
      matches(selector) {
        return selector.split(',').some((part) => part.trim() === node.tag);
      },
      closest(selector) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias -- the fake node walks its own ancestors
        for (let at = this; at; at = at.parentElement)
          if (selector === '[aria-hidden="true"]' && at.attrs['aria-hidden'] === 'true') return at;
        return null;
      },
      getRootNode: () => doc,
      getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 }),
      childNodes: [],
    };
    if (node.text) element.childNodes.push({ nodeType: 3, textContent: node.text });
    if (parent) {
      all.push(element);
      parent.childNodes.push(element);
    }
    for (const child of node.children || []) build(child, element, node.svg ? svgOwner || element : null);
    return element;
  };
  doc.body = build({ tag: 'body', children: spec }, null, null);
  doc.querySelectorAll = (selector) => (selector === '*' ? all : []);
  return { doc, all };
}

test('snapshots skip decorative SVG, rank interactive rows first and expose absolute link hrefs', async (t) => {
  const saved = [globalThis.document, globalThis.getComputedStyle, globalThis.location];
  t.after(() => {
    [globalThis.document, globalThis.getComputedStyle, globalThis.location] = saved;
    delete globalThis.__domagentPageRefs;
    delete globalThis.__domagentDocumentNonce;
  });
  delete globalThis.__domagentPageRefs;
  delete globalThis.__domagentDocumentNonce;
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });
  globalThis.location = { href: 'https://site.example/app/' };
  const { doc, all } = fakeDocument([
    { tag: 'h1', text: 'Activities' },
    { tag: 'svg', svg: true, attrs: { role: 'img' }, children: [{ tag: 'path', svg: true, attrs: { role: 'img' } }] },
    { tag: 'div', attrs: { role: 'presentation' }, text: 'layout' },
    { tag: 'div', attrs: { 'aria-hidden': 'true' }, children: [{ tag: 'button', text: 'Hidden' }] },
    { tag: 'a', href: 'activities/1', text: 'Run 1' },
    { tag: 'a', href: '/modern/activity/2', text: 'Run 2' },
    { tag: 'a', href: 'javascript:void(0)', text: 'Menu' },
  ]);
  globalThis.document = doc;
  const snapshot = await pageHelper('get_page_snapshot', { max_elements: 3, ref_base: 1 });
  assert.deepEqual(
    snapshot.elements.map((row) => [row.ref, row.role, row.name, row.href]),
    [
      ['e1', 'link', 'Run 1', 'https://site.example/app/activities/1'],
      ['e2', 'link', 'Run 2', 'https://site.example/modern/activity/2'],
      ['e3', 'link', 'Menu', undefined],
    ],
  );
  assert.equal(snapshot.elements_truncated, true);
  assert.equal(snapshot.next_ref, 4);
  const roomy = await pageHelper('get_page_snapshot', { max_elements: 10 });
  assert.deepEqual(
    roomy.elements.map((row) => row.name),
    ['Activities', 'Run 1', 'Run 2', 'Menu'],
  );
  assert.deepEqual(
    roomy.elements.map((row) => row.ref),
    ['e4', 'e5', 'e6', 'e7'],
  );

  const current = globalThis.__domagentDocumentNonce;
  assert.deepEqual(await pageHelper('click', { ref: 'e1', document: current }), {
    error: 'ELEMENT_STALE',
    stale_reason: 'ref_superseded',
    current_document: current,
  });
  assert.deepEqual(await pageHelper('click', { ref: 'e99', document: current }), {
    error: 'ELEMENT_STALE',
    stale_reason: 'ref_from_other_document',
    current_document: current,
  });
  all.find((element) => element.tagName === 'A').isConnected = false;
  assert.deepEqual(await pageHelper('click', { ref: 'e5', document: current }), {
    error: 'ELEMENT_STALE',
    stale_reason: 'element_detached',
    current_document: current,
  });
  assert.deepEqual(await pageHelper('click', { ref: 'e5', document: 'abcdef0123456789' }), {
    error: 'TARGET_STALE',
    stale_reason: 'document_changed',
    snapshot_document: 'abcdef0123456789',
    current_document: current,
  });

  // A new document in the same tab continues numbering from the adapter's ref_base.
  delete globalThis.__domagentPageRefs;
  delete globalThis.__domagentDocumentNonce;
  const next = await pageHelper('get_page_snapshot', { max_elements: 1, ref_base: roomy.next_ref });
  assert.deepEqual(
    next.elements.map((row) => row.ref),
    ['e8'],
  );
  assert.equal(
    (await pageHelper('click', { ref: 'e5', document: next.document })).stale_reason,
    'ref_from_other_document',
  );
});
