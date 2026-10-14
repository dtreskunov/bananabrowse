const path = require('node:path');
const fs = require('node:fs/promises');
const http = require('node:http');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../../..');
const localRequire = createRequire(path.join(root, 'domagent-mcp/package.json'));
const { test, expect, chromium, firefox } = localRequire('@playwright/test');

async function fixture(engine, colorScheme, work, firefoxPermissions) {
  // Renderer-only fixture: no mocked message can grant real browser authority.
  const assets = path.join(root, 'dist/chrome');
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (!/^\/(?:panel\.html|popup\.html|options\.html|ui\.(?:js|css)|fonts\/[\w.-]+)$/.test(pathname)) {
      res.writeHead(404); res.end(); return;
    }
    const file = path.join(assets, pathname.slice(1));
    res.setHeader('Content-Type', pathname.endsWith('.js') ? 'text/javascript' :
      pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.ttf') ? 'font/ttf' : 'text/html');
    res.end(await fs.readFile(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const previous = process.env.TMPDIR; process.env.TMPDIR = '/tmp';
  let browser;
  try {
    browser = await engine.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 320, height: 820 }, colorScheme });
    await page.addInitScript(firefoxPermissions => {
      const snapshot = {
        phase: 'authenticated', identity: { client_label: 'BananaClawz with a long assistant name' }, config: {},
        browser_info: { extension_version: '5.0.3', browser_name: 'firefox', browser_version: '157.0.1' },
        pairing: null, failures: ['OUTCOME_UNKNOWN'], current_error: 'OUTCOME_UNKNOWN', activity: [], saved_connections: [],
        last_session_end: { reason: 'CONNECTION_LOST', at: 1 }, pending_human: [],
        workspaces: [{ workspace_id: 'old-workspace', windowId: 1, groupId: 123, state: 'inactive',
          end_reason: 'WORKSPACE_CHANGED', tabs: [], acknowledged: false }],
        available_groups: [{ groupId: 456, title: 'DomAgent - BananaClawz', tab_count: 2, tab_titles: ['Invoices', 'Account'] },
          { groupId: 789, title: 'DomAgent - BananaClawz', tab_count: 1, tab_titles: ['Report'] }],
      };
      if (firefoxPermissions) snapshot.permissions = { ...firefoxPermissions };
      let render;
      globalThis.fixtureRequests = [];
      globalThis.fixturePermissions = true;
      globalThis.fixturePermissionRequests = [];
      globalThis.fixturePanelOpens = [];
      globalThis.fixtureCopied = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        async writeText(text) { fixtureCopied.push(text); },
      } });
      const port = { postMessage() {}, disconnect() {}, onMessage: { addListener(fn) { render = fn; } },
        onDisconnect: { addListener() {} } };
      globalThis.chrome = {
        windows: { async getCurrent() { return { id: 1 }; } },
        permissions: { async request(options) {
          fixturePermissionRequests.push(options);
          if (firefoxPermissions && options.permissions?.includes('userScripts') && options.origins?.length) {
            throw new Error('Cannot request permission userScripts with another permission');
          }
          if (!fixturePermissions) return false;
          if (firefoxPermissions) {
            if (options.permissions?.includes('userScripts')) snapshot.permissions.scripting = true;
            if (options.origins) snapshot.permissions.websites = true;
          }
          return true;
        } },
        sidePanel: { async open(options) { fixturePanelOpens.push(options); } },
        runtime: {
          connect() { return port; }, async openOptionsPage() {},
          async sendMessage(message) {
            fixtureRequests.push(message);
            if (message.type === 'ui.connect') snapshot.phase = 'authenticated';
            if (message.type === 'ui.configure') {
              snapshot.config = { service_origin: message.service_origin };
              snapshot.pairing = { code: 'ABCD1234', state: 'pending', expires_at: Date.now() + 300000 };
            }
            if (message.type === 'ui.confirmPairing') {
              snapshot.identity = { client_label: snapshot.pairing.proposal.client_label };
              snapshot.pairing = null; snapshot.phase = 'authenticated';
            }
            if (message.type === 'ui.pauseAll') {
              snapshot.active_workspace_count = 0;
              snapshot.workspaces = snapshot.workspaces.map(workspace => ({ ...workspace, state: 'paused', tabs: [] }));
            }
            if (message.type === 'ui.declineAccess') {
              snapshot.access_requests = snapshot.access_requests.filter(request => request.request_id !== message.request_id);
            }
            return { ok: true, value: message.type === 'ui.state' ? structuredClone(snapshot) : undefined };
          },
        },
      };
      if (firefoxPermissions) chrome.runtime.getBrowserInfo = async () => ({ name: 'Firefox', version: '153.0' });
      globalThis.updateFixture = patch => {
        Object.assign(snapshot, patch);
        render?.({ type: 'state', value: structuredClone(snapshot) });
      };
    }, firefoxPermissions);
    await page.goto(`http://127.0.0.1:${server.address().port}/panel.html`);
    await work(page, `http://127.0.0.1:${server.address().port}`);
  } finally {
    await browser?.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
  }
}

