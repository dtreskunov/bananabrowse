const { createRequire } = require('node:module');
const path = require('node:path');
const fs = require('node:fs/promises');
const https = require('node:https');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { pathToFileURL } = require('node:url');
const localRequire = createRequire(path.join(__dirname, '../../../domagent-mcp/package.json'));
const { test, expect, chromium, firefox } = localRequire('@playwright/test');
const { WebSocketServer } = localRequire('ws');
const { freePort, installTemporaryAddon } = require('./firefox-rdp.cjs');

const root = path.resolve(__dirname, '../../..');
const artifactRoot = path.join(root, 'domagent-extension/.browser-artifacts');
let protocol;

for (const browserName of ['chrome', 'firefox']) {
test(`real ${browserName} extension: pairing, trusted approval, page commands, filtering and persisted keys`, async () => {
  test.skip(browserName === 'firefox' && process.env.DOMAGENT_FIREFOX_JUGGLER !== '1',
    'Extended Firefox harness requires DOMAGENT_FIREFOX_JUGGLER=1: Playwright 1.58.2 Juggler crashes on extension documents at FrameTree.js:543. Native Firefox RDP smoke remains in the default suite.');
  const artifacts = path.join(artifactRoot, browserName);
  protocol = await import(pathToFileURL(path.join(root, 'shared/protocol.js')).href);
  await fs.mkdir(artifacts, { recursive: true });
  process.env.TMPDIR = artifacts;
  const extension = path.join(artifacts, 'extension');
  await fs.cp(path.join(root, `dist/${browserName}`), extension, { recursive: true });
  const manifestPath = path.join(extension, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  // Test profiles pre-grant hosts; production permissions remain optional and
  // require a real browser owner gesture/prompt, separately qualified manually.
  manifest.host_permissions = ['http://*/*', 'https://*/*'];
  if (browserName === 'chrome') manifest.permissions.push('declarativeNetRequestFeedback');
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await fs.writeFile(path.join(extension, 'probe.html'), '<!doctype html><title>Non-UI extension page</title>');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', path.join(artifacts, 'key.pem'), '-out', path.join(artifacts, 'cert.pem'),
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'],
  { stdio: 'ignore' });

  let key;
  let enrollment;
  let dashboardApproved = false;
  let socket;
  let target;
  let protectedHits = 0;
  let handshake = 0;
  const messages = [];
  const owner = { owner_id: 'owner-test', owner_label: 'Test Owner', device_id: 'device-test' };
  const binding = { epoch: 'epoch-test', connection_id: 'connection-test' };
  const server = https.createServer({
    key: await fs.readFile(path.join(artifacts, 'key.pem')),
    cert: await fs.readFile(path.join(artifacts, 'cert.pem')),
  }, async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') { res.end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    let value;
    const origin = `https://127.0.0.1:${server.address().port}`;
    if (req.url === '/api/enrollment/challenge') value = { origin, nonce: 'nonce-start' };
    else if (req.url === '/api/enrollment/start') {
      key = body.public_key;
      expect(await protocol.verify(key, protocol.startPayload({ ...body, origin }), body.signature)).toBe(true);
      enrollment = { ...body, origin, enrollment_id: 'enrollment-test' };
      value = { enrollment_id: enrollment.enrollment_id, verification_url: `${origin}/verify`,
        expires_at: Date.now() + 60_000 };
    } else if (req.url === '/api/enrollment/status') {
      expect(await protocol.verify(key, protocol.statusPayload({ ...body, origin }), body.signature)).toBe(true);
      value = { state: dashboardApproved ? 'approved' : 'pending', enrollment_id: enrollment.enrollment_id };
      if (dashboardApproved) Object.assign(value, { ...owner, key_id: enrollment.key_id, nonce: 'nonce-confirm',
        extension_origin: enrollment.extension_origin, protected_origins: [origin], expires_at: Date.now() + 60_000 });
    } else if (req.url === '/api/enrollment/confirm') {
      expect(await protocol.verify(key, protocol.enrollmentPayload({
        ...owner, ...enrollment, nonce: 'nonce-confirm',
      }), body.signature)).toBe(true);
      value = { ...owner, key_id: enrollment.key_id, protected_origins: [origin] };
    } else {
      if (req.url === '/protected-hit') {
        protectedHits++;
        console.log(`[${browserName} protected request]`, req.headers['sec-fetch-dest'], req.headers['sec-fetch-mode']);
      }
      value = { ok: true };
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(value));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `https://127.0.0.1:${server.address().port}`;
  const wss = new WebSocketServer({ server, path: '/extension' });
  let pingTimer;
  wss.on('connection', client => {
    socket = client;
    const current = { ...binding, connection_id: `connection-${++handshake}` };
    client.on('message', async raw => {
      const message = JSON.parse(raw);
      messages.push(message);
      if (message.type === 'grant.end') console.log(`[${browserName} end reason]`, message.reason);
      if (message.type === 'hello') {
        expect(message.key_id).toBe(enrollment.key_id);
        client.send(JSON.stringify({ type: 'challenge', origin, ...current, nonce: 'nonce-auth',
          key_id: enrollment.key_id }));
      } else if (message.type === 'proof') {
        expect(await protocol.verify(key, protocol.authPayload({
          origin, ...current, nonce: 'nonce-auth', key_id: enrollment.key_id,
        }), message.signature)).toBe(true);
        client.send(JSON.stringify({ type: 'authenticated', ...owner, ...current,
          protected_origins: [origin] }));
        clearInterval(pingTimer);
        pingTimer = setInterval(() => {
          if (client.readyState === 1) client.send(JSON.stringify({ type: 'ping' }));
        }, 1000);
        socket.binding = current;
      } else if (message.type === 'grant.approve') {
        expect(await protocol.verify(key, protocol.grantPayload({
          ...socket.approval, ...message, origin, ...current,
        }), message.signature)).toBe(true);
        target = message.target_id;
        client.send(JSON.stringify({ type: 'grant.active', target_id: target, client_id: 'client-test' }));
      }
    });
  });
  const pageServer = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: `${origin}/protected-hit` }); res.end(); return;
    }
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/csp') res.setHeader('Content-Security-Policy', "script-src 'self'");
    if (req.url === '/password') {
      res.end('<!doctype html><title>Human login</title><input type="password"><p>Authenticate manually.</p>');
      return;
    }
    res.end('<!doctype html><title>Fixture Page</title><h1>Owned page</h1><input id="text"><button id="counter" onclick="this.textContent=\'clicked\'">click me</button>');
  });
  pageServer.listen(0, '127.0.0.1');
  await once(pageServer, 'listening');
  const pageOrigin = `http://127.0.0.1:${pageServer.address().port}`;
  let context;
  const profile = path.join(artifacts, 'profile');
  const firefoxUuid = '11111111-1111-1111-1111-111111111111';
  let firefoxOptionsUrl;
  async function launch() {
    if (browserName === 'chrome') {
      return chromium.launchPersistentContext(profile, {
        channel: 'chromium', headless: true, ignoreHTTPSErrors: true,
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
          '--ignore-certificate-errors', '--no-sandbox'],
      });
    }
    const port = await freePort();
    const launched = await firefox.launchPersistentContext(profile, {
      headless: process.env.DOMAGENT_HEADED_FIREFOX !== '1', ignoreHTTPSErrors: true, timeout: 30_000,
      args: ['--start-debugger-server', String(port)],
      firefoxUserPrefs: {
        'devtools.debugger.remote-enabled': true,
        'devtools.debugger.prompt-connection': false,
        'devtools.debugger.force-local': true,
        'devtools.chrome.enabled': true,
        'xpinstall.signatures.required': false,
        'extensions.webextensions.uuids': JSON.stringify({ 'domagent-secure@domagent': firefoxUuid }),
      },
    });
    console.log('[firefox] engine launched; installing temporary addon');
    try {
      const addon = await installTemporaryAddon(port, extension);
      firefoxOptionsUrl = addon.optionsUrl || addon.descriptor.manifestURL.replace('/manifest.json', '/options.html');
      return launched;
    } catch (error) {
      await launched.close();
      throw error;
    }
  }
  async function optionsPage() {
    let worker;
    let extensionId = firefoxUuid;
    let scheme = 'moz-extension';
    if (browserName === 'chrome') {
      worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
      extensionId = new URL(worker.url()).host;
      scheme = 'chrome-extension';
    }
    const optionsUrl = browserName === 'firefox' ? firefoxOptionsUrl : `${scheme}://${extensionId}/options.html`;
    if (browserName === 'firefox' && process.env.DOMAGENT_FIREFOX_NATIVE_OPTIONS === '1') {
      await expect.poll(() => context.pages().some(candidate => candidate.url() === optionsUrl), {
        timeout: 10_000, message: 'Native Firefox tab must load its verified packaged options URL',
      }).toBe(true);
      const page = context.pages().find(candidate => candidate.url() === optionsUrl);
      await expect(page.locator('#status')).toBeVisible();
      return { page, worker: page, extensionId: new URL(optionsUrl).host };
    }
    const page = await context.newPage();
    try {
      await page.goto(optionsUrl, { waitUntil: 'domcontentloaded' });
    } catch (error) {
      console.error('[extension navigation diagnostic]', {
        browserName, currentUrl: page.url(),
        title: await Promise.race([
          page.title(),
          new Promise(resolve => setTimeout(() => resolve('No page execution context within 2s'), 2000)),
        ]).catch(readError => readError.message),
        status: await page.locator('#status').textContent({ timeout: 2000 }).catch(readError => readError.message),
      });
      await page.close({ runBeforeUnload: false });
      throw new Error(`${browserName} installed extension options did not load: ${optionsUrl}`, { cause: error });
    }
    return { page, worker: worker || page, extensionId };
  }
  async function command(operation, args = {}, client = 'client-test') {
    const request_id = crypto.randomUUID();
    socket.send(JSON.stringify({ type: 'command', request_id, target_id: target, client_id: client,
      operation, args, expires_at: Date.now() + 25_000, ...socket.binding }));
    await expect.poll(() => messages.find(message => message.type === 'result' && message.request_id === request_id), {
      timeout: 20_000, message: `${browserName} result for ${operation}`,
    }).toBeTruthy();
    return messages.find(message => message.type === 'result' && message.request_id === request_id);
  }
  async function waitForTab(tabId) {
    const page = context.pages().find(page => page.url().includes('/options.html'));
    await expect.poll(async () => {
      const tab = await page.evaluate(id => (globalThis.browser || globalThis.chrome).tabs.get(id), tabId);
      return tab.status;
    }).toBe('complete');
  }
  async function approve(options, requestId) {
    const previousTarget = target;
    socket.approval = { type: 'approval.request', ...socket.binding, request_id: requestId,
      client_id: 'client-test', client_label: '<script>untrusted label</script>',
      policy_id: 'page-control-v1', nonce: `nonce-${requestId}`, protected_origins: [origin],
      expires_at: Date.now() + 60_000 };
    socket.send(JSON.stringify(socket.approval));
    await expect(options.locator('#requests')).toContainText('client-test');
    await expect(options.locator('#requests script')).toHaveCount(0);
    await options.getByLabel('evaluate_script', { exact: false }).check();
    await options.getByRole('button', { name: 'Approve new dedicated-tab control' }).click();
    await expect.poll(() => options.evaluate(async previous => {
      const api = globalThis.browser || globalThis.chrome;
      const state = (await api.runtime.sendMessage({ type: 'ui.state' })).value;
      return state.targets.some(tab => tab.state === 'active' && tab.target_id !== previous);
    }, previousTarget)).toBe(true);
    return options.evaluate(async () => {
      const api = globalThis.browser || globalThis.chrome;
      return (await api.runtime.sendMessage({ type: 'ui.state' })).value;
    });
  }
  try {
    console.log(`[${browserName}] launching browser`);
    context = await launch();
    context.setDefaultTimeout(10_000);
    context.setDefaultNavigationTimeout(15_000);
    console.log(`[${browserName}] extension installed; opening options`);
    context.on('console', message => {
      if (message.type() === 'error') console.error(`[${browserName} console] ${message.text()}`);
    });
    context.on('weberror', event => console.error(`[${browserName} page error] ${event.error().message}`));
    const { page: options, worker, extensionId } = await optionsPage();
    if (browserName === 'chrome') {
      await worker.evaluate(() => {
        chrome.webNavigation.onBeforeNavigate.addListener(event => console.error('[navigation before]', JSON.stringify(event)));
        chrome.webNavigation.onErrorOccurred.addListener(event => console.error('[navigation error]', JSON.stringify(event)));
        chrome.debugger.onDetach.addListener((source, reason) => console.error('[debugger detach]', source.tabId, reason));
        chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(event => console.error('[DNR match]', JSON.stringify(event)));
      });
    }
    console.log(`[${browserName}] options loaded`);
    await expect(options.locator('#status')).toContainText('not configured');
    await options.locator('#origin').fill(origin);
    await options.getByRole('button', { name: 'Save service' }).click();
    await expect(options.locator('#status')).toContainText(origin);
    console.log(`[${browserName}] service configured`);
    await options.getByRole('button', { name: 'Start enrollment' }).click();
    await expect(options.locator('#enrollment')).toContainText('pending');
    console.log(`[${browserName}] enrollment pending`);
    await options.getByRole('button', { name: 'Check dashboard approval' }).click();
    await expect(options.locator('#confirm-enrollment')).toBeDisabled();
    dashboardApproved = true;
    await options.getByRole('button', { name: 'Check dashboard approval' }).click();
    await expect(options.locator('#enrollment')).toContainText('owner-test');
    await options.getByRole('button', { name: 'Locally confirm' }).click();
    await expect(options.locator('#identity')).toContainText('device-test');
    console.log(`[${browserName}] local enrollment confirmed`);
    await options.getByRole('button', { name: 'Connect identity only' }).click();
    await expect(options.locator('#status')).toContainText('authenticated');
    console.log(`[${browserName}] device authenticated`);

    // Ordinary pages have no bridge and cannot manufacture trusted runtime senders.
    const userTab = await context.newPage();
    await userTab.goto(pageOrigin);
    expect(await userTab.evaluate(() => typeof globalThis.chrome?.runtime?.sendMessage)).toBe('undefined');
    expect(await userTab.evaluate(() => typeof globalThis.browser?.runtime?.sendMessage)).toBe('undefined');
    const probe = await context.newPage();
    await probe.goto(options.url().replace('/options.html', '/probe.html'));
    const spoof = await probe.evaluate(() => (globalThis.browser || globalThis.chrome).runtime.sendMessage({
      type: 'ui.approve', request_id: 'fake',
    }));
    expect(spoof.error.code).toBe('NOT_AUTHORIZED');
    await probe.close();

    const state = await approve(options, 'approval-test');
    console.log(`[${browserName}] grant active`);
    expect(await userTab.title()).toBe('Fixture Page');
    expect(state.targets[0].tabId).toBeTruthy();
    if (browserName === 'chrome') {
      const rules = await worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
      expect(rules[0].condition.tabIds).toEqual([state.targets[0].tabId]);
    }
    expect((await command('navigate', { url: pageOrigin })).result.navigation_started).toBe(true);
    await waitForTab(state.targets[0].tabId);
    console.log(`[${browserName}] dedicated tab navigated`);
    expect((await command('get_text')).result.text).toContain('Owned page');
    expect((await command('get_text', {}, 'other-client')).error.code).toBe('APPROVAL_REQUIRED');
    expect((await command('forwardCDPCommand')).error.code).toBe('CAPABILITY_UNAVAILABLE');
    expect((await command('click', { selector: '#counter' })).result.clicked).toBe(true);
    expect((await command('type_text', { selector: '#text', text: 'typed by approved client' })).result.typed).toBe(true);
    expect((await command('evaluate_script', { script: 'document.querySelector("#text").value' })).result.value)
      .toBe('typed by approved client');
    expect((await command('get_interactive_elements')).result.elements.length).toBeGreaterThan(0);
    console.log(`[${browserName}] DOM operations passed`);
    const screenshot = await command('get_screenshot');
    if (browserName === 'firefox' && screenshot.error) expect(screenshot.error.code).toBe('CAPABILITY_UNAVAILABLE');
    else {
      expect(screenshot.result.mimeType).toBe('image/png');
      expect(Buffer.from(screenshot.result.data, 'base64').subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    }
    expect((await command('evaluate_script', { script: 'typeof globalThis.browser?.runtime' })).result.value).toBe('undefined');
    expect((await command('evaluate_script', { script: 'typeof globalThis.chrome?.runtime' })).result.value).toBe('undefined');
    const blockedFetch = await command('evaluate_script', {
      script: `fetch(${JSON.stringify(`${origin}/protected-hit`)}).then(() => 'not-blocked', () => 'blocked')`,
    });
    expect(blockedFetch.result.value).toBe('blocked');
    expect(protectedHits).toBe(0);
    await command('navigate', { url: `${pageOrigin}/csp` });
    await waitForTab(state.targets[0].tabId);
    const cspEvaluation = await command('evaluate_script', { script: '41 + 1' });
    if (browserName === 'firefox') expect(cspEvaluation.error.code).toBe('CAPABILITY_UNAVAILABLE');
    else expect(cspEvaluation.result.value).toBe(42);
    expect((await command('get_text')).result.text).toContain('Owned page');
    await options.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(options.locator('#targets')).toContainText('inactive');
    expect((await command('get_text')).error.code).toBe('APPROVAL_REQUIRED');
    const oldTarget = target;
    const fresh = await approve(options, 'approval-fresh');
    expect(target).not.toBe(oldTarget);
    expect(fresh.targets[0].tabId).toBe(state.targets[0].tabId);
    await command('navigate', { url: `${pageOrigin}/password` });
    await waitForTab(state.targets[0].tabId);
    expect((await command('get_text')).error.code).toBe('HANDOFF_REQUIRED');
    await expect(options.locator('#targets')).toContainText('inactive');
    // Simulate the browser owner finishing the login, not a remote command.
    const loginPage = context.pages().find(page => page.url() === `${pageOrigin}/password`);
    await loginPage.evaluate(() => document.querySelector('input[type="password"]').remove());
    await approve(options, 'approval-after-human');
    // Trigger a protected redirect while controlled; DNR must prevent the request.
    await command('navigate', { url: `${pageOrigin}/redirect` });
    await expect(options.locator('#targets')).toContainText('inactive');
    expect(protectedHits).toBe(0);
    if (browserName === 'chrome') {
      expect(await worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules())).toEqual([]);
    }
    expect(await userTab.title()).toBe('Fixture Page');

    const keyBefore = enrollment.key_id;
    await context.close();
    context = await launch();
    const restarted = await optionsPage();
    await expect(restarted.page.locator('#identity')).toContainText('device-test');
    await expect(restarted.page.locator('#status')).toContainText('authenticated');
    await expect(restarted.page.locator('#targets')).toContainText('No dedicated tabs');
    const restartedState = await restarted.page.evaluate(async () => {
      const api = globalThis.browser || globalThis.chrome;
      return (await api.runtime.sendMessage({ type: 'ui.state' })).value;
    });
    expect(restartedState.key_id).toBe(keyBefore);
    expect(restartedState.pending).toEqual([]);
    expect(restartedState.targets.every(target => target.state === 'inactive')).toBe(true);
    expect(restarted.extensionId).toBe(extensionId);
  } catch (error) {
    if (context) {
      for (const page of context.pages().filter(page => page.url().includes('/options.html'))) {
        console.error(`[${browserName} UI]`, await page.locator('#error').textContent({ timeout: 2000 }).catch(readError => readError.message));
        console.error(`[${browserName} state]`, await page.evaluate(async () => {
          const api = globalThis.browser || globalThis.chrome;
          return api.runtime.sendMessage({ type: 'ui.state' });
        }).catch(readError => readError.message));
      }
    }
    throw error;
  } finally {
    if (context) await context.close();
    clearInterval(pingTimer);
    for (const client of wss.clients) client.terminate();
    wss.close();
    server.closeAllConnections();
    pageServer.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => pageServer.close(resolve))]);
    await fs.rm(artifacts, { recursive: true, force: true });
  }
});
}
