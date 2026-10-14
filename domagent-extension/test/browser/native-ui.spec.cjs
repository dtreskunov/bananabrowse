const path = require('node:path');
const fs = require('node:fs/promises');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const requireLocal = createRequire(path.join(__dirname, '../../../domagent-mcp/package.json'));
const { test, expect, chromium, firefox } = requireLocal('@playwright/test');
const root = path.resolve(__dirname, '../../..');

for (const [name, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${name}: native system typography/theme and spacious session feed keep status/allow-all clear at320px`, async ({}, info) => {
    const server = http.createServer(async (req, res) => {
      const file = req.url?.slice(1);
      if (!['panel.html','ui.css','ui.js'].includes(file)) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(await fs.readFile(path.join(root, 'dist/chrome', file)));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const previous = process.env.TMPDIR; process.env.TMPDIR = '/tmp';
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 320, height: 900 }, colorScheme: 'dark' });
      await page.addInitScript(() => {
        const feed = [
          { id: 'grant', operation: 'workspace_approval', description: 'All actions in this task group are allowed until you Pause or End.', status: 'approved', policy: 'allow_all' },
          { id: 'read', operation: 'get_page_snapshot', description: 'Read the page summary to find the requested details without exposing unrelated fields.', status: 'complete', title: 'Example document', policy: 'allow_all' },
          { id: 'run', operation: 'get_text', description: 'Checking the next page section and preparing a concise summary for you.', status: 'running', title: 'Example document', policy: 'allow_all' },
        ].map((entry, index) => ({ ...entry, time: Date.now() + index, updated_at: Date.now(), windowId: 1, workspace_id: 'task' }));
        const state = { phase: 'authenticated', config: {}, identity: { client_label: 'Test agent' }, pairing: null,
          failures: [], current_error: null, activity: [], saved_connections: [], activity_feed: feed,
          workspaces: [{ workspace_id: 'task', windowId: 1, groupId: 42, state: 'active', acknowledged: true,
            tabs: [{ target_id: 'example-tab', tabId: 55, title: 'Example document', url: 'https://example.com/report', page_state: 'ready', commands: [] }] }],
          available_groups: [{ groupId: 42, title: 'DomAgent - Test agent', tab_count: 1 }] };
        const theme = { colors: { sidebar: '#20242a', sidebar_text: '#eef2f6', sidebar_border: '#414850',
          sidebar_highlight: '#80b7f0', sidebar_highlight_text: '#18222c' }, properties: { color_scheme: 'dark' } };
        globalThis.themeListener = null;
        globalThis.stateListener = null;
        globalThis.chrome = { windows: { async getCurrent() { return { id: 1 }; } },
          theme: { async getCurrent() { return theme; }, onUpdated: { addListener(fn) { themeListener = fn; } } },
          runtime: { async sendMessage() { return { ok: true, value: structuredClone(state) }; },
            connect() { return { postMessage() {}, disconnect() {}, onMessage: { addListener(fn) { stateListener = fn; } }, onDisconnect: { addListener() {} } }; } } };
        globalThis.changeTheme = theme => themeListener({ windowId: 1, theme });
        globalThis.showRetainedHandoff = () => {
          state.workspaces[0].tabs[0].commands = [{ request_id: 'help', operation: 'request_handoff',
            description: 'Please inspect this retained human request before confirming completion.',
            human: true, executing: false, suggested_text: 'Synthetic copyable handoff text' }];
          state.activity_feed = [{ ...feed[0], id: 'help', operation: 'request_handoff', status: 'needs_help' },
            ...Array.from({ length: 150 }, (_, index) => ({ ...feed[1], id: `retained-${index}` }))];
          stateListener({ type: 'state', value: structuredClone(state) });
        };
      });
      await page.goto(`http://127.0.0.1:${server.address().port}/panel.html`);
      await expect(page.getByRole('region', { name: 'Agent activity' })).toBeVisible();
      await expect(page.locator('.feed-card')).toHaveCount(3);
      await expect(page.locator('.feed-status')).toHaveText(['Running','Complete','Approved']);
      await expect(page.locator('.policy-chip')).toHaveCount(3);
      expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).not.toContain('Figtree');
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(32, 36, 42)');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath('native-dark-feed.png'), fullPage: true });
      await page.evaluate(() => changeTheme({ colors: { sidebar: '#f5f6f7', sidebar_text: '#20242a' }, properties: { color_scheme: 'light' } }));
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(245, 246, 247)');
      await page.screenshot({ path: info.outputPath('native-light-feed.png'), fullPage: true });
      await page.evaluate(() => changeTheme({}));
      expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--surface'))).toBe('');
      await page.evaluate(() => showRetainedHandoff());
      await expect(page.locator('.feed-card')).toHaveCount(101);
      await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
    } finally {
      await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    }
  });

  test(`${name}: noninteractive controlled-page frame does not change layout/clicks and is removable`, async () => {
    const { controlFrame } = await import(pathToFileURL(path.join(root, 'domagent-extension/src/control-frame.js')).href);
    const previous = process.env.TMPDIR; process.env.TMPDIR = '/tmp';
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent('<button id="action">Underlying action</button>');
      await page.evaluate(() => { globalThis.clicks = 0; document.querySelector('#action').onclick = () => clicks++; });
      const before = await page.locator('#action').boundingBox();
      await page.addStyleTag({ path: path.join(root, 'domagent-extension/src/control-frame.css') });
      const run = visible => page.evaluate(({ source, visible }) => (0, eval)(`(${source})`)(visible), { source: controlFrame.toString(), visible });
      expect((await run(true)).visible).toBe(true);
      expect(await page.locator('#action').boundingBox()).toEqual(before);
      expect(await page.locator('[data-domagent-control-frame]').evaluate(element => getComputedStyle(element).pointerEvents)).toBe('none');
      await page.locator('#action').click(); expect(await page.evaluate(() => clicks)).toBe(1);
      await run(false); await expect(page.locator('[data-domagent-control-frame]')).toHaveCount(0);
    } finally {
      await browser.close();
      if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    }
  });
}
