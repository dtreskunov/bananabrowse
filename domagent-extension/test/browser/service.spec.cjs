const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const fs = require('node:fs/promises');
const https = require('node:https');
const http = require('node:http');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const localRequire = createRequire(path.join(root, 'domagent-mcp/package.json'));
const { test, expect, chromium } = localRequire('@playwright/test');
const { Client } = localRequire('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = localRequire('@modelcontextprotocol/sdk/client/streamableHttp.js');

test('real Chrome extension and actual service: guided setup, automatic pairing, sharing and tenant switching', async () => {
  const { Store } = await import(pathToFileURL(path.join(root, 'domagent-mcp/store.js')).href);
  const { createApp } = await import(pathToFileURL(path.join(root, 'domagent-mcp/app.js')).href);
  const artifacts = path.join(root, 'domagent-extension/.browser-artifacts/service');
  await fs.rm(artifacts, { recursive: true, force: true });
  await fs.mkdir(artifacts, { recursive: true });
  process.env.TMPDIR = artifacts;
  const extension = path.join(artifacts, 'extension');
  await fs.cp(path.join(root, 'dist/chrome'), extension, { recursive: true });
  const manifestFile = path.join(extension, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  manifest.host_permissions = ['http://*/*', 'https://*/*'];
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', path.join(artifacts, 'key.pem'), '-out', path.join(artifacts, 'cert.pem'),
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });

  let app;
  const tls = https.createServer({
    key: await fs.readFile(path.join(artifacts, 'key.pem')),
    cert: await fs.readFile(path.join(artifacts, 'cert.pem')),
  }, (req, res) => {
    if (req.url.includes('/enrollment/') || req.url.includes('/approve')) {
      console.log('[actual service request]', req.method, req.url, {
        origin: req.headers.origin, fetchMode: req.headers['sec-fetch-mode'],
      });
    }
    app.server.listeners('request')[0](req, res);
  });
  tls.on('upgrade', (req, socket, head) => app.bridge.upgrade(req, socket, head));
  tls.listen(0, '127.0.0.1');
  await once(tls, 'listening');
  const origin = `https://127.0.0.1:${tls.address().port}`;
  const issuer = 'https://idp.test';
  const store = new Store(':memory:');
  const ownerId = store.invite(issuer, 'owner', 'Browser owner');
  store.admit(issuer, 'owner');
  const session = store.createSession(ownerId);
  const registrarId = store.invite(issuer, 'registrar', 'Separate client registrar');
  store.admit(issuer, 'registrar');
  let tenant;
  let credentials;
  app = createApp(store, {
    origin, issuer, protectedOrigins: [origin, issuer, 'https://bananaclaw.test'],
    bind: '127.0.0.1', port: 0,
  }, {
    start: async flow => `${issuer}/authorize?state=${flow.state}`,
    finish: async () => ({ issuer, subject: 'owner' }),
  });
  const backend = await app.listen();
  const pageServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Actual service page</title><h1>Real MCP owned page</h1>');
  });
  pageServer.listen(0, '127.0.0.1');
  await once(pageServer, 'listening');
  let context;
  let client;
  async function state(options) {
    return options.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'ui.state' })).value);
  }
  try {
    context = await chromium.launchPersistentContext(path.join(artifacts, 'profile'), {
      channel: 'chromium', headless: true, ignoreHTTPSErrors: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
        '--ignore-certificate-errors', '--no-sandbox'],
    });
    context.setDefaultTimeout(10_000);
    context.on('console', message => {
      if (message.type() === 'error') console.error('[actual service browser]', message.text());
    });
    await context.addCookies([{
      name: '__Host-domagent_session', value: session.token, url: origin,
      secure: true, httpOnly: true, sameSite: 'Strict',
    }]);
    const backendOrigin = `http://127.0.0.1:${backend.port}`;
    const setupResponse = await fetch(`${backendOrigin}/api/setup-requests`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_name: 'Atlas',
        request_description: 'I need your help opening a website using your browser session.' }),
    });
    expect(setupResponse.status).toBe(201);
    const setup = await setupResponse.json();
    expect(store.setup(setup.request_id).tenant_id).toBeNull();
    const setupPage = await context.newPage();
    await setupPage.goto(setup.verification_url);
    await expect(setupPage.getByRole('heading', { name: 'Atlas wants to connect to your browser' })).toBeVisible();
    expect(new URL(setupPage.url()).hash).toBe('');
    const flowCookies = (await context.cookies(origin)).filter(cookie => cookie.name.includes('setup'));
    expect(flowCookies).toHaveLength(1);
    expect(flowCookies[0]).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax' });
    expect(await setupPage.evaluate(() => document.cookie)).not.toContain(flowCookies[0].name);
    await setupPage.getByRole('button', { name: 'Set up connection', exact: true }).click();
    await expect(setupPage.getByRole('heading', { name: 'Connection ready', exact: true })).toBeVisible();
    const connectionLink = await setupPage.getByRole('textbox', { name: 'Connection link', exact: true }).inputValue();
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    await setupPage.getByRole('button', { name: 'Copy connection link', exact: true }).click();
    await expect(setupPage.locator('#copy-status')).toContainText('Copied');
    expect(await setupPage.evaluate(() => navigator.clipboard.readText())).toBe(connectionLink);
    tenant = store.tenant(new URL(connectionLink).pathname.split('/').at(-1));
    const credential = await setupPage.locator('details code').nth(1).textContent();
    credentials = { ...store.authenticateClient(credential, tenant.id), credential };
    expect(tenant.label).toBe('Atlas');
    expect(await setupPage.locator('details').evaluate(element => element.open)).toBe(false);
    const receiptResponse = await fetch(`${backendOrigin}/api/setup-requests/${setup.request_id}/status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status_receipt: setup.status_receipt }),
    });
    const receipt = await receiptResponse.json();
    expect(receipt).toMatchObject({ state: 'approved', tenant_id: tenant.id, connection_url: connectionLink });
    expect(JSON.stringify(receipt)).not.toContain(credential);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    const optionsUrl = `chrome-extension://${extensionId}/options.html`;
    // onInstalled, not a manual navigation, starts a fresh browser's wizard.
    await expect.poll(() => context.pages().some(page => page.url() === optionsUrl)).toBe(true);
    const options = context.pages().find(page => page.url() === optionsUrl);
    const permissions = [];
    await options.evaluate(() => {
      const original = chrome.permissions.request.bind(chrome.permissions);
      globalThis.permissionRequests = [];
      chrome.permissions.request = value => {
        globalThis.permissionRequests.push(value);
        return original(value);
      };
    });
    await options.locator('#connection-link').fill(connectionLink);
    await options.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect.poll(async () => ({
      enrollment: await options.locator('#enrollment').textContent(),
      error: await options.locator('#error').textContent(),
    }), { message: 'Actual service enrollment must succeed without browser UI errors' })
      .toMatchObject({ enrollment: expect.stringContaining('Sign in on the website'), error: '' });
    permissions.push(...await options.evaluate(() => globalThis.permissionRequests));
    expect(permissions).toEqual([{ origins: [`${origin}/*`] }]);
    const enrollmentId = (await state(options)).enrollment.enrollment_id;
    const dashboard = await context.newPage();
    await dashboard.goto(`${origin}/pair/${tenant.id}?enrollment=${encodeURIComponent(enrollmentId)}`);
    const form = dashboard.locator(`form[action="/pair/${tenant.id}/approve"]`).filter({
      has: dashboard.locator(`input[name="enrollment_id"][value="${enrollmentId}"]`),
    });
    await form.getByRole('button').click();
    await expect(options.locator('#status')).toContainText("You're connected to Atlas");
    expect((await state(options)).identity.owner_id).toBe(ownerId);
    expect((await state(options)).targets).toEqual([]);
    expect(app.bridge.grants.size).toBe(0);
    const deviceId = (await state(options)).identity.device_id;
    client = new Client({ name: 'real-extension-integration', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${backend.port}/mcp/${tenant.id}`), {
      requestInit: { headers: { Authorization: `Bearer ${credentials.credential}` } },
    }));
    const access = await client.callTool({ name: 'request_browser_access', arguments: { device_id: deviceId } });
    expect(access.isError).not.toBe(true);
    await expect(options.locator('#requests')).toContainText('Atlas would like');
    await expect(options.locator('#requests')).toContainText('not a verified identity');
    await options.getByRole('button', { name: 'Share a tab', exact: true }).click();
    await expect(options.locator('#targets')).toContainText('can use this tab');
    const target = (await state(options)).targets[0];
    const navigate = await client.callTool({
      name: 'navigate', arguments: { target_id: target.target_id, url: `http://127.0.0.1:${pageServer.address().port}` },
    });
    expect(navigate.isError).not.toBe(true);
    await expect.poll(async () => (await worker.evaluate(id => chrome.tabs.get(id), target.tabId)).status).toBe('complete');
    const text = await client.callTool({
      name: 'get_text', arguments: { target_id: target.target_id, selector: 'body' },
    });
    expect(text.isError).not.toBe(true);
    expect(JSON.stringify(text)).toContain('Real MCP owned page');
    const screenshot = await client.callTool({ name: 'get_screenshot', arguments: { target_id: target.target_id } });
    expect(screenshot.isError).not.toBe(true);
    expect(screenshot.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(Buffer.from(screenshot.content[0].data, 'base64').subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const shared = context.pages().find(page => page.url().startsWith(`http://127.0.0.1:${pageServer.address().port}`));
    await expect(shared.getByRole('button', { name: 'Stop sharing' })).toBeVisible();
    expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('ON');
    expect(await worker.evaluate(() => chrome.action.getTitle({}))).toContain('Atlas can use');
    expect(JSON.stringify(text)).not.toContain('Stop sharing');
    await shared.getByRole('button', { name: 'Stop sharing' }).click();
    await expect(options.locator('#targets')).toContainText('not being shared');
    await expect(shared.locator('[data-domagent-sharing]')).toHaveCount(0);
    expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('IDLE');
    const paused = await client.callTool({
      name: 'get_text', arguments: { target_id: target.target_id, selector: 'body' },
    });
    expect(paused.isError).toBe(true);
    expect((await worker.evaluate(id => chrome.tabs.get(id), target.tabId)).url).toContain('127.0.0.1');
    expect(await worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules())).toEqual([]);

    // A second tuple on the same server gets an independent key. Switching
    // invalidates live grants and pending work before another socket can start.
    const firstKey = (await state(options)).key_id;
    const second = store.createTenant(registrarId, 'Harbor');
    store.addMember(registrarId, second.id, ownerId);
    const secondCredentials = store.createClient(registrarId, 'Harbor', second.id);
    await options.getByRole('button', { name: 'Add connection', exact: true }).click();
    await options.locator('#connection-link').fill(`${origin}/join/${second.id}`);
    await options.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect.poll(async () => (await state(options)).enrollment?.tenant_id).toBe(second.id);
    store.approveEnrollment((await state(options)).enrollment.enrollment_id, ownerId, second.id);
    await expect(options.locator('#status')).toContainText("You're connected to Harbor");
    const secondState = await state(options);
    expect(secondState.key_id).not.toBe(firstKey);
    expect(secondState.targets).toEqual([]);
    expect(secondState.saved_connections).toHaveLength(2);
    const wrongTenantClient = new Client({ name: 'wrong-tenant', version: '1' });
    await expect(wrongTenantClient.connect(new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${backend.port}/mcp/${tenant.id}`), {
        requestInit: { headers: { Authorization: `Bearer ${secondCredentials.credential}` } },
      }))).rejects.toThrow();
    await wrongTenantClient.close();
    const oldDeviceAccess = await client.callTool({ name: 'request_browser_access', arguments: { device_id: secondState.identity.device_id } });
    expect(oldDeviceAccess.isError).toBe(true);
    await options.getByRole('button', { name: 'Switch connection', exact: true }).click();
    await expect(options.locator('#status')).toContainText("You're connected to Atlas");
    expect((await state(options)).key_id).toBe(firstKey);
    expect((await state(options)).targets.every(tab => tab.state === 'inactive')).toBe(true);
    await client.callTool({ name: 'request_browser_access', arguments: { device_id: deviceId } });
    await expect(options.locator('#requests')).toContainText('Atlas would like');
    await options.getByRole('button', { name: 'Share a tab', exact: true }).click();
    await expect.poll(async () => (await state(options)).targets[0]?.state).toBe('active');
    const switchTarget = (await state(options)).targets[0].target_id;
    await options.getByRole('button', { name: 'Switch connection', exact: true }).click();
    await expect(options.locator('#status')).toContainText("You're connected to Harbor");
    expect(app.bridge.grants.size).toBe(0);
    expect((await state(options)).targets).toEqual([]);
    const afterSwitch = await client.callTool({ name: 'get_text', arguments: { target_id: switchTarget, selector: 'body' } });
    expect(afterSwitch.isError).toBe(true);
  } finally {
    if (client) await client.close();
    if (context) await context.close();
    await app.close();
    tls.closeAllConnections();
    pageServer.closeAllConnections();
    await Promise.all([new Promise(resolve => tls.close(resolve)), new Promise(resolve => pageServer.close(resolve))]);
    store.close();
    await fs.rm(artifacts, { recursive: true, force: true });
  }
});
