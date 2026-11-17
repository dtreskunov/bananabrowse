const path = require('node:path');
const { createRequire } = require('node:module');
const localRequire = createRequire(path.join(__dirname, '../../../bananabrowse-mcp/package.json'));
const { test, expect, chromium, firefox } = localRequire('@playwright/test');
const { loadPageHelper } = require('./page-helper.cjs');
const runHelper = (page, helper, operation, args = {}) =>
  page.evaluate(({ source, operation, args }) => (0, eval)(`(${source})`)(operation, args), {
    source: helper.toString(),
    operation,
    args,
  });
async function launchBrowser(engine) {
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = '/tmp';
  try {
    return await engine.launch({ headless: true });
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
}

for (const [name, engine] of [
  ['chrome', chromium],
  ['firefox', firefox],
]) {
  test(`${name}: styled hidden checkboxes use bound visible labels, never unrelated overlays or replacements`, async () => {
    const { pageHelper } = await loadPageHelper();
    const browser = await launchBrowser(engine);
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <style>
          #styled-label { display:inline-block; position:relative; width:160px; height:44px }
          #styled { position:absolute; inset:0; width:100%; height:100%; margin:0; opacity:0 }
        </style>
        <label id="styled-label" for="styled">Show navigation<input type="checkbox" id="styled"></label>
        <input type="checkbox" id="other">
        <div id="collapsed" style="display:none"><input type="checkbox" id="inside"></div>
        <label for="inside">Hidden menu item</label>
      `);
      await page.evaluate(() => {
        globalThis.__bananabrowseDocumentNonce = 'fixture-document';
      });
      const run = (operation, args = {}) => runHelper(page, pageHelper, operation, args);
      const diagnostic = await run('inspect_element', { selector: '#styled' });
      expect(diagnostic.reason).toBe('CSS_HIDDEN');
      expect(diagnostic.activation).toMatchObject({
        kind: 'associated_label',
        id: 'styled-label',
        name: 'Show navigation',
      });
      let preview = await run('prepare_action', { selector: '#styled', action: 'set_checked' });
      expect(
        await run('set_checked', { selector: '#styled', checked: true, approval_token: preview.approval_token }),
      ).toMatchObject({ checked: true });
      await expect(page.locator('#styled')).toBeChecked();
      expect(await run('click', { selector: '#styled-label' })).toMatchObject({ clicked: true });
      await expect(page.locator('#styled')).not.toBeChecked();
      await page.evaluate(() => {
        const overlay = document.createElement('div');
        overlay.id = 'site-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:#eee;z-index:100';
        document.body.append(overlay);
      });
      expect(await run('set_checked', { selector: '#styled', checked: true })).toEqual({ error: 'ELEMENT_OBSCURED' });
      await expect(page.locator('#styled')).not.toBeChecked();
      await page.locator('#site-overlay').evaluate((element) => element.remove());
      await page.locator('#styled').evaluate((element) => {
        element.disabled = true;
      });
      expect(await run('set_checked', { selector: '#styled', checked: true })).toEqual({ error: 'ELEMENT_DISABLED' });
      await page.locator('#styled').evaluate((element) => {
        element.disabled = false;
      });
      expect(await run('set_checked', { selector: '#inside', checked: true })).toEqual({
        error: 'ELEMENT_NOT_VISIBLE',
      });
      preview = await run('prepare_action', { selector: '#styled', action: 'set_checked' });
      await page.locator('#styled-label').evaluate((element) => {
        element.htmlFor = 'other';
      });
      expect(
        await run('set_checked', { selector: '#styled', checked: true, approval_token: preview.approval_token }),
      ).toEqual({ error: 'ELEMENT_STALE' });
      await expect(page.locator('#other')).not.toBeChecked();
      await page.locator('#styled-label').evaluate((element) => {
        element.htmlFor = 'styled';
      });
      preview = await run('prepare_action', { selector: '#styled', action: 'set_checked' });
      await page.locator('#styled-label').evaluate((element) => {
        const replacement = element.cloneNode(true);
        element.replaceWith(replacement);
      });
      expect(
        await run('set_checked', { selector: '#styled', checked: true, approval_token: preview.approval_token }),
      ).toEqual({ error: 'ELEMENT_STALE' });
      await expect(page.locator('#styled')).not.toBeChecked();
    } finally {
      await browser.close();
    }
  });

  test(`${name}: inspector reports bounded hiding ancestors and explicit reveal controls without mutating`, async () => {
    const { pageHelper } = await loadPageHelper();
    const browser = await launchBrowser(engine);
    try {
      const page = await browser.newPage();
      await page.setContent(
        '<button id="toggle" aria-controls="drawer" aria-expanded="false">Open navigation</button>' +
          '<div id="drawer" style="display:none"><input id="secret" value="private-input">' +
          '<button id="logout">Logout</button></div>',
      );
      await page.evaluate(() => {
        globalThis.__bananabrowseDocumentNonce = 'fixture-document';
      });
      const before = await page.evaluate(() => ({ focus: document.activeElement.tagName, x: scrollX, y: scrollY }));
      const result = await runHelper(page, pageHelper, 'inspect_element', { selector: '#logout' });
      expect(result.hidden_by).toMatchObject({ id: 'drawer', reason: 'DISPLAY_NONE', is_target: false });
      expect(result.reveal_controls).toEqual([
        { tag: 'button', id: 'toggle', role: 'button', name: 'Open navigation', expanded: 'false' },
      ]);
      expect(JSON.stringify(result)).not.toContain('private-input');
      expect(
        Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(result) }] })),
      ).toBeLessThan(4096);
      expect(await page.evaluate(() => ({ focus: document.activeElement.tagName, x: scrollX, y: scrollY }))).toEqual(
        before,
      );
    } finally {
      await browser.close();
    }
  });

  test(`${name}: read-only diagnostics and approval binding reject responsive replacements`, async () => {
    const { pageHelper } = await loadPageHelper();
    const browser = await launchBrowser(engine);
    try {
      const page = await browser.newPage({ viewport: { width: 610, height: 700 } });
      await page.setContent(
        '<style>@media(max-width:700px){#search{display:none}}#search.open{display:block}</style>' +
          '<button id="toggle">Search</button><label for="search">Search query</label><input id="search" value="private">' +
          '<button id="replace">Original action</button><div class="dup">One</div><div class="dup">Two</div>',
      );
      await page.evaluate(() => {
        globalThis.__bananabrowseDocumentNonce = 'fixture-document';
        document.querySelector('#toggle').onclick = () => document.querySelector('#search').classList.add('open');
      });
      const run = (operation, args = {}) => runHelper(page, pageHelper, operation, args);
      const before = await page.evaluate(() => ({ focus: document.activeElement.tagName, x: scrollX, y: scrollY }));
      const hidden = await run('inspect_element', { selector: '#search' });
      expect(hidden.reason).toBe('ZERO_SIZE');
      expect(hidden.viewport.width).toBe(610);
      expect(JSON.stringify(hidden)).not.toContain('private');
      expect(await page.evaluate(() => ({ focus: document.activeElement.tagName, x: scrollX, y: scrollY }))).toEqual(
        before,
      );
      expect((await run('inspect_element', { selector: '#missing' })).state).toBe('missing');
      expect((await run('inspect_element', { selector: '.dup' })).state).toBe('ambiguous');
      await run('click', { selector: '#toggle' });
      expect((await run('inspect_element', { selector: '#search' })).state).toBe('ready');
      await page.setViewportSize({ width: 900, height: 700 });
      expect((await run('inspect_element', { selector: '#search' })).viewport.width).toBe(900);
      const preview = await run('prepare_action', { selector: '#replace', action: 'click' });
      expect(preview.name).toBe('Original action');
      await page.locator('#replace').evaluate((element) => {
        element.outerHTML = '<button id="replace" onclick="globalThis.wrongAction=true">Replaced action</button>';
      });
      expect(await run('click', { selector: '#replace', approval_token: preview.approval_token })).toEqual({
        error: 'ELEMENT_STALE',
      });
      expect(await page.evaluate(() => globalThis.wrongAction)).toBeUndefined();
      await run('release_action', { approval_token: preview.approval_token });
      await page.locator('#search').evaluate((element) => {
        element.onfocus = () => {
          element.outerHTML = '<input id="search" value="untouched">';
        };
      });
      expect(await run('type_text', { selector: '#search', text: 'must not type' })).toEqual({
        error: 'ELEMENT_STALE',
      });
      await expect(page.locator('#search')).toHaveValue('untouched');
    } finally {
      await browser.close();
    }
  });

  test(`${name}: legacy controls, ambiguity candidates and scoped inspection expose usable refs`, async () => {
    const { pageHelper } = await loadPageHelper();
    const browser = await launchBrowser(engine);
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <div id="confirm" onclick="this.dataset.clicked='yes'"><span>Confirm</span></div>
        <button class="next" hidden>Hidden Next</button><div class="next" tabindex="0">Next</div>
        <label id="card-label" for="card">Add Credit/Debit Card</label><input id="card" type="radio" style="opacity:0">
        <label for="amount">Payment Amount</label><input id="amount" required>
        <button id="native">Existing target</button>
        <button aria-label="Next step">Next screen</button>
      `);
      const run = (operation, args = {}) => runHelper(page, pageHelper, operation, args);
      const snapshot = await run('get_page_snapshot');
      expect(snapshot.truncated).toBe(false);
      expect(snapshot.elements.find((element) => element.name === 'Confirm').ref).toMatch(/^e\d+$/);
      const existing = snapshot.elements.find((element) => element.name === 'Existing target');
      const before = await page.evaluate(() => ({ focus: document.activeElement.tagName, x: scrollX, y: scrollY }));
      const found = await run('find_elements', { text: 'Confirm' });
      expect(found.matched_count).toBe(1);
      expect(found.elements[0]).toMatchObject({ tag: 'div', name: 'Confirm', visible: true });
      expect((await run('find_elements', { text: 'Next screen' })).elements[0].name).toBe('Next step');
      expect((await run('find_elements', { text: 'Next step' })).matched_count).toBe(1);
      const labelled = await run('find_elements', { label: 'Payment Amount' });
      expect(labelled.elements[0]).toMatchObject({ value_present: false, valid: false });
      expect((await run('find_elements', { text: 'No such control' })).elements).toEqual([]);
      expect((await run('find_elements', { role: 'radio' })).elements).toEqual([]);
      expect((await run('find_elements', { role: 'radio', include_hidden: true })).elements).toHaveLength(1);
      const ambiguous = await run('inspect_element', { selector: '.next' });
      expect(ambiguous).toMatchObject({ state: 'ambiguous', matches: 2, candidates_truncated: false });
      expect(ambiguous.candidates.map((candidate) => candidate.visible)).toEqual([false, true]);
      expect(await run('click', { selector: '.next' })).toMatchObject({
        error: 'ELEMENT_AMBIGUOUS',
        candidates: ambiguous.candidates,
      });
      const styled = await run('inspect_element', { selector: '#card' });
      expect(styled.activation.ref).toMatch(/^e\d+$/);
      expect(await page.evaluate(() => ({ focus: document.activeElement.tagName, x: scrollX, y: scrollY }))).toEqual(
        before,
      );
      await run('click', { ref: styled.activation.ref, document: styled.document });
      await expect(page.locator('#card')).toBeChecked();
      await run('click', { ref: existing.ref, document: snapshot.document });
      await run('click', { ref: found.elements[0].ref, document: found.document });
      await expect(page.locator('#confirm')).toHaveAttribute('data-clicked', 'yes');
      const scoped = await run('get_page_snapshot', { selector: '#confirm' });
      expect(scoped.elements).toHaveLength(1);
      expect(scoped.elements[0].name).toBe('Confirm');
      expect(await run('click', { ref: found.elements[0].ref, document: found.document })).toMatchObject({
        error: 'ELEMENT_STALE',
      });
      const inspected = await run('inspect_element', { selector: '#confirm' });
      expect(await run('click', { ref: inspected.ref, document: inspected.document })).toMatchObject({ clicked: true });
    } finally {
      await browser.close();
    }
  });

  test(`${name}: form verification reports safe state, known formatting and rejection without values`, async () => {
    const { pageHelper } = await loadPageHelper();
    const browser = await launchBrowser(engine);
    try {
      const page = await browser.newPage();
      await page.setContent(
        '<label for="amount">Amount</label><input id="amount" required><input id="secret" type="password">',
      );
      await page.locator('#amount').evaluate((element) => {
        element.addEventListener('input', () => {
          element.value = Number(element.value).toFixed(2);
        });
      });
      const run = (operation, args = {}) => runHelper(page, pageHelper, operation, args);
      const mismatch = await run('type_text', { selector: '#amount', text: '12' });
      expect(mismatch).toMatchObject({
        error: 'INPUT_NOT_APPLIED',
        input_state: { value_present: true, value_changed: true, value_matches: false, valid: true },
      });
      const formatted = await run('type_text', { selector: '#amount', text: '14', expected_value: '14.00' });
      expect(formatted).toMatchObject({
        typed: true,
        verification: 'expected_formatted_value',
        input_state: { value_present: true, value_matches: true, valid: true },
      });
      await run('type_text', { selector: '#secret', text: 'fixture-payment-secret' });
      const read = await run('get_text', { selector: '#secret' });
      expect(read).toMatchObject({ text: '', empty_reason: 'VALUE_REDACTED', value_present: true });
      const metadata = await run('query_all', {
        selector: '#secret',
        fields: {
          id: { selector: ':scope', attribute: 'id' },
          type: { selector: ':scope', attribute: 'type' },
          value: { selector: ':scope' },
        },
      });
      expect(metadata.rows).toEqual([{ id: 'secret', type: 'password', value: null }]);
      for (const result of [mismatch, formatted, read, metadata, await run('get_page_snapshot')])
        expect(JSON.stringify(result)).not.toContain('fixture-payment-secret');
    } finally {
      await browser.close();
    }
  });
}
