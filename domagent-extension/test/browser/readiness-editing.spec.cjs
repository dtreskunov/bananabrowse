const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const requireLocal = createRequire(path.join(__dirname, '../../../domagent-mcp/package.json'));
const { test, expect, chromium, firefox } = requireLocal('@playwright/test');

for (const [name, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${name}: visible content readiness distinguishes delayed rows, empty state and invalid selectors`, async () => {
    const { pageHelper } = await import(pathToFileURL(path.resolve(__dirname, '../../src/page.js')).href);
    const previous = process.env.TMPDIR; process.env.TMPDIR = '/tmp';
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent('<div id="loading">Loading...</div><div id="rows"></div><div id="empty" hidden>No items</div>');
      const run = selector => page.evaluate(({ source, selector }) => (0, eval)(`(${source})`)(
        'content_readiness', { selector }), { source: pageHelper.toString(), selector });
      expect(await run('#rows article, #empty:not([hidden])')).toEqual({ ready: false });
      await page.evaluate(() => { document.querySelector('#rows').innerHTML = '<article>Ready row</article><article>Second row</article>'; });
      expect(await run('#rows article')).toEqual({ ready: true });
      await page.evaluate(() => { document.querySelector('#rows').innerHTML = ''; document.querySelector('#empty').hidden = false; });
      expect(await run('#rows article, #empty:not([hidden])')).toEqual({ ready: true });
      expect(await run('article[')).toEqual({ error: 'INVALID_SELECTOR' });
    } finally {
      await browser.close();
      if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    }
  });

  test(`${name}: native contenteditable editing updates managed state and detects delayed rollback without native keystrokes`, async () => {
    const { pageHelper } = await import(pathToFileURL(path.resolve(__dirname, '../../src/page.js')).href);
    const previous = process.env.TMPDIR; process.env.TMPDIR = '/tmp';
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent('<div id="editor" contenteditable="true">Original</div><input id="rollback" value="Original"><input id="cancel" value="Original">');
      await page.evaluate(() => {
        globalThis.editorState = 'Original';
        document.querySelector('#editor').addEventListener('input', event => {
          if (event instanceof InputEvent && event.inputType) editorState = event.target.textContent;
          setTimeout(() => { event.target.textContent = editorState; }, 20);
        });
        document.querySelector('#rollback').addEventListener('input', event => setTimeout(() => { event.target.value = 'Original'; }, 20));
        document.querySelector('#cancel').addEventListener('beforeinput', event => event.preventDefault());
      });
      const run = (selector, text) => page.evaluate(({ source, selector, text }) => (0, eval)(`(${source})`)(
        'type_text', { selector, text }), { source: pageHelper.toString(), selector, text });
      expect(await run('#editor', 'Updated rich text')).toEqual({
        typed: true, input_mode: 'dom_editing', verification: 'dom_after_reconciliation',
      });
      expect(await page.evaluate(() => editorState)).toBe('Updated rich text');
      expect(await run('#rollback', 'Must not claim success')).toEqual({ error: 'INPUT_NOT_APPLIED' });
      expect(await run('#cancel', 'Must not overwrite')).toEqual({ error: 'INPUT_REJECTED' });
      await expect(page.locator('#cancel')).toHaveValue('Original');
    } finally {
      await browser.close();
      if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    }
  });
}
