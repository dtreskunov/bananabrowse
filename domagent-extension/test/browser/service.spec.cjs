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
const { actionHtml, exerciseActions, respondToForm } = require('./action-fixtures.cjs');

test('real Chrome extension and actual service: guided setup, automatic pairing, sharing and tenant switching', async () => {
  test.setTimeout(240_000);
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
  const send = app.bridge.send.bind(app.bridge);
  app.bridge.send = (session, message) => {
    if (['approval.request', 'command', 'command.execute'].includes(message.type)) {
      // Exercise the real approval/execution flow with a server clock two minutes ahead.
      message = { ...message, expires_at: message.expires_at + 120_000 };
    }
    return send(session, message);
  };
  const backend = await app.listen();
  const pageServer = http.createServer(async (req, res) => {
    if (await respondToForm(req, res)) return;
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Actual service page</title><h1>Real MCP owned page</h1>' +
      actionHtml +
      (req.url === '/login' ? '<input type="password" id="password"><p>Login page with CAPTCHA</p><div data-sitekey="fixture"></div>' : ''));
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
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    const optionsUrl = `chrome-extension://${extensionId}/options.html`;
    // Observe the real onInstalled wizard before opening any ordinary tabs.
    await expect.poll(() => context.pages().some(page => page.url() === optionsUrl), { timeout: 15_000 }).toBe(true);
    const options = context.pages().find(page => page.url() === optionsUrl);
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
    const pageOrigin = `http://127.0.0.1:${pageServer.address().port}`;
    let shared = await context.newPage();
    await shared.goto(pageOrigin);
    await shared.locator('input[name="search"]').fill('unsaved workspace fixture');
    await shared.evaluate(() => { globalThis.workspaceDocumentStamp = 'same original document'; });
    const originalWindow = await worker.evaluate(url =>
      chrome.tabs.query({}).then(tabs => tabs.find(tab => tab.url === url).windowId), pageOrigin + '/');
    const accessPromise = client.callTool({ name: 'request_browser_access', arguments: {
      device_id: deviceId, description: 'Read the website I select in the explicitly selected browser tab',
    } });
    await expect(options.locator('#requests')).toContainText('Atlas would like');
    await expect(options.locator('#requests')).toContainText('not a verified identity');
    expect(context.pages().some(page => page.url().includes('/request.html?'))).toBe(false);
    const requestWindow = options;
    await expect(requestWindow.locator('#requests')).toContainText('Read the website I select in the explicitly selected browser tab');
    await expect(requestWindow.locator('#requests input[type="checkbox"]')).toHaveCount(0);
    await expect(requestWindow.locator('#requests')).toContainText(pageOrigin);
    await requestWindow.getByRole('button', { name: 'Share this tab with Atlas', exact: true }).click();
    const access = await accessPromise;
    expect(access.isError).not.toBe(true);
    expect(JSON.parse(access.content[0].text).state).toBe('active');
    await expect(options.locator('#targets')).toContainText('can use this tab');
    const target = (await state(options)).targets[0];
    expect(target.windowId).not.toBe(originalWindow);
    expect(await shared.locator('input[name="search"]').inputValue()).toBe('unsaved workspace fixture');
    expect(await shared.evaluate(() => globalThis.workspaceDocumentStamp)).toBe('same original document');
    expect(await worker.evaluate(windowId => chrome.tabs.query({ windowId }).then(tabs => tabs.length), target.windowId)).toBe(1);
    expect(await worker.evaluate(tabId => chrome.sidePanel.getOptions({ tabId }), target.tabId))
      .toMatchObject({ enabled: true, path: `panel.html?window_id=${target.windowId}` });
    const reSharing = client.callTool({ name: 'request_browser_access', arguments: {
      device_id: deviceId, description: 'Share this already selected browser tab again for the same task',
    } });
    await expect(options.locator('#requests')).toContainText('Share this already selected');
    await options.getByRole('button', { name: 'Share this tab with Atlas', exact: true }).click();
    expect(JSON.parse((await reSharing).content[0].text).target_id).toBe(target.target_id);
    expect((await state(options)).targets).toHaveLength(1);
    expect((await state(options)).phase).toBe('authenticated');
    expect((await worker.evaluate(() => chrome.tabs.query({ active: true, windowType: 'normal' })))
      .some(tab => tab.id === target.tabId && tab.url.startsWith(pageOrigin))).toBe(true);
    let testedSyntheticApproval = false;
    async function approved(name, args = {}, decision = 'Approve') {
      if (name === 'get_text' && !args.selector && !args.ref) args = { selector: 'body', ...args };
      const call = client.callTool({ name, arguments: { target_id: target.target_id,
        description: `Please ${name} on my selected website in the explicitly selected test browser tab`, ...args } });
      let completed = false;
      call.then(() => { completed = true; });
      await expect.poll(async () => {
        const command = (await state(options)).targets[0]?.commands[0];
        return completed || (command?.state === 'pending' && !command.preparing);
      }).toBe(true);
      if (completed) return call;
      if (!testedSyntheticApproval) {
        testedSyntheticApproval = true;
        await expect(shared.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
        await shared.evaluate(() => {
          const root = document.querySelector('[data-domagent-sharing]').shadowRoot;
          for (const button of root.querySelectorAll('button')) {
            if (['Approve', 'Allow all while sharing'].includes(button.textContent)) button.click();
          }
        });
        await new Promise(resolve => setTimeout(resolve, 150));
        expect((await state(options)).targets[0].commands[0].state).toBe('pending');
        expect((await state(options)).targets[0].allow_all).toBe(false);
      }
      await options.getByRole('button', { name: decision, exact: true }).click();
      return call;
    }
    const text = await approved('get_text', { selector: 'body' });
    expect(text.isError).not.toBe(true);
    expect(JSON.stringify(text)).toContain('Real MCP owned page');
    await worker.evaluate(() => {
      const execute = chrome.scripting.executeScript.bind(chrome.scripting);
      globalThis.transientInspectionFailures = 0;
      chrome.scripting.executeScript = args => {
        if (args.args?.[0] === 'inspect' && globalThis.transientInspectionFailures++ < 2) {
          return Promise.reject(new Error('Transient fixture frame unavailable'));
        }
        return execute(args);
      };
      globalThis.restoreInspection = () => { chrome.scripting.executeScript = execute; };
    });
    const afterTransientInjection = await approved('get_page_snapshot');
    expect(afterTransientInjection.isError).not.toBe(true);
    expect((await state(options)).targets[0].target_id).toBe(target.target_id);
    await worker.evaluate(() => globalThis.restoreInspection());
    for (const explanation of ['x', 'nonsense '.repeat(30)]) {
      const reading = client.callTool({ name: 'get_text', arguments: {
        target_id: target.target_id, description: explanation, selector: '#key-result',
      } });
      if (explanation === 'x') {
        expect(JSON.parse((await reading).content[0].text).error).toBe('INVALID_ARGUMENTS');
        expect((await state(options)).targets[0].commands).toHaveLength(0);
        continue;
      }
      await expect(options.locator('#targets')).toContainText('Operation: get_text');
      await expect(options.locator('#targets')).toContainText('Selector: #key-result');
      await expect(options.locator('#targets')).toContainText('Agent explanation is unverified');
      await options.getByRole('button', { name: 'Approve', exact: true }).click();
      expect((await reading).isError).not.toBe(true);
    }
    const replacement = client.callTool({ name: 'click', arguments: {
      target_id: target.target_id, description: 'Click the displayed control in the explicitly selected browser tab', selector: '#disabled',
    } });
    await expect(options.locator('#targets')).toContainText('Control: button "Disabled action"');
    await shared.locator('#disabled').evaluate(element => {
      element.outerHTML = '<button id="disabled" onclick="globalThis.wrongReplacementClicked=true">New control</button>';
    });
    await options.getByRole('button', { name: 'Approve', exact: true }).click();
    expect(JSON.parse((await replacement).content[0].text).error).toBe('ELEMENT_STALE');
    expect(await shared.evaluate(() => globalThis.wrongReplacementClicked)).toBeUndefined();
    await shared.locator('#disabled').evaluate(element => {
      element.outerHTML = '<button id="disabled" disabled>Disabled action</button>';
    });
    await exerciseActions(approved);
    const screenshot = await approved('get_screenshot');
    expect(screenshot.isError).not.toBe(true);
    expect(screenshot.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(Buffer.from(screenshot.content[0].data, 'base64').subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    await expect(shared.getByRole('button', { name: 'Stop sharing' })).toBeVisible();
    await expect(options.locator('#error')).toContainText('Click the DomAgent toolbar');
    expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('ON');
    expect(await worker.evaluate(() => chrome.action.getTitle({}))).toContain('Atlas can use');
    expect(JSON.stringify(text)).not.toContain('Stop sharing');
    const human = client.callTool({ name: 'request_handoff', arguments: {
      target_id: target.target_id, description: 'Please sign in on this website yourself in the explicitly selected browser tab',
    } });
    await expect(options.locator('#targets')).toContainText('Please sign in');
    await shared.goto(`${pageOrigin}/login`);
    await shared.locator('#password').fill('fixture-only-password');
    await expect(shared.getByRole('button', { name: 'Done', exact: true })).toHaveCount(0);
    await shared.evaluate(() => {
      const root = document.querySelector('[data-domagent-sharing]').shadowRoot;
      for (const button of root.querySelectorAll('button')) button.click();
    });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect((await state(options)).targets[0].commands[0].state).toBe('pending');
    await options.getByRole('button', { name: 'Done', exact: true }).click();
    const humanResult = await human;
    expect(humanResult.isError).not.toBe(true);
    expect(JSON.parse(humanResult.content[0].text)).toMatchObject({ state: 'completed', user_confirmed: true });
    expect((await state(options)).targets[0].target_id).toBe(target.target_id);
    const loginText = await approved('get_text', { selector: 'body' });
    expect(loginText.isError).not.toBe(true);
    expect(JSON.stringify(loginText)).toContain('Login page');
    const allow = await approved('get_text', {}, 'Allow all while sharing');
    expect(allow.isError).not.toBe(true);
    const automatic = await client.callTool({ name: 'get_text', arguments: {
      target_id: target.target_id, selector: 'body', description: 'Read without another ordinary prompt in the explicitly selected browser tab',
    } });
    expect(automatic.isError).not.toBe(true);
    const assistance = client.callTool({ name: 'request_handoff', arguments: {
      target_id: target.target_id, description: 'Still needs explicit human confirmation in the explicitly selected browser tab',
    } });
    await expect(options.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
    await options.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(JSON.parse((await assistance).content[0].text).error).toBe('ACTION_DECLINED');
    expect((await state(options)).targets[0].state).toBe('active');
    await shared.getByRole('button', { name: 'Stop sharing' }).click();
    await expect(options.locator('#targets')).toContainText('No shared tabs');
    await expect.poll(() => shared.isClosed()).toBe(true);
    expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('IDLE');
    expect(await worker.evaluate(() => chrome.action.getTitle({}))).toContain('No tabs are being shared');
    // Historical cosmetic errors do not turn off independent trusted UI.
    await options.evaluate(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      globalThis.restoreMessages = () => { chrome.runtime.sendMessage = original; };
      chrome.runtime.sendMessage = async message => {
        const response = await original(message);
        if (message.type === 'ui.state' && response.ok) {
          response.value.failures = ['INDICATOR_UNAVAILABLE'];
          response.value.targets = response.value.targets.map(target => ({ ...target, end_reason: 'HANDOFF' }));
        }
        return response;
      };
    });
    await expect(options.locator('#error')).toContainText('Click the DomAgent toolbar');
    await options.evaluate(() => globalThis.restoreMessages());
    const paused = await client.callTool({
      name: 'get_text', arguments: { target_id: target.target_id, selector: 'body', description: 'Read stopped tab in the explicitly selected browser tab' },
    });
    expect(paused.isError).toBe(true);
    expect(await worker.evaluate(id => chrome.tabs.query({}).then(tabs => tabs.some(tab => tab.id === id)), target.tabId)).toBe(false);
    expect(await worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules())).toEqual([]);

    // The owner can choose a different active normal tab after the request window opens.
    const differentAccess = client.callTool({ name: 'request_browser_access', arguments: {
      device_id: deviceId, description: 'Select a different existing tab in the explicitly selected browser tab',
    } });
    await expect(options.locator('#requests')).toContainText('Select a different');
    const different = await context.newPage();
    await different.goto(`${pageOrigin}/different`);
    await expect(options.locator('#requests')).toContainText('/different');
    await options.getByRole('button', { name: 'Share this tab with Atlas', exact: true }).click();
    const differentResult = await differentAccess;
    expect(differentResult.isError).not.toBe(true);
    const changed = (await state(options)).targets[0];
    expect(changed.tabId).not.toBe(target.tabId);
    const stale = client.callTool({ name: 'click', arguments: {
      target_id: changed.target_id, selector: '#disabled', description: 'Do not click this button if its document changes before approval',
    } });
    await expect(options.locator('#targets')).toContainText('Do not click this button');
    await different.goto(`${pageOrigin}/new-document`);
    expect(JSON.parse((await stale).content[0].text).error).toBe('TARGET_STALE');
    const timed = await client.callTool({ name: 'get_text', arguments: {
      target_id: changed.target_id, selector: 'body', description: 'Let this approval expire in the explicitly selected browser tab', wait_timeout_seconds: 1,
    } });
    expect(JSON.parse(timed.content[0].text).error).toBe('COMMAND_EXPIRED');
    expect((await state(options)).targets[0].state).toBe('active');
    const unrelated = await worker.evaluate(({ windowId, url }) =>
      chrome.tabs.create({ windowId, url, active: false }), { windowId: changed.windowId, url: `${pageOrigin}/unrelated` });
    await expect.poll(async () => (await state(options)).targets.length).toBe(0);
    await options.getByRole('button', { name: 'Close controlled tab', exact: true }).click();
    expect(await worker.evaluate(tabId => chrome.tabs.get(tabId).then(tab => tab.url), unrelated.id))
      .toBe(`${pageOrigin}/unrelated`);
    const expiring = await client.callTool({ name: 'request_browser_access', arguments: {
      device_id: deviceId, description: 'Let this sharing request expire in the explicitly selected browser tab', wait_timeout_seconds: 1,
    } });
    expect(JSON.parse(expiring.content[0].text).error).toBe('COMMAND_EXPIRED');
    await expect.poll(async () => (await state(options)).pending.length).toBe(0);

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
    const oldDeviceAccess = await client.callTool({ name: 'request_browser_access', arguments: {
      device_id: secondState.identity.device_id, description: 'Wrong-tenant request in the explicitly selected browser tab',
    } });
    expect(oldDeviceAccess.isError).toBe(true);
    await options.getByRole('button', { name: 'Switch connection', exact: true }).click();
    await expect(options.locator('#status')).toContainText("You're connected to Atlas");
    expect((await state(options)).key_id).toBe(firstKey);
    expect((await state(options)).targets.every(tab => tab.state === 'inactive')).toBe(true);
    const nextAccess = client.callTool({ name: 'request_browser_access', arguments: {
      device_id: deviceId, description: 'Share again after tenant switch in the explicitly selected browser tab',
    } });
    await expect(options.locator('#requests')).toContainText('Atlas would like');
    shared = await context.newPage();
    await shared.goto(pageOrigin);
    await expect(options.locator('#requests')).toContainText(pageOrigin);
    await options.getByRole('button', { name: 'Share this tab with Atlas', exact: true }).click();
    expect((await nextAccess).isError).not.toBe(true);
    await expect.poll(async () => (await state(options)).targets[0]?.state).toBe('active');
    const switchTarget = (await state(options)).targets[0].target_id;
    await options.getByRole('button', { name: 'Switch connection', exact: true }).click();
    await expect(options.locator('#status')).toContainText("You're connected to Harbor");
    expect(app.bridge.grants.size).toBe(0);
    expect((await state(options)).targets).toEqual([]);
    const afterSwitch = await client.callTool({ name: 'get_text', arguments: {
      target_id: switchTarget, selector: 'body', description: 'Read after switching tenant in the explicitly selected browser tab',
    } });
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
