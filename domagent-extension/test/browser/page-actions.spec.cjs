const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const localRequire = createRequire(path.join(__dirname, '../../../domagent-mcp/package.json'));
const { test, expect, chromium, firefox } = localRequire('@playwright/test');
const pageModule = pathToFileURL(path.resolve(__dirname, '../../src/page.js')).href;
const runHelper = (page, helper, operation, args = {}) => page.evaluate(({ source, operation, args }) =>
  (0, eval)(`(${source})`)(operation, args), { source: helper.toString(), operation, args });
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

for (const [name, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${name}: styled hidden checkboxes use bound visible labels, never unrelated overlays or replacements`, async () => {
    const { pageHelper } = await import(pageModule);
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
      await page.evaluate(() => { globalThis.__domagentDocumentNonce = 'fixture-document'; });
      const run = (operation, args = {}) => runHelper(page, pageHelper, operation, args);
      const diagnostic = await run('inspect_element', { selector: '#styled' });
      expect(diagnostic.reason).toBe('CSS_HIDDEN');
      expect(diagnostic.activation).toMatchObject({ kind: 'associated_label', id: 'styled-label', name: 'Show navigation' });
      let preview = await run('prepare_action', { selector: '#styled', action: 'set_checked' });
      expect(await run('set_checked', { selector: '#styled', checked: true, approval_token: preview.approval_token }))
        .toMatchObject({ checked: true });
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
      await page.locator('#site-overlay').evaluate(element => element.remove());
      await page.locator('#styled').evaluate(element => { element.disabled = true; });
      expect(await run('set_checked', { selector: '#styled', checked: true })).toEqual({ error: 'ELEMENT_DISABLED' });
      await page.locator('#styled').evaluate(element => { element.disabled = false; });
      expect(await run('set_checked', { selector: '#inside', checked: true })).toEqual({ error: 'ELEMENT_NOT_VISIBLE' });
      preview = await run('prepare_action', { selector: '#styled', action: 'set_checked' });
      await page.locator('#styled-label').evaluate(element => { element.htmlFor = 'other'; });
      expect(await run('set_checked', { selector: '#styled', checked: true, approval_token: preview.approval_token }))
        .toEqual({ error: 'ELEMENT_STALE' });
      await expect(page.locator('#other')).not.toBeChecked();
      await page.locator('#styled-label').evaluate(element => { element.htmlFor = 'styled'; });
      preview = await run('prepare_action', { selector: '#styled', action: 'set_checked' });
      await page.locator('#styled-label').evaluate(element => {
        const replacement = element.cloneNode(true);
        element.replaceWith(replacement);
      });
      expect(await run('set_checked', { selector: '#styled', checked: true, approval_token: preview.approval_token }))
        .toEqual({ error: 'ELEMENT_STALE' });
      await expect(page.locator('#styled')).not.toBeChecked();
    } finally { await browser.close(); }
  });

  test(`${name}: inspector reports bounded hiding ancestors and explicit reveal controls without mutating`, async () => {
    const { pageHelper } = await import(pageModule);
    const browser = await launchBrowser(engine);
    try {
      const page = await browser.newPage();
      await page.setContent('<button id="toggle" aria-controls="drawer" aria-expanded="false">Open navigation</button>' +
        '<div id="drawer" style="display:none"><input id="secret" value="private-input">' +
        '<button id="logout">Logout</button></div>');
      await page.evaluate(() => { globalThis.__domagentDocumentNonce = 'fixture-document'; });
      const before = await page.evaluate(() => ({ focus: document.activeElement.tagName, x: scrollX, y: scrollY }));
      const result = await runHelper(page, pageHelper, 'inspect_element', { selector: '#logout' });
      expect(result.hidden_by).toMatchObject({ id: 'drawer', reason: 'DISPLAY_NONE', is_target: false });
      expect(result.reveal_controls).toEqual([{ tag: 'button', id: 'toggle', role: 'button',
        name: 'Open navigation', expanded: 'false' }]);
      expect(JSON.stringify(result)).not.toContain('private-input');
      expect(Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(result) }] }))).toBeLessThan(4096);
      expect(await page.evaluate(() => ({ focus: document.activeElement.tagName, x: scrollX, y: scrollY }))).toEqual(before);
    } finally { await browser.close(); }
  });

  test(`${name}: read-only diagnostics and approval binding reject responsive replacements`, async () => {
    const { pageHelper } = await import(pageModule);
    const browser = await launchBrowser(engine);
    try {
      const page = await browser.newPage({ viewport: { width: 610, height: 700 } });
      await page.setContent('<style>@media(max-width:700px){#search{display:none}}#search.open{display:block}</style>' +
        '<button id="toggle">Search</button><label for="search">Search query</label><input id="search" value="private">' +
        '<button id="replace">Original action</button><div class="dup">One</div><div class="dup">Two</div>');
      await page.evaluate(() => {
        globalThis.__domagentDocumentNonce = 'fixture-document';
        document.querySelector('#toggle').onclick = () => document.querySelector('#search').classList.add('open');
      });
      const run = (operation, args = {}) => runHelper(page, pageHelper, operation, args);
      const before = await page.evaluate(() => ({ focus: document.activeElement.tagName, x: scrollX, y: scrollY }));
      const hidden = await run('inspect_element', { selector: '#search' });
      expect(hidden.reason).toBe('ZERO_SIZE');
      expect(hidden.viewport.width).toBe(610);
      expect(JSON.stringify(hidden)).not.toContain('private');
      expect(await page.evaluate(() => ({ focus: document.activeElement.tagName, x: scrollX, y: scrollY }))).toEqual(before);
      expect((await run('inspect_element', { selector: '#missing' })).state).toBe('missing');
      expect((await run('inspect_element', { selector: '.dup' })).state).toBe('ambiguous');
      await run('click', { selector: '#toggle' });
      expect((await run('inspect_element', { selector: '#search' })).state).toBe('ready');
      await page.setViewportSize({ width: 900, height: 700 });
      expect((await run('inspect_element', { selector: '#search' })).viewport.width).toBe(900);
      const preview = await run('prepare_action', { selector: '#replace', action: 'click' });
      expect(preview.name).toBe('Original action');
      await page.locator('#replace').evaluate(element => {
        element.outerHTML = '<button id="replace" onclick="globalThis.wrongAction=true">Replaced action</button>';
      });
      expect(await run('click', { selector: '#replace', approval_token: preview.approval_token })).toEqual({ error: 'ELEMENT_STALE' });
      expect(await page.evaluate(() => globalThis.wrongAction)).toBeUndefined();
      await run('release_action', { approval_token: preview.approval_token });
      await page.locator('#search').evaluate(element => {
        element.onfocus = () => { element.outerHTML = '<input id="search" value="untouched">'; };
      });
      expect(await run('type_text', { selector: '#search', text: 'must not type' })).toEqual({ error: 'ELEMENT_STALE' });
      await expect(page.locator('#search')).toHaveValue('untouched');
    } finally { await browser.close(); }
  });
}
