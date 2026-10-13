const path = require('node:path');
const fs = require('node:fs/promises');
const http = require('node:http');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../../..');
const localRequire = createRequire(path.join(root, 'domagent-mcp/package.json'));
const { test, expect, chromium, firefox } = localRequire('@playwright/test');

for (const [name, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${name}: inactive empty sidebar always exposes safe group recovery outside its tab rows`, async () => {
    // Renderer-only fixture. The fake runtime cannot grant production browser authority.
    const assets = path.join(root, 'dist/chrome');
    const server = http.createServer(async (req, res) => {
      const file = ['panel.html', 'ui.css', 'ui.js'].find(file => req.url === `/${file}`);
      if (!file) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(await fs.readFile(path.join(assets, file)));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = '/tmp';
    let browser;
    try {
      browser = await engine.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 320, height: 820 } });
      await page.addInitScript(() => {
        const snapshot = {
          phase: 'authenticated', identity: { client_label: 'BananaClawz' }, config: {},
          browser_info: { extension_version: '5.0.3', browser_name: 'firefox', browser_version: '157.0.1' },
          failures: ['OUTCOME_UNKNOWN'], current_error: 'OUTCOME_UNKNOWN', activity: [], saved_connections: [],
          last_session_end: null, pending_human: [],
          workspaces: [{ workspace_id: 'old-workspace', windowId: 1, groupId: 123, state: 'inactive',
            end_reason: 'WORKSPACE_CHANGED', tabs: [] }],
          available_groups: [{ groupId: 456, title: 'DomAgent - BananaClawz' },
            { groupId: 789, title: 'DomAgent - BananaClawz' }],
        };
        let render;
        globalThis.fixtureRequests = [];
        const port = { postMessage() {}, disconnect() {}, onMessage: { addListener(fn) { render = fn; } },
          onDisconnect: { addListener() {} } };
        globalThis.chrome = {
          windows: { async getCurrent() { return { id: 1 }; } },
          permissions: { async request() { return true; } },
          runtime: {
            connect() { return port; }, async openOptionsPage() {},
            async sendMessage(message) {
              fixtureRequests.push(message);
              return { ok: true, value: message.type === 'ui.state' ? snapshot : undefined };
            },
          },
        };
        globalThis.updateFixture = patch => {
          Object.assign(snapshot, patch);
          render({ type: 'state', value: snapshot });
        };
      });
      await page.goto(`http://127.0.0.1:${server.address().port}/panel.html`);
      await expect(page.getByRole('button', { name: 'Start a new task group', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: /Use existing DomAgent/ })).toHaveCount(2);
      await expect(page.getByRole('button', { name: 'Resume workspace' })).toHaveCount(0);
      await expect(page.locator('#targets')).toContainText('No tabs are being controlled');
      await page.getByRole('button', { name: /Use existing.*#456/ }).click();
      expect(await page.evaluate(() => fixtureRequests.filter(request => request.type !== 'ui.state')))
        .toEqual([{ type: 'ui.start', windowId: 1, groupId: 456 }]);
      await page.getByRole('button', { name: 'Start a new task group', exact: true }).click();
      expect(await page.evaluate(() => fixtureRequests.filter(request => request.type === 'ui.startNew')))
        .toEqual([{ type: 'ui.startNew', windowId: 1 }]);
      await page.getByRole('button', { name: 'End session', exact: true }).click();
      expect(await page.evaluate(() => fixtureRequests.filter(request => request.type === 'ui.end')))
        .toEqual([{ type: 'ui.end', workspace_id: 'old-workspace' }]);
      await page.evaluate(() => updateFixture({ workspaces: [] }));
      await expect(page.getByRole('button', { name: 'Start browsing with your assistant' })).toBeVisible();
      await expect(page.getByRole('button', { name: /Use existing DomAgent/ })).toHaveCount(2);
      await page.evaluate(() => updateFixture({
        current_error: null,
        workspaces: [{ workspace_id: 'new-workspace', windowId: 1, groupId: 456, state: 'active', tabs: [] }],
      }));
      await expect(page.locator('#error')).toBeEmpty();
      await expect(page.getByRole('button', { name: 'Pause all' })).toBeVisible();
      await expect(page.getByRole('button', { name: /Use existing DomAgent/ })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Start a new task group' })).toHaveCount(0);
      await expect(page.locator('#historical-errors')).toContainText('OUTCOME_UNKNOWN');
    } finally {
      await browser?.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    }
  });
}