for (const [name, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${name}: agent access request is actionable in trusted popup/dashboard without auto-start`, async () => {
    await fixture(engine, 'light', async (page, origin) => {
      const pending = [{ request_id: 'access-fixture', expires_at: Date.now() + 60000,
        description: 'Review the task group before allowing this synthetic browser operation.' }];
      await page.evaluate(pending => updateFixture({ current_error: null, access_requests: pending }), pending);
      await expect(page.getByRole('heading', { name: 'Browser access requested' })).toBeVisible();
      expect(await page.evaluate(() => fixtureRequests.filter(request => ['ui.start','ui.startNew'].includes(request.type)))).toEqual([]);
      await page.goto(`${origin}/popup.html`);
      await page.evaluate(pending => updateFixture({ current_error: null, access_requests: pending }), pending);
      await expect(page.getByRole('heading', { name: 'Browser access requested' })).toBeVisible();
      await page.getByRole('button', { name: 'Decline request' }).click();
      expect(await page.evaluate(() => fixtureRequests.filter(request => request.type === 'ui.declineAccess')))
        .toEqual([{ type: 'ui.declineAccess', request_id: 'access-fixture' }]);
      await expect(page.getByRole('heading', { name: 'Browser access requested' })).toHaveCount(0);
      expect(await page.evaluate(() => fixtureRequests.filter(request => ['ui.start','ui.startNew'].includes(request.type)))).toEqual([]);
    });
  });

  test(`${name}: Firefox permission upgrade requests userScripts alone and fresh setup uses separate gestures`, async () => {
    await fixture(engine, 'light', async page => {
      await page.getByRole('combobox', { name: 'Task tabs' }).click();
      await page.getByRole('option').nth(1).click();
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      expect(await page.evaluate(() => fixturePermissionRequests)).toEqual([{ permissions: ['userScripts'] }]);
      expect(await page.evaluate(() => fixtureRequests.filter(request => request.type === 'ui.start')))
        .toEqual([{ type: 'ui.start', windowId: 1, groupId: 456 }]);
      await page.evaluate(() => {
        fixtureRequests.length = 0; fixturePermissionRequests.length = 0;
        updateFixture({ permissions: { websites: false, scripting: false } });
      });
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await expect(page.locator('#error')).toContainText('permissions separately');
      expect(await page.evaluate(() => fixtureRequests.filter(request => request.type === 'ui.start'))).toEqual([]);
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      expect(await page.evaluate(() => fixturePermissionRequests)).toEqual([
        { permissions: ['userScripts'] }, { origins: ['http://*/*', 'https://*/*'] },
      ]);
      expect(await page.evaluate(() => fixtureRequests.filter(request => request.type === 'ui.start')))
        .toEqual([{ type: 'ui.start', windowId: 1, groupId: 456 }]);
    }, { websites: true, scripting: false });
  });

  test(`${name}: Firefox pairing waits for both separate permission categories and denial never confirms trust`, async () => {
    await fixture(engine, 'light', async (page, origin) => {
      await page.goto(`${origin}/options.html`);
      await page.evaluate(() => updateFixture({ identity: null, current_error: null, workspaces: [], available_groups: [],
        pairing: { code: 'ABCD1234', state: 'proposed', expires_at: Date.now() + 300000, proposal: { client_label: 'Atlas' } } }));
      const confirm = page.getByRole('button', { name: 'Connect and start workspace' });
      await expect(confirm).toBeVisible();
      await page.evaluate(() => { fixturePermissions = false; });
      await confirm.click();
      await expect(page.locator('#error')).toContainText('permission was declined');
      expect(await page.evaluate(() => fixtureRequests.filter(request => request.type === 'ui.confirmPairing'))).toEqual([]);
      await page.evaluate(() => { fixturePermissions = true; fixturePermissionRequests.length = 0; });
      await confirm.click();
      await expect(page.locator('#error')).toContainText('permissions separately');
      expect(await page.evaluate(() => fixtureRequests.filter(request => request.type === 'ui.confirmPairing'))).toEqual([]);
      await confirm.click();
      await expect(page.getByRole('heading', { name: 'Assistant connected' })).toBeVisible();
      expect(await page.evaluate(() => fixturePermissionRequests)).toEqual([
        { permissions: ['userScripts'] }, { origins: ['http://*/*', 'https://*/*'] },
      ]);
      expect(await page.evaluate(() => fixtureRequests.filter(request => request.type === 'ui.confirmPairing')))
        .toEqual([{ type: 'ui.confirmPairing' }]);
    }, { websites: false, scripting: false });
  });

  test(`${name}: toolbar popup pauses all running groups without depending on dashboard visibility`, async () => {
    await fixture(engine, 'light', async (page, origin) => {
      await page.goto(`${origin}/popup.html`);
      await page.evaluate(() => updateFixture({ current_error: null, active_workspace_count: 2 }));
      await expect(page.getByRole('heading', { name: '2 running task groups' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Pause all tasks' })).toBeVisible();
      await page.getByRole('button', { name: 'Pause all tasks' }).click();
      expect(await page.evaluate(() => fixtureRequests.filter(request => request.type === 'ui.pauseAll')))
        .toEqual([{ type: 'ui.pauseAll' }]);
      await page.getByRole('button', { name: 'Open dashboard' }).click();
      expect(await page.evaluate(() => fixturePanelOpens)).toEqual([{ windowId: 1 }]);
      expect(await page.evaluate(() => fixtureRequests.filter(request => ['ui.start','ui.startNew'].includes(request.type)))).toEqual([]);
    });
  });

  test(`${name}: suggested handoff text is copyable without sending or completing the task`, async () => {
    await fixture(engine, 'light', async page => {
      await page.evaluate(() => updateFixture({ current_error: null, workspaces: [{
        workspace_id: 'copy-workspace', windowId: 1, groupId: 456, state: 'active', acknowledged: true,
        tabs: [{ tabId: 10, target_id: 'copy-tab', title: 'Synthetic editor', url: 'https://example.com/',
          page_state: 'ready', commands: [{ request_id: 'copy-help', operation: 'request_handoff',
            description: 'Paste this fictitious text only if the intended task still requires it.',
            suggested_text: 'Synthetic message\nSecond line', human: true, executing: false }] }],
      }] }));
      await expect(page.getByLabel('Suggested text')).toHaveValue('Synthetic message\nSecond line');
      await page.getByRole('button', { name: 'Copy text' }).click();
      expect(await page.evaluate(() => fixtureCopied)).toEqual(['Synthetic message\nSecond line']);
      expect(await page.evaluate(() => fixtureRequests.filter(request => request.type === 'ui.decision'))).toEqual([]);
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      expect(await page.evaluate(() => fixtureRequests.filter(request => request.type === 'ui.decision')))
        .toEqual([{ type: 'ui.decision', request_id: 'copy-help', action: 'done' }]);
    });
  });

  test(`${name}: independent setup keeps domain, code and final local start in one flow`, async () => {
    await fixture(engine, 'light', async (page, origin) => {
      await page.goto(`${origin}/options.html`);
      await page.evaluate(() => updateFixture({ identity: null, workspaces: [], available_groups: [], current_error: null }));
      await expect(page.getByLabel('Service domain')).toBeVisible();
      await page.getByLabel('Service domain').fill('domagent.example.org');
      await page.evaluate(() => { fixturePermissions = false; });
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await expect(page.locator('#error')).toContainText('permission was declined');
      expect(await page.evaluate(() => fixtureRequests.filter(request => request.type === 'ui.configure'))).toEqual([]);
      await page.evaluate(() => { fixturePermissions = true; });
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await expect(page.getByLabel('Pairing code')).toHaveText('ABCD1234');
      expect(await page.evaluate(() => fixtureRequests.filter(request => request.type === 'ui.configure')))
        .toEqual([{ type: 'ui.configure', service_origin: 'https://domagent.example.org' }]);
      await page.evaluate(() => updateFixture({
        pairing: { code: 'ABCD1234', state: 'proposed', expires_at: Date.now() + 300000, proposal: { client_label: 'Atlas' } },
      }));
      await expect(page.getByRole('button', { name: 'Connect and start workspace' })).toBeVisible();
      expect(await page.evaluate(() => fixtureRequests.filter(request => request.type === 'ui.confirmPairing'))).toEqual([]);
      await page.getByRole('button', { name: 'Connect and start workspace' }).click();
      await expect(page.getByRole('heading', { name: 'Assistant connected' })).toBeVisible();
      expect(await page.evaluate(() => fixtureRequests.filter(request => ['ui.confirmPairing', 'ui.start'].includes(request.type))))
        .toEqual([{ type: 'ui.confirmPairing' }, { type: 'ui.start', windowId: 1 }]);
      expect(await page.evaluate(() => fixturePanelOpens)).toEqual([]);
      expect(await page.evaluate(() => fixturePermissionRequests.at(-1))).toEqual({ origins: ['http://*/*', 'https://*/*'] });
    });
  });
  for (const colorScheme of ['light', 'dark']) {
    test(`${name}: ${colorScheme} 320px task UI keeps recovery, explicit consent and keyboard focus stable`, async ({}, info) => {
      await fixture(engine, colorScheme, async page => {
        await expect(page.getByRole('heading', { name: 'Choose a task' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
        const selector = page.getByRole('combobox', { name: 'Task tabs' });
        await selector.focus(); await selector.press('ArrowDown'); await selector.press('ArrowDown'); await selector.press('Enter');
        await expect(selector).toContainText('2 tabs');
        expect(await page.evaluate(() => fixtureRequests.filter(request => request.type !== 'ui.state'))).toEqual([]);
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
        expect(await page.evaluate(() => fixtureRequests.filter(request => request.type === 'ui.start')))
          .toEqual([{ type: 'ui.start', windowId: 1, groupId: 456 }]);
        await page.screenshot({ path: info.outputPath('task-recovery.png'), fullPage: true });
        await page.evaluate(() => updateFixture({
          current_error: null,
          workspaces: [{ workspace_id: 'new-workspace', windowId: 1, groupId: 456, state: 'active', tabs: [], acknowledged: false }],
        }));
        await expect(page.getByRole('heading', { name: 'Starting task' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Pause', exact: true })).toHaveCount(0);
        await page.evaluate(() => updateFixture({ workspaces: [{
          workspace_id: 'new-workspace', windowId: 1, groupId: 456, state: 'active', acknowledged: true,
          tabs: [{ tabId: 10, target_id: 'tab-1', title: 'Invoice summary with a long page title', url: 'https://example.com/report',
            page_state: 'ready', commands: [] }],
        }] }));
        await expect(page.getByRole('heading', { name: 'Ready', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
        await expect(page.locator('#error')).toBeEmpty();
        await expect(selector).toBeDisabled();
        await expect(page.locator('main')).not.toContainText('#456');
        await expect(page.locator('main')).not.toContainText('connection ended');
        await page.screenshot({ path: info.outputPath('task-active.png'), fullPage: true });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const actions = page.getByRole('button', { name: 'Task actions' });
        await actions.click(); await page.getByRole('menuitem', { name: 'Diagnostics' }).focus();
        await page.keyboard.press('Escape'); await expect(actions).toBeFocused();
        await actions.click(); await page.getByRole('menuitem', { name: 'Diagnostics' }).click();
        await expect(page.locator('#historical-errors')).toContainText('OUTCOME_UNKNOWN');
        await expect(page.locator('#historical-errors')).toContainText('before repeating');
        await page.getByRole('button', { name: 'Back to task' }).click();
        await expect(actions).toBeFocused();
        await page.evaluate(() => updateFixture({ workspaces: [{
          workspace_id: 'new-workspace', windowId: 1, groupId: 456, state: 'active', acknowledged: true,
          tabs: [{ tabId: 10, target_id: 'tab-1', title: 'Invoice', url: 'https://example.com/report', page_state: 'ready',
            commands: [{ request_id: 'help-1', operation: 'request_handoff', description: 'Check the current document before confirming the task is done.',
              human: true, executing: false }] }],
        }] }));
        await expect(page.getByRole('heading', { name: 'Needs your help', level: 2 })).toBeVisible();
        await page.getByRole('button', { name: 'Go to task', exact: true }).click();
        expect(await page.evaluate(() => fixtureRequests.filter(request => request.type === 'ui.focus')))
          .toEqual([{ type: 'ui.focus', workspace_id: 'new-workspace', tabId: 10 }]);
        expect(await page.evaluate(() => fixtureRequests.filter(request => request.type === 'ui.decision'))).toEqual([]);
        await page.getByRole('button', { name: 'Done', exact: true }).click();
        expect(await page.evaluate(() => fixtureRequests.filter(request => request.type === 'ui.decision')))
          .toEqual([{ type: 'ui.decision', request_id: 'help-1', action: 'done' }]);
        await page.evaluate(() => updateFixture({ workspaces: [{
          workspace_id: 'new-workspace', windowId: 1, groupId: 456, state: 'active', acknowledged: true, tabs: [],
        }] }));
        await page.getByRole('button', { name: 'Pause', exact: true }).click();
        expect(await page.evaluate(() => fixtureRequests.filter(request => request.type === 'ui.pause')))
          .toEqual([{ type: 'ui.pause', workspace_id: 'new-workspace' }]);
        await page.evaluate(() => updateFixture({ workspaces: [{
          workspace_id: 'new-workspace', windowId: 1, groupId: 456, state: 'paused', acknowledged: false, tabs: [],
        }] }));
        await expect(page.getByRole('heading', { name: 'Paused by you' })).toBeVisible();
        await page.getByRole('button', { name: 'Continue', exact: true }).focus();
        await page.evaluate(() => updateFixture({ activity: [{ id: 'event-1', event: 'connected', time: 1 }] }));
        await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeFocused();
        await page.evaluate(() => updateFixture({ phase: 'connecting' }));
        await expect(page.getByRole('button', { name: 'Continue', exact: true })).toHaveCount(0);
        await page.evaluate(() => updateFixture({ phase: 'disconnected' }));
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
        const reconnect = await page.evaluate(() => fixtureRequests.filter(request => request.type !== 'ui.state').slice(-2));
        expect(reconnect).toEqual([{ type: 'ui.connect' }, { type: 'ui.start', windowId: 1, groupId: 456 }]);
        await actions.click(); await page.getByRole('menuitem', { name: 'End session' }).click();
        expect(await page.evaluate(() => fixtureRequests.filter(request => request.type === 'ui.end')))
          .toEqual([{ type: 'ui.end', workspace_id: 'new-workspace' }]);
        await page.evaluate(() => updateFixture({ workspaces: [], available_groups: [] }));
        await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
        await page.evaluate(() => { fixturePermissions = false; });
        await page.getByRole('button', { name: 'Start', exact: true }).click();
        await expect(page.locator('#error')).toContainText('permission was declined');
        expect(await page.evaluate(() => fixtureRequests.filter(request => request.type === 'ui.startNew'))).toEqual([]);
        await page.evaluate(() => { fixturePermissions = true; });
        await page.getByRole('button', { name: 'Start', exact: true }).click();
        expect(await page.evaluate(() => fixtureRequests.filter(request => request.type === 'ui.startNew')))
          .toEqual([{ type: 'ui.startNew', windowId: 1 }]);
      });
    });
  }
}
