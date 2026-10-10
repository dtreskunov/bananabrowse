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

test('real Chrome extension and actual service: signed pairing, cross-owner MCP control and pause', async () => {
  const { Store } = await import(pathToFileURL(path.join(root, 'domagent-mcp/store.js')).href);
  const { createApp } = await import(pathToFileURL(path.join(root, 'domagent-mcp/app.js')).href);
  const artifacts = path.join(root, 'domagent-extension/.browser-artifacts/service');
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
    if (req.url.startsWith('/api/enrollment/') || req.url === '/dashboard/approve-enrollment') {
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
  const credentials = store.createClient(registrarId, 'Unverified agent label');
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
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await options.locator('#origin').fill(origin);
    await options.getByRole('button', { name: 'Save service' }).click();
    await expect(options.locator('#status')).toContainText(origin);
    await options.getByRole('button', { name: 'Start enrollment' }).click();
    await expect.poll(async () => ({
      enrollment: await options.locator('#enrollment').textContent(),
      error: await options.locator('#error').textContent(),
    }), { message: 'Actual service enrollment must succeed without browser UI errors' })
      .toMatchObject({ enrollment: expect.stringContaining('pending'), error: '' });
    const enrollmentId = (await state(options)).enrollment.enrollment_id;
    const dashboard = await context.newPage();
    await dashboard.goto(`${origin}/dashboard?enrollment=${encodeURIComponent(enrollmentId)}`);
    const form = dashboard.locator('form[action="/dashboard/approve-enrollment"]').filter({
      has: dashboard.locator(`input[name="enrollment_id"][value="${enrollmentId}"]`),
    });
    await form.getByRole('button').click();
    await expect(dashboard.getByText('Approved. Return to the extension', { exact: false })).toBeVisible();
    await options.getByRole('button', { name: 'Check dashboard approval' }).click();
    await expect(options.locator('#enrollment')).toContainText(ownerId);
    await options.getByRole('button', { name: 'Locally confirm' }).click();
    await expect(options.locator('#identity')).toContainText(ownerId);
    const deviceId = (await state(options)).identity.device_id;
    store.link(ownerId, credentials.id, deviceId);
    await options.getByRole('button', { name: 'Connect identity only' }).click();
    await expect(options.locator('#status')).toContainText('authenticated');
    client = new Client({ name: 'real-extension-integration', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${backend.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${credentials.credential}` } },
    }));
    const access = await client.callTool({ name: 'request_browser_access', arguments: { device_id: deviceId } });
    expect(access.isError).not.toBe(true);
    await expect(options.locator('#requests')).toContainText(credentials.id);
    await expect(options.locator('#requests')).toContainText('Untrusted client label');
    await options.getByRole('button', { name: 'Approve new dedicated-tab control' }).click();
    await expect(options.locator('#targets')).toContainText('active');
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
    await options.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(options.locator('#targets')).toContainText('inactive');
    const paused = await client.callTool({
      name: 'get_text', arguments: { target_id: target.target_id, selector: 'body' },
    });
    expect(paused.isError).toBe(true);
    expect((await worker.evaluate(id => chrome.tabs.get(id), target.tabId)).url).toContain('127.0.0.1');
    expect(await worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules())).toEqual([]);
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
