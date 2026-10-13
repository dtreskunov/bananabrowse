const path = require('node:path');
const fs = require('node:fs/promises');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const https = require('node:https');
const http = require('node:http');
const root = path.resolve(__dirname, '../../..');
const localRequire = createRequire(path.join(root, 'domagent-mcp/package.json'));
const { test, expect, chromium } = localRequire('@playwright/test');
const { Client } = localRequire('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = localRequire('@modelcontextprotocol/sdk/client/streamableHttp.js');
const description = 'Read or change this explicitly authorized disposable browser fixture';

test('v5 Chrome actual service: reverse pairing, native lease, background group commands and safe teardown', async () => {
  test.setTimeout(120000);
  const { Store } = await import(pathToFileURL(path.join(root, 'domagent-mcp/store.js')).href);
  const { createApp } = await import(pathToFileURL(path.join(root, 'domagent-mcp/app.js')).href);
  const directory = path.join(root, 'domagent-extension/.browser-artifacts/v5-service');
  await fs.mkdir(directory, { recursive: true });
  const extension = path.join(directory, 'extension');
  await fs.cp(path.join(root, 'dist/chrome'), extension, { recursive: true });
  const manifestPath = path.join(extension, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (process.env.DOMAGENT_OPTIONAL_PERMISSIONS !== '1') manifest.host_permissions = ['http://*/*', 'https://*/*'];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', path.join(directory, 'key.pem'), '-out', path.join(directory, 'cert.pem'),
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  let app;
  const tls = https.createServer({ key: await fs.readFile(path.join(directory, 'key.pem')),
    cert: await fs.readFile(path.join(directory, 'cert.pem')) }, (req, res) => app.server.listeners('request')[0](req, res));
  tls.on('upgrade', (req, socket, head) => app.bridge.upgrade(req, socket, head));
  await new Promise(resolve => tls.listen(0, '127.0.0.1', resolve));
  const origin = `https://127.0.0.1:${tls.address().port}`;
  const store = new Store(':memory:');
  const clientInfo = store.createClient('Atlas');
  app = createApp(store, { origin, bind: '127.0.0.1', port: 0, protectedOrigins: [origin] });
  const address = await app.listen();
  const pageServer = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<h1>Disposable background task</h1><label>Nickname<input id="nickname"></label><button id="button">Click me</button>');
  });
  await new Promise(resolve => pageServer.listen(0, '127.0.0.1', resolve));
  const pageUrl = `http://127.0.0.1:${pageServer.address().port}/`;
  let context, client;
  const previousTmp = process.env.TMPDIR; process.env.TMPDIR = '/tmp';
  try {
    context = await chromium.launchPersistentContext(path.join(directory, 'profile'), {
      channel: 'chromium', headless: true, ignoreHTTPSErrors: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--ignore-certificate-errors', '--no-sandbox'],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    context.on('console', message => { if (message.type() === 'error' || message.text().startsWith('DomAgent panel')) console.error('Fixture extension:', message.text()); });
    const options = await context.newPage();
    await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
    const request = message => options.evaluate(message => chrome.runtime.sendMessage(message), message).then(response => {
      if (!response.ok) throw new Error(response.error.code);
      return response.value;
    });
    const state = () => request({ type: 'ui.state' });
    if (process.env.DOMAGENT_OPTIONAL_PERMISSIONS === '1') {
      await options.locator('#domain').fill(origin);
      await options.getByRole('button', { name: 'Continue', exact: true }).click();
      await expect(options.locator('#error')).toContainText('permission was declined');
      expect((await state()).pairing).toBe(null);
      expect((await state()).workspaces).toHaveLength(0);
      return;
    } else await request({ type: 'ui.configure', service_origin: origin });
    await expect.poll(async () => (await state()).pairing?.code).toBeTruthy();
    client = new Client({ name: 'v5-browser-fixture', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp/${clientInfo.tenant_id}`), {
      requestInit: { headers: { Authorization: `Bearer ${clientInfo.credential}` } },
    }));
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(21);
    expect((await client.callTool({ name: 'adopt_browser', arguments: { pairing_code: (await state()).pairing.code } })).isError).not.toBe(true);
    await expect.poll(async () => (await state()).pairing?.state).toBe('proposed');
    if (process.env.DOMAGENT_OPTIONAL_PERMISSIONS === '1') {
      await options.getByRole('button', { name: 'Connect and start workspace', exact: true }).click();
    } else await request({ type: 'ui.confirmPairing' });
    await expect.poll(async () => (await state()).phase).toBe('authenticated');
    expect((await state()).workspaces).toHaveLength(0);
    if (process.env.DOMAGENT_OPTIONAL_PERMISSIONS !== '1') await options.getByRole('button', { name: 'Open workspace sidebar' }).click();
    const windowId = await options.evaluate(() => chrome.windows.getCurrent().then(window => window.id));
    await new Promise(resolve => setTimeout(resolve, 500));
    if (process.env.DOMAGENT_OPTIONAL_PERMISSIONS !== '1') await request({ type: 'ui.start', windowId });
    else await expect.poll(async () => (await state()).workspaces[0]?.state).toBe('active');
    const first = (await state()).workspaces[0];
    await expect.poll(async () => (await app.bridge.listWorkspaces(clientInfo.id, clientInfo.tenant_id)[0]?.workspaces[0]?.tab_count)).toBe(1);
    const listing = async () => JSON.parse((await client.callTool({ name: 'list_workspace_tabs',
      arguments: { workspace_id: first.workspace_id } })).content[0].text);
    const call = (name, args) => client.callTool({ name, arguments: { ...args, description } });
    const blank = (await listing())[0];
    expect(blank.page_state).toBe('navigation_only');
    expect((await call('navigate', { target_id: blank.target_id, url: pageUrl })).isError).not.toBe(true);
    await expect.poll(async () => (await listing())[0]?.page_state).toBe('ready');
    const created = await call('create_workspace_tab', { workspace_id: first.workspace_id, url: pageUrl });
    expect(created.isError).not.toBe(true);
    const second = JSON.parse(created.content[0].text);
    await expect.poll(async () => (await listing()).length).toBe(2);
    await expect.poll(async () => (await listing()).find(tab => tab.target_id === second.target_id)?.page_state).toBe('ready');
    const unshared = await options.evaluate(url => chrome.tabs.create({ url, active: true }), pageUrl);
    const results = await Promise.all([blank.target_id, second.target_id].map(target_id =>
      call('get_text', { target_id, selector: 'h1' })));
    for (const result of results) expect(JSON.stringify(result)).toContain('Disposable background task');
    expect((await listing()).some(tab => tab.tab_id === unshared.id)).toBe(false);
    await worker.evaluate(() => {
      const original = chrome.scripting.executeScript.bind(chrome.scripting);
      chrome.scripting.executeScript = args => args.args?.[0] === 'inspect'
        ? Promise.reject(new Error('Missing host permission for fixture renderer'))
        : original(args);
      globalThis.restoreFixtureInspection = () => { chrome.scripting.executeScript = original; };
    });
    const refused = JSON.parse((await call('get_text', { target_id: blank.target_id, selector: 'h1' })).content[0].text);
    expect(refused).toMatchObject({ error: 'DOCUMENT_NOT_CONTROLLABLE', injection_reason: 'permission_denied' });
    const retained = (await listing()).find(tab => tab.target_id === blank.target_id);
    expect(retained.page_state).toBe('unavailable');
    expect(retained.capabilities).toEqual(['navigate']);
    await worker.evaluate(() => globalThis.restoreFixtureInspection());
    expect((await call('navigate', { target_id: blank.target_id, url: pageUrl + '?recovered=1' })).isError).not.toBe(true);
    await expect.poll(async () => (await listing()).find(tab => tab.target_id === blank.target_id)?.page_state).toBe('ready');
    const beforeRestart = app.bridge.epoch;
    await app.close();
    app = createApp(store, { origin, bind: '127.0.0.1', port: address.port, protectedOrigins: [origin] });
    await app.listen();
    await expect.poll(async () => (await state()).phase, { timeout: 10000 }).toBe('authenticated');
    await expect.poll(async () => (await state()).workspaces[0].end_reason).toBe('SERVICE_RESTARTED');
    expect((await state()).workspaces[0].state).toBe('inactive');
    expect((await state()).current_error).toBe(null);
    const discovered = async () => JSON.parse((await client.callTool({ name: 'list_browser_workspaces', arguments: {} })).content[0].text);
    await expect.poll(async () => (await discovered())[0]?.workspaces[0]?.end_reason).toBe('SERVICE_RESTARTED');
    const afterRestart = (await discovered())[0];
    expect(afterRestart.service_epoch).not.toBe(beforeRestart);
    expect(afterRestart.last_session_end.reason).toBe('SERVICE_RESTARTED');
    expect(afterRestart.workspaces[0].tab_count).toBe(0);
    expect(await listing()).toEqual([]);
    expect((await call('get_text', { target_id: blank.target_id, selector: 'h1' })).isError).toBe(true);
    await request({ type: 'ui.start', windowId });
    await expect.poll(async () => (await listing()).length).toBe(2);
    const current = (await listing())[0];
    await request({ type: 'ui.pause', workspace_id: first.workspace_id });
    const paused = await call('get_text', { target_id: current.target_id, selector: 'h1' });
    expect(paused.isError).toBe(true);
    expect(await options.evaluate(id => chrome.tabs.get(id).then(tab => tab.id), unshared.id)).toBe(unshared.id);
    await request({ type: 'ui.start', windowId });
    await expect.poll(async () => (await listing()).length).toBe(2);
    const resumed = (await listing())[0];
    expect(resumed.target_id).not.toBe(blank.target_id);
    await options.evaluate(windowId => chrome.sidePanel.close({ windowId }), windowId);
    await expect.poll(async () => (await state()).workspaces[0].state).toBe('inactive');
    expect((await state()).workspaces[0].end_reason).toBe('PANEL_CLOSED');
    expect((await call('get_text', { target_id: resumed.target_id, selector: 'h1' })).isError).toBe(true);
    const tabsAfter = await options.evaluate(() => chrome.tabs.query({}));
    expect(tabsAfter.filter(tab => tab.groupId === first.groupId)).toHaveLength(2);
    expect(tabsAfter.some(tab => tab.id === unshared.id)).toBe(true);
    await options.getByRole('button', { name: 'Open workspace sidebar' }).click();
    await new Promise(resolve => setTimeout(resolve, 300));
    await request({ type: 'ui.start', windowId, groupId: first.groupId });
    await expect.poll(async () => (await state()).workspaces[0]?.state).toBe('active');
    expect((await state()).workspaces[0].groupId).toBe(first.groupId);
    expect((await options.evaluate(() => chrome.tabs.query({}))).length).toBe(tabsAfter.length);
  } finally {
    await client?.close(); await context?.close(); await app.close(); store.close();
    tls.closeAllConnections(); pageServer.closeAllConnections();
    await Promise.all([new Promise(resolve => tls.close(resolve)), new Promise(resolve => pageServer.close(resolve))]);
    if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
