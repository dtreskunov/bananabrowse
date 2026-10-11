const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const fs = require('node:fs/promises');
const localRequire = createRequire(path.join(__dirname, '../../../domagent-mcp/package.json'));
const { test, expect, chromium, firefox } = localRequire('@playwright/test');
const pageModule = pathToFileURL(path.resolve(__dirname, '../../src/page.js')).href;

for (const [name, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${name}: own sharing banner must not obstruct approved DOM text-input actions`, async () => {
    const { pageHelper, sharingIndicator } = await import(pageModule);
    const artifacts = path.resolve(__dirname, '../../.browser-artifacts', `page-actions-${name}`);
    await fs.mkdir(artifacts, { recursive: true });
    const oldTempDir = process.env.TMPDIR;
    process.env.TMPDIR = artifacts;
    let browser;
    try {
      browser = await engine.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 500, height: 700 } });
      await page.setContent('<div style="position:fixed;right:20px;top:25px;width:200px">' +
        '<input id="text" style="width:200px"><input id="time" type="time">' +
        '<textarea id="area"></textarea></div>');
      await page.evaluate(() => {
        globalThis.chrome = { runtime: { sendMessage: async () => ({ ok: true }) } };
        globalThis.__domagentDocumentNonce = 'fixture-document';
      });
      await page.evaluate(sharingIndicator, {
        target_id: 'fixture-target', token: 'fixture-token', label: 'Fixture agent',
        command: { request_id: 'fixture-request', operation: 'type_text',
          description: 'Fill the explicitly shared field', state: 'executing' },
      });
      const run = (operation, args = {}) => page.evaluate(({ source, operation, args }) =>
        (0, eval)(`(${source})`)(operation, args), { source: pageHelper.toString(), operation, args });
      for (const type of ['text', 'tel', 'email', 'search']) {
        await page.locator('#text').evaluate((element, value) => { element.type = value; }, type);
        await page.locator('#text').evaluate(element => element.blur());
        const click = await run('click', { selector: '#text' });
        expect(click).toMatchObject({ clicked: true });
        await expect(page.locator('#text')).toBeFocused();
        const document = await run('inspect');
        const fill = await run('type_text', {
          selector: '#text', text: 'fixture@example.org', document_nonce: document.document_nonce,
        });
        expect(fill).toMatchObject({ typed: true });
        await expect(page.locator('#text')).toHaveValue('fixture@example.org');
        await expect(page.locator('[data-domagent-sharing]')).toBeVisible();
      }
      await page.evaluate(() => {
        const cover = document.createElement('div');
        cover.id = 'site-cover';
        cover.style.cssText = 'position:fixed;inset:0;background:#eee;z-index:100';
        document.body.append(cover);
      });
      const blocked = await run('type_text', { selector: '#text', text: 'must not bypass' });
      expect(blocked).toEqual({ error: 'ELEMENT_OBSCURED' });
      await expect(page.locator('#text')).toHaveValue('fixture@example.org');
      await expect(page.locator('[data-domagent-sharing]')).toBeVisible();
    } finally {
      if (browser) await browser.close();
      if (oldTempDir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = oldTempDir;
      await fs.rm(artifacts, { recursive: true, force: true });
    }
  });
}
