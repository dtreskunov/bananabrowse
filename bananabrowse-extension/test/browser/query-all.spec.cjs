const path = require('node:path');
const { createRequire } = require('node:module');
const { test, expect, chromium, firefox } = createRequire(
  path.join(__dirname, '../../../bananabrowse-mcp/package.json'),
)('@playwright/test');
const { loadPageHelper } = require('./page-helper.cjs');

for (const [name, engine] of [
  ['chrome', chromium],
  ['firefox', firefox],
]) {
  test(`${name}: query_all extracts scoped shadow DOM without focus, scrolling or ref changes`, async () => {
    const { pageHelper } = await loadPageHelper();
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = '/tmp';
    let browser;
    try {
      browser = await engine.launch({ headless: true });
      const page = await browser.newPage();
      await page.setContent(`
        <base href="https://example.test/catalog/">
        <button id="focused">Focus stays here</button>
        <article class="row"><a href="../item/1">😀Alpha</a><span class="price">$12</span><div class="shadow"></div>
          <input value="input-secret"><textarea>textarea-secret</textarea><div contenteditable>editable-secret</div>
          <span hidden>hidden-secret</span></article>
        <article class="row"><a href="javascript:void(0)">😀Beta</a><div class="shadow"></div></article>
        <article class="row" hidden><a href="/hidden">hidden row secret</a></article>
        <div id="closed"></div><iframe srcdoc="<article class=row>iframe-secret</article>"></iframe>
        <div data-bananabrowse-sharing><article class="row">extension-secret</article></div>
        <div style="height:3000px"></div>
      `);
      await page.evaluate(() => {
        for (const host of document.querySelectorAll('.shadow'))
          host.attachShadow({ mode: 'open' }).innerHTML = '<span class="shadow-price">$99</span>';
        document.querySelector('#closed').attachShadow({ mode: 'closed' }).innerHTML =
          '<article class="row">closed-secret</article>';
        document.querySelector('#focused').focus();
        scrollTo(0, 100);
      });
      const run = (operation, args = {}) =>
        page.evaluate(({ source, operation, args }) => (0, eval)(`(${source})`)(operation, args), {
          source: pageHelper.toString(),
          operation,
          args,
        });
      await run('get_page_snapshot');
      const state = () =>
        page.evaluate(() => ({
          focus: document.activeElement.id,
          x: scrollX,
          y: scrollY,
          next: globalThis.__bananabrowsePageRefs.next,
          refs: [...globalThis.__bananabrowsePageRefs.entries.keys()],
        }));
      const before = await state();
      const args = {
        selector: '.row',
        fields: {
          title: { selector: 'a' },
          href: { selector: 'a', attribute: 'href' },
          price: { selector: '.price' },
          shadow: { selector: '.shadow-price' },
          password: { selector: 'input' },
          text: { selector: ':scope' },
        },
      };
      const result = await run('query_all', args);
      expect(result.matched_count).toBe(2);
      expect(result.returned_count).toBe(2);
      expect(result.rows[0]).toMatchObject({
        title: '😀Alpha',
        href: 'https://example.test/item/1',
        price: '$12',
        shadow: '$99',
        password: null,
      });
      expect(result.rows[1]).toMatchObject({ title: '😀Beta', href: null, price: null, shadow: '$99', password: null });
      expect(result.field_issues).toContainEqual({ row: 0, field: 'password', reason: 'redacted' });
      expect(result.field_issues).toContainEqual({ row: 1, field: 'href', reason: 'unsupported_url' });
      for (const secret of [
        'input-secret',
        'textarea-secret',
        'editable-secret',
        'hidden-secret',
        'iframe-secret',
        'closed-secret',
        'extension-secret',
      ])
        expect(JSON.stringify(result)).not.toContain(secret);
      expect(await state()).toEqual(before);
      const unicode = await run('query_all', {
        selector: '.row',
        fields: { title: { selector: 'a' } },
        max_text_chars: 1,
        limit: 1,
      });
      expect(unicode.rows).toEqual([{ title: '' }]);
      expect(unicode.rows_truncated).toBe(true);
      expect(unicode.truncated).toBe(true);
      expect(unicode.field_issues).toEqual([{ row: 0, field: 'title', reason: 'text_truncated' }]);
      const empty = await run('query_all', {
        selector: '.row',
        fields: { title: { selector: 'a' } },
        max_text_chars: 0,
      });
      expect(empty.rows).toEqual([{ title: '' }, { title: '' }]);
      expect(empty.field_issues).toHaveLength(2);
      expect(await run('query_all', { ...args, selector: '.missing' })).toEqual({ error: 'ELEMENT_NOT_FOUND' });
      expect(await run('query_all', { ...args, selector: 'article[' })).toEqual({ error: 'INVALID_SELECTOR' });
      expect(await run('query_all', { selector: '.row', fields: { bad: { selector: 'a[' } } })).toEqual({
        error: 'INVALID_SELECTOR',
        query_field: 'bad',
        row_index: 0,
      });
      expect(await run('query_all', { selector: 'body', fields: { bad: { selector: 'article.row a' } } })).toEqual({
        error: 'ELEMENT_AMBIGUOUS',
        query_field: 'bad',
        row_index: 0,
      });
    } finally {
      await browser?.close();
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
  });
}
