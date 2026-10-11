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
  test(`${name}: own sharing banner must not obstruct approved DOM text-input actions`, async () => {
    const { pageHelper, sharingIndicator } = await import(pageModule);
    const browser = await launchBrowser(engine);
    try {
      const page = await browser.newPage({ viewport: { width: 500, height: 700 } });
      await page.setContent('<div style="position:fixed;right:20px;top:25px;width:200px">' +
        '<input id="text" style="width:200px"><input id="time" type="time"><textarea id="area"></textarea></div>');
      await page.evaluate(() => {
        globalThis.chrome = { runtime: { sendMessage: async () => ({ ok: true }) } };
        globalThis.__domagentDocumentNonce = 'fixture-document';
      });
      await page.evaluate(sharingIndicator, {
        target_id: 'fixture-target', token: 'fixture-token', label: 'Fixture agent',
        command: { request_id: 'fixture-request', operation: 'type_text',
          description: 'Fill the explicitly shared field', state: 'executing' },
      });
      for (const type of ['text', 'tel', 'email', 'search']) {
        await page.locator('#text').evaluate((element, type) => { element.type = type; element.blur(); }, type);
        expect(await runHelper(page, pageHelper, 'click', { selector: '#text' })).toMatchObject({ clicked: true });
        await expect(page.locator('#text')).toBeFocused();
        expect(await runHelper(page, pageHelper, 'type_text', {
          selector: '#text', text: 'fixture@example.org',
        })).toMatchObject({ typed: true });
        await expect(page.locator('#text')).toHaveValue('fixture@example.org');
        await expect(page.locator('[data-domagent-sharing]')).toBeVisible();
      }
      await page.evaluate(() => {
        const cover = document.createElement('div');
        cover.style.cssText = 'position:fixed;inset:0;background:#eee;z-index:100';
        document.body.append(cover);
      });
      expect(await runHelper(page, pageHelper, 'type_text', {
        selector: '#text', text: 'must not bypass',
      })).toEqual({ error: 'ELEMENT_OBSCURED' });
      await expect(page.locator('#text')).toHaveValue('fixture@example.org');
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
