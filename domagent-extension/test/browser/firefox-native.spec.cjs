const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const fs = require('node:fs/promises');
const https = require('node:https');
const http = require('node:http');
const { once } = require('node:events');
const { execFileSync, spawn } = require('node:child_process');
const { freePort } = require('./firefox-rdp.cjs');
const { openNativeRdp } = require('./native-rdp.cjs');
const root = path.resolve(__dirname, '../../..');
const localRequire = createRequire(path.join(root, 'domagent-mcp/package.json'));
const { test, expect, firefox } = localRequire('@playwright/test');
const { Client } = localRequire('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = localRequire('@modelcontextprotocol/sdk/client/streamableHttp.js');

test('native Firefox RDP smoke: pairing, capabilities, protected requests, restart and regressions', async () => {
  test.setTimeout(150_000);
  const { Store } = await import(pathToFileURL(path.join(root, 'domagent-mcp/store.js')).href);
  const { createApp } = await import(pathToFileURL(path.join(root, 'domagent-mcp/app.js')).href);
  const artifacts = path.join(root, 'domagent-extension/.browser-artifacts/firefox-native');
  const profile = path.join(artifacts, 'profile');
  const extension = path.join(artifacts, 'extension');
  await fs.rm(artifacts, { recursive: true, force: true });
  await fs.mkdir(profile, { recursive: true });
  await fs.cp(path.join(root, 'dist/firefox'), extension, { recursive: true });
  const manifestPath = path.join(extension, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  // Only this throwaway profile pre-grants page hosts and trusts its fixture CA.
  if (manifest.manifest_version === 2) manifest.permissions.push('http://*/*', 'https://*/*');
  else manifest.host_permissions = ['http://*/*', 'https://*/*'];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', path.join(artifacts, 'ca-key.pem'), '-out', path.join(artifacts, 'ca.pem'),
    '-days', '1', '-subj', '/CN=DomAgent native test CA',
    '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign'], { stdio: 'ignore' });
  execFileSync('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', path.join(artifacts, 'key.pem'), '-out', path.join(artifacts, 'server.csr'),
    '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
  await fs.writeFile(path.join(artifacts, 'server.ext'), [
    'subjectAltName=IP:127.0.0.1', 'basicConstraints=critical,CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment', 'extendedKeyUsage=serverAuth',
  ].join('\n'));
  execFileSync('openssl', ['x509', '-req', '-in', path.join(artifacts, 'server.csr'),
    '-CA', path.join(artifacts, 'ca.pem'), '-CAkey', path.join(artifacts, 'ca-key.pem'),
    '-CAcreateserial', '-out', path.join(artifacts, 'cert.pem'), '-days', '1',
    '-extfile', path.join(artifacts, 'server.ext')], { stdio: 'ignore' });
  const cert = await fs.readFile(path.join(artifacts, 'cert.pem'), 'utf8');
  const ca = await fs.readFile(path.join(artifacts, 'ca.pem'), 'utf8');
  let app;
  let protectedHits = 0;
  const tls = https.createServer({
    key: await fs.readFile(path.join(artifacts, 'key.pem')), cert,
  }, (req, res) => {
    if (req.url === '/protected-hit') {
      protectedHits++;
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
      res.end('protected endpoint must not be requested by an automation tab');
      return;
    }
    console.log('[native Firefox service request]', req.method, req.url);
    app.server.listeners('request')[0](req, res);
  });
  tls.on('tlsClientError', error => console.error('[native Firefox fixture TLS]', error.code));
  tls.on('upgrade', (req, socket, head) => app.bridge.upgrade(req, socket, head));
  tls.listen(0, '127.0.0.1');
  await once(tls, 'listening');
  const origin = `https://127.0.0.1:${tls.address().port}`;
  const issuer = 'https://idp.test';
  const store = new Store(':memory:');
  const ownerId = store.invite(issuer, 'firefox-owner', 'Native Firefox owner');
  store.admit(issuer, 'firefox-owner');
  const tenant = store.createTenant(ownerId, 'Atlas');
  const credentials = store.createClient(ownerId, 'Native smoke client', tenant.id);
  app = createApp(store, { origin, issuer, protectedOrigins: [origin, issuer],
    bind: '127.0.0.1', port: 0 }, {
    start: async flow => `${issuer}/authorize?state=${flow.state}`,
    finish: async () => ({ issuer, subject: 'firefox-owner' }),
  });
  const backend = await app.listen();
  const pageServer = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: `${origin}/protected-hit` });
      res.end();
      return;
    }
    if (req.method === 'POST' && req.url === '/submitted') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ submitted: true }));
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/csp') {
      res.setHeader('Content-Security-Policy', "script-src 'self'");
    }
    if (req.url === '/resources') {
      const protectedUrl = `${origin}/protected-hit`;
      res.end('<!doctype html><title>Protected requests</title>' +
        '<p id="fetch">pending</p><p id="frame">pending</p><p id="image">pending</p>' +
        `<script>fetch(${JSON.stringify(protectedUrl)}).then(() => {
          document.querySelector("#fetch").textContent = "fetch-escaped";
        }, () => { document.querySelector("#fetch").textContent = "fetch-blocked"; });</script>` +
        `<iframe src="${protectedUrl}"></iframe>` +
        `<img src="${protectedUrl}" onerror="document.querySelector('#image').textContent='image-blocked'">`);
      return;
    }
    res.end('<!doctype html><title>Native Firefox page</title><h1>Native owned page</h1>' +
      '<form method="post" action="/submitted"><input name="customer">' +
      '<button id="explicit" type="button">Non-submit</button><button id="submit">Submit</button></form>');
  });
  pageServer.listen(0, '127.0.0.1');
  await once(pageServer, 'listening');
  const port = await freePort();
  const prefs = {
    'devtools.debugger.remote-enabled': true, 'devtools.debugger.prompt-connection': false,
    'devtools.debugger.force-local': true, 'devtools.chrome.enabled': true,
    'devtools.jsonview.enabled': true,
    'network.dns.localDomains': 'domagent-restricted.test',
    'extensions.webextensions.restrictedDomains': 'domagent-restricted.test',
    'xpinstall.signatures.required': false, 'browser.shell.checkDefaultBrowser': false,
  };
  await fs.writeFile(path.join(profile, 'user.js'), Object.entries(prefs)
    .map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`).join('\n'));
  // Standalone Firefox: the test drives RDP only, not Playwright's Juggler pipe.
  let browser;
  let browserExit;
  let browserError;
  let logs = '';
  const collect = data => { logs = (logs + data.toString()).slice(-16_000); };
  function launch() {
    browserError = undefined;
    browser = spawn(firefox.executablePath(), [
      '--no-remote', '--headless', '--profile', profile,
      '--start-debugger-server', String(port), 'about:blank',
    ], { env: { ...process.env, TMPDIR: artifacts }, stdio: ['ignore', 'pipe', 'pipe'] });
    browserExit = new Promise(resolve => browser.once('close', resolve));
    browser.on('error', error => { browserError = error; });
    browser.stdout.on('data', collect);
    browser.stderr.on('data', collect);
  }
  async function stopBrowser() {
    if (rdp) rdp.close();
    const running = () => browser.exitCode === null && browser.signalCode === null && !browserError;
    if (running()) browser.kill('SIGTERM');
    let timer;
    await Promise.race([browserExit, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
    clearTimeout(timer);
    if (running()) browser.kill('SIGKILL');
    await browserExit;
  }
  let rdp;
  let client;
  let optionsConsole;
  let watcherActor;
  let parent;
  async function connectOptions() {
    rdp = await openNativeRdp(port);
    if (browserError) throw browserError;
    const rootActor = await rdp.request('root', 'getRoot');
    const installed = await rdp.request(rootActor.addonsActor, 'installTemporaryAddon', { addonPath: extension });
    expect(installed.addon.id).toBe(manifest.browser_specific_settings.gecko.id);
    const { addons } = await rdp.request('root', 'listAddons');
    const descriptor = addons.find(addon => addon.id === installed.addon.id);
    expect(descriptor.warnings).toEqual([]);
    const { processDescriptor } = await rdp.request('root', 'getProcess', { id: 0 });
    ({ process: parent } = await rdp.request(processDescriptor.actor, 'getTarget'));
    const base64Cert = ca.replace(/-----[^-]+-----|\s/g, '');
    const optionsUrl = await rdp.evaluate(parent.consoleActor, `(() => {
      const db = Cc["@mozilla.org/security/x509certdb;1"].getService(Ci.nsIX509CertDB);
      db.addCertFromBase64(${JSON.stringify(base64Cert)}, "CT,,");
      const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
      const extension = ExtensionParent.GlobalManager.getExtension(${JSON.stringify(installed.addon.id)});
      const url = extension.manifest.options_ui.page;
      const window = Services.wm.getMostRecentWindow("navigator:browser");
      window.gBrowser.selectedTab = window.gBrowser.addTab(url, {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
      });
      return url;
    })()`);
    expect(optionsUrl).toBe(descriptor.manifestURL.replace('/manifest.json', '/options.html'));
    const watcher = await rdp.request(descriptor.actor, 'getWatcher');
    watcherActor = watcher.actor;
    await rdp.request(watcher.actor, 'watchTargets', { targetType: 'frame' });
    const { target } = await rdp.event(packet => packet.type === 'target-available-form' &&
      packet.target.url === optionsUrl);
    optionsConsole = target.consoleActor;
  }
  launch();
  try {
    await connectOptions();
    const evaluate = expression => rdp.evaluate(optionsConsole, expression);
    const state = () => evaluate('browser.runtime.sendMessage({type:"ui.state"}).then(response => response.value)');
    const request = message => evaluate(`browser.runtime.sendMessage(${JSON.stringify(message)}).then(response => {
      if (!response.ok) throw new Error(response.error.code);
      return response.value;
    })`);
    const click = async selector => {
      await expect.poll(() => evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        return Boolean(element && !element.disabled);
      })()`)).toBe(true);
      return evaluate(`(() => {
        document.querySelector(${JSON.stringify(selector)}).click(); return true;
      })()`);
    };
    await expect.poll(() => evaluate('document.querySelector("#status")?.textContent')).toContain('Connect your browser');
    // RDP programmatic clicks do not grant browser user activation. Hosts are
    // pre-granted, so exercise the same trusted options-page runtime boundary
    // without pretending to validate permission prompts or physical clicks.
    await request({ type: 'ui.configure', config: { connection_url: `${origin}/join/${tenant.id}`, local_protected_origins: [] } });
    await expect.poll(async () => (await state()).config.service_origin).toBe(origin);
    await request({ type: 'ui.enroll', label: 'My Firefox' });
    await expect.poll(async () => (await state()).enrollment?.state).toBe('pending');
    store.approveEnrollment((await state()).enrollment.enrollment_id, ownerId, tenant.id);
    await expect.poll(async () => (await state()).identity?.owner_id).toBe(ownerId);
    const deviceId = (await state()).identity.device_id;
    await expect.poll(async () => (await state()).phase).toBe('authenticated');
    const idleConnection = app.bridge.connections.get(deviceId).connection_id;
    await new Promise(resolve => setTimeout(resolve, 21_000));
    expect((await state()).phase).toBe('authenticated');
    expect(app.bridge.connections.get(deviceId).connection_id).toBe(idleConnection);
    expect(app.bridge.grants.size).toBe(0);
    client = new Client({ name: 'native-firefox-smoke', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${backend.port}/mcp/${tenant.id}`), {
      requestInit: { headers: { Authorization: `Bearer ${credentials.credential}` } },
    }));
    const access = await client.callTool({ name: 'request_browser_access', arguments: { device_id: deviceId } });
    expect(access.isError).not.toBe(true);
    await expect.poll(async () => (await state()).pending[0]?.client_id).toBe(credentials.id);
    const advertised = (await state()).capabilities;
    expect(advertised).toContain('evaluate_script');
    expect(advertised.includes('get_screenshot'))
      .toBe(await evaluate('typeof browser.tabs.captureTab === "function"'));
    await request({ type: 'ui.approve', request_id: (await state()).pending[0].request_id,
      capabilities: ['navigate', 'get_text', 'click'] });
    await expect.poll(async () => (await state()).targets[0]?.state).toBe('active');
    const grant = (await state()).targets[0];
    const navigate = await client.callTool({ name: 'navigate', arguments: {
      target_id: grant.target_id, url: `http://127.0.0.1:${pageServer.address().port}`,
    } });
    expect(navigate.isError).not.toBe(true);
    await expect.poll(() => evaluate(`browser.tabs.get(${grant.tabId}).then(tab => tab.status)`)).toBe('complete');
    const text = await client.callTool({ name: 'get_text', arguments: { target_id: grant.target_id, selector: 'body' } });
    expect(text.isError).not.toBe(true);
    expect(JSON.stringify(text)).toContain('Native owned page');
    expect(JSON.stringify(text)).not.toContain('Stop sharing');
    const marker = () => evaluate(`browser.scripting.executeScript({
      target:{tabId:${grant.tabId},frameIds:[0]},world:"ISOLATED",
      func:() => document.querySelector("[data-domagent-sharing]")?.shadowRoot?.textContent || ""
    }).then(results => results[0].result)`);
    await expect.poll(marker).toContain('Native smoke client can use this tab.');
    expect(await evaluate('(browser.action || browser.browserAction).getBadgeText({})')).toBe('ON');
    for (const [name, args] of [['evaluate_script', { script: '1 + 1' }], ['get_screenshot', {}]]) {
      const unapproved = await client.callTool({ name, arguments: { target_id: grant.target_id, ...args } });
      expect(unapproved.isError).toBe(true);
      expect(JSON.parse(unapproved.content[0].text)).toEqual({ error: 'CAPABILITY_UNAVAILABLE' });
    }
    const attributeClick = await client.callTool({ name: 'click', arguments: {
      target_id: grant.target_id, selector: 'button[type="button"]',
    } });
    expect(attributeClick.isError).not.toBe(true);
    const missing = await client.callTool({ name: 'click', arguments: {
      target_id: grant.target_id, selector: 'button[type="submit"]',
    } });
    expect(missing.isError).toBe(true);
    expect(JSON.parse(missing.content[0].text)).toEqual({ error: 'ELEMENT_NOT_FOUND' });
    const invalid = await client.callTool({ name: 'click', arguments: {
      target_id: grant.target_id, selector: 'button[',
    } });
    expect(invalid.isError).toBe(true);
    expect(JSON.parse(invalid.content[0].text)).toEqual({ error: 'INVALID_SELECTOR' });
    const submit = await client.callTool({ name: 'click', arguments: {
      target_id: grant.target_id, selector: '#submit',
    } });
    expect(submit.isError).not.toBe(true);
    expect(JSON.parse(submit.content[0].text)).toEqual({ clicked: true });
    await expect.poll(() => evaluate(`browser.tabs.get(${grant.tabId}).then(tab => ({
      status: tab.status, url: tab.url,
    }))`)).toMatchObject({ status: 'complete', url: `http://127.0.0.1:${pageServer.address().port}/submitted` });
    const afterPost = await client.callTool({ name: 'get_text', arguments: {
      target_id: grant.target_id, selector: 'body',
    } });
    expect(afterPost.isError).not.toBe(true);
    expect(JSON.stringify(afterPost)).toContain('submitted');
    const recover = await client.callTool({ name: 'navigate', arguments: {
      target_id: grant.target_id, url: `http://127.0.0.1:${pageServer.address().port}`,
    } });
    expect(recover.isError).not.toBe(true);
    await expect.poll(() => evaluate(`browser.tabs.get(${grant.tabId}).then(tab => ({
      status: tab.status, url: tab.url,
    }))`)).toMatchObject({ status: 'complete', url: `http://127.0.0.1:${pageServer.address().port}/` });
    const recovered = await client.callTool({ name: 'get_text', arguments: {
      target_id: grant.target_id, selector: 'body',
    } });
    expect(recovered.isError).not.toBe(true);
    expect(JSON.stringify(recovered)).toContain('Native owned page');
    const refusedNavigation = await client.callTool({ name: 'navigate', arguments: {
      target_id: grant.target_id, url: `http://domagent-restricted.test:${pageServer.address().port}/`,
    } });
    expect(refusedNavigation.isError).not.toBe(true);
    await expect.poll(() => evaluate(`browser.tabs.get(${grant.tabId}).then(tab => tab.status)`)).toBe('complete');
    const refused = await client.callTool({ name: 'get_text', arguments: {
      target_id: grant.target_id, selector: 'body',
    } });
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.content[0].text)).toEqual({ error: 'PAGE_UNAVAILABLE' });
    await expect.poll(async () => (await state()).targets[0]?.state).toBe('inactive');
    const status = await client.callTool({ name: 'list_browser_targets', arguments: {} });
    expect(JSON.parse(status.content[0].text)[0]).toMatchObject({
      state: 'approval_required', target_id: null, capabilities: [],
    });
    const staleNavigate = await client.callTool({ name: 'navigate', arguments: {
      target_id: grant.target_id, url: `http://127.0.0.1:${pageServer.address().port}/`,
    } });
    expect(staleNavigate.isError).toBe(true);
    expect(JSON.parse(staleNavigate.content[0].text)).toEqual({ error: 'NOT_AUTHORIZED' });
    await evaluate(`browser.tabs.update(${grant.tabId}, {
      url: ${JSON.stringify(`http://127.0.0.1:${pageServer.address().port}/`)},
    })`);
    await expect.poll(() => evaluate(`browser.tabs.get(${grant.tabId}).then(tab => tab.status)`)).toBe('complete');
    const again = await client.callTool({ name: 'request_browser_access', arguments: { device_id: deviceId } });
    expect(again.isError).not.toBe(true);
    await expect.poll(async () => (await state()).pending[0]?.client_id).toBe(credentials.id);
    await request({ type: 'ui.approve', request_id: (await state()).pending[0].request_id,
      capabilities: ['navigate', 'get_text', 'click'] });
    await expect.poll(async () => (await state()).targets[0]?.state).toBe('active');
    const fresh = (await state()).targets[0];
    expect(fresh.target_id).not.toBe(grant.target_id);
    await request({ type: 'ui.end', target_id: fresh.target_id, reason: 'OWNER_PAUSED' });
    await client.callTool({ name: 'request_browser_access', arguments: { device_id: deviceId } });
    await expect.poll(async () => (await state()).pending[0]?.client_id).toBe(credentials.id);
    await request({ type: 'ui.approve', request_id: (await state()).pending[0].request_id,
      capabilities: advertised });
    await expect.poll(async () => (await state()).targets[0]?.state).toBe('active');
    const full = (await state()).targets[0];
    const call = (name, args = {}) => client.callTool({
      name, arguments: { target_id: full.target_id, ...args },
    });
    const read = async result => {
      expect(result.isError).not.toBe(true);
      return JSON.parse(result.content[0].text);
    };
    expect(await read(await call('evaluate_script', { script: '1 + 1' }))).toEqual({ value: 2 });
    expect(await read(await call('evaluate_script', {
      script: '[typeof globalThis.browser?.runtime, typeof globalThis.chrome?.runtime]',
    }))).toEqual({ value: ['undefined', 'undefined'] });
    console.log('[native Firefox qualification]', JSON.stringify({
      version: await rdp.evaluate(parent.consoleActor, 'Services.appinfo.version'),
      capabilities: advertised,
    }));
    const capture = await call('get_screenshot');
    if (advertised.includes('get_screenshot')) {
      expect(capture.isError).not.toBe(true);
      expect(capture.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
      expect(Buffer.from(capture.content[0].data, 'base64').subarray(0, 8).toString('hex'))
        .toBe('89504e470d0a1a0a');
    } else {
      expect(capture.isError).toBe(true);
      expect(JSON.parse(capture.content[0].text)).toEqual({ error: 'CAPABILITY_UNAVAILABLE' });
    }
    expect(await read(await call('navigate', {
      url: `http://127.0.0.1:${pageServer.address().port}/csp`,
    }))).toMatchObject({ navigation_started: true });
    await expect.poll(() => evaluate(`browser.tabs.get(${full.tabId}).then(tab => tab.status)`)).toBe('complete');
    const deniedEval = await call('evaluate_script', { script: '41 + 1' });
    expect(deniedEval.isError).toBe(true);
    expect(JSON.parse(deniedEval.content[0].text)).toEqual({ error: 'CAPABILITY_UNAVAILABLE' });
    expect(await read(await call('get_text', { selector: 'body' }))).toMatchObject({
      text: expect.stringContaining('Native owned page'),
    });
    await read(await call('navigate', { url: `http://127.0.0.1:${pageServer.address().port}/resources` }));
    await expect.poll(() => evaluate(`browser.tabs.get(${full.tabId}).then(tab => tab.status)`)).toBe('complete');
    await expect.poll(async () => (await read(await call('get_text', { selector: 'body' }))).text)
      .toContain('fetch-blocked');
    expect(await read(await call('get_text', { selector: 'body' }))).toMatchObject({
      text: expect.stringContaining('image-blocked'),
    });
    expect(protectedHits).toBe(0);
    const frames = await evaluate(`browser.webNavigation.getAllFrames({tabId:${full.tabId}})`);
    expect(frames.filter(frame => frame.frameId !== 0).every(frame =>
      frame.errorOccurred || frame.url === 'about:blank')).toBe(true);
    await read(await call('navigate', { url: `http://127.0.0.1:${pageServer.address().port}/redirect` }));
    await expect.poll(async () => (await state()).targets[0]?.state).toBe('inactive');
    expect(protectedHits).toBe(0);
    expect(app.bridge.grants.size).toBe(0);
    await evaluate(`browser.tabs.update(${full.tabId}, {
      url: ${JSON.stringify(`http://127.0.0.1:${pageServer.address().port}/`)},
    })`);
    await expect.poll(() => evaluate(`browser.tabs.get(${full.tabId}).then(tab => tab.status)`)).toBe('complete');
    await client.callTool({ name: 'request_browser_access', arguments: { device_id: deviceId } });
    await expect.poll(async () => (await state()).pending.length).toBe(1);
    await request({ type: 'ui.approve', request_id: (await state()).pending[0].request_id,
      capabilities: ['navigate', 'get_text'] });
    await expect.poll(async () => (await state()).targets[0]?.state).toBe('active');
    const beforeReconnect = (await state()).targets[0].target_id;
    await click('#disconnect');
    await expect.poll(async () => (await state()).phase).toBe('disconnected');
    expect((await state()).targets[0].state).toBe('inactive');
    await click('#connect');
    await expect.poll(async () => (await state()).phase).toBe('authenticated');
    expect((await state()).identity.device_id).toBe(deviceId);
    expect((await state()).targets[0].state).toBe('inactive');
    const afterReconnect = await client.callTool({ name: 'get_text', arguments: {
      target_id: beforeReconnect, selector: 'body',
    } });
    expect(afterReconnect.isError).toBe(true);
    expect(JSON.parse(afterReconnect.content[0].text)).toEqual({ error: 'NOT_AUTHORIZED' });
    await client.callTool({ name: 'request_browser_access', arguments: { device_id: deviceId } });
    await expect.poll(async () => (await state()).pending.length).toBe(1);
    await request({ type: 'ui.approve', request_id: (await state()).pending[0].request_id,
      capabilities: ['navigate', 'get_text'] });
    await expect.poll(async () => (await state()).targets[0]?.state).toBe('active');
    const pausedTarget = (await state()).targets[0].target_id;
    const pausedTab = (await state()).targets[0].tabId;
    await expect.poll(() => evaluate(`browser.scripting.executeScript({
      target:{tabId:${pausedTab},frameIds:[0]},world:"ISOLATED",
      func:() => Boolean(document.querySelector("[data-domagent-sharing]")?.shadowRoot?.querySelector("button"))
    }).then(results => results[0].result)`)).toBe(true);
    await evaluate(`browser.scripting.executeScript({
      target:{tabId:${pausedTab},frameIds:[0]},world:"ISOLATED",
      func:() => { document.querySelector("[data-domagent-sharing]").shadowRoot.querySelector("button").click(); }
    })`);
    await expect.poll(async () => (await state()).targets[0]?.state).toBe('inactive');
    await expect.poll(() => evaluate('(browser.action || browser.browserAction).getBadgeText({})')).toBe('IDLE');
    const paused = await client.callTool({ name: 'get_text', arguments: { target_id: pausedTarget, selector: 'body' } });
    expect(paused.isError).toBe(true);
    await client.callTool({ name: 'request_browser_access', arguments: { device_id: deviceId } });
    await expect.poll(async () => (await state()).pending.length).toBe(1);
    await request({ type: 'ui.approve', request_id: (await state()).pending[0].request_id,
      capabilities: ['navigate', 'get_text'] });
    await expect.poll(async () => (await state()).targets[0]?.state).toBe('active');
    const beforeRestart = (await state()).targets[0].target_id;
    const keyBeforeRestart = (await state()).key_id;
    await stopBrowser();
    await expect.poll(() => app.bridge.grants.size).toBe(0);
    launch();
    await connectOptions();
    await expect.poll(async () => (await state()).phase).toBe('authenticated');
    expect((await state()).key_id).toBe(keyBeforeRestart);
    expect((await state()).identity.device_id).toBe(deviceId);
    expect((await state()).targets).toEqual([]);
    const restarted = await client.callTool({ name: 'list_browser_targets', arguments: {} });
    expect(JSON.parse(restarted.content[0].text)[0]).toMatchObject({
      state: 'approval_required', target_id: null, capabilities: [],
    });
    const old = await client.callTool({ name: 'get_text', arguments: {
      target_id: beforeRestart, selector: 'body',
    } });
    expect(old.isError).toBe(true);
    expect(JSON.parse(old.content[0].text)).toEqual({ error: 'NOT_AUTHORIZED' });
    await client.callTool({ name: 'request_browser_access', arguments: { device_id: deviceId } });
    await expect.poll(async () => (await state()).pending.length).toBe(1);
    await request({ type: 'ui.approve', request_id: (await state()).pending[0].request_id,
      capabilities: ['navigate', 'get_text'] });
    await expect.poll(async () => (await state()).targets[0]?.state).toBe('active');
    expect((await state()).targets[0].target_id).not.toBe(beforeRestart);
    await request({ type: 'ui.end', target_id: (await state()).targets[0].target_id, reason: 'OWNER_PAUSED' });
    const unattendedConnection = app.bridge.connections.get(deviceId).connection_id;
    // This RDP method is one-way: do not wait for a reply that cannot arrive.
    const unwatch = JSON.stringify({ to: watcherActor, type: 'unwatchTargets', targetType: 'frame' });
    rdp.socket.write(`${Buffer.byteLength(unwatch)}:${unwatch}`);
    await rdp.evaluate(parent.consoleActor, `(() => {
      const window = Services.wm.getMostRecentWindow("navigator:browser");
      for (const tab of Array.from(window.gBrowser.tabs)) {
        if (tab.linkedBrowser.currentURI.spec.startsWith("moz-extension://")) window.gBrowser.removeTab(tab);
      }
      return true;
    })()`);
    // No extension-page polling or open popup may keep an idle background alive.
    await new Promise(resolve => setTimeout(resolve, 65_000));
    console.log('[native Firefox unattended background]', await rdp.evaluate(parent.consoleActor, `(() => {
      const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
      const extension = ExtensionParent.GlobalManager.getExtension(${JSON.stringify(manifest.browser_specific_settings.gecko.id)});
      return { state: extension.backgroundState, persistent: extension.manifest.background.persistent,
        idleEnabled: Services.prefs.getBoolPref("extensions.webextensions.background.idle.enabled", true),
        idleTimeout: Services.prefs.getIntPref("extensions.webextensions.background.idle.timeout", -1) };
    })()`));
    expect(app.bridge.connections.get(deviceId)?.connection_id).toBe(unattendedConnection);
    expect(app.bridge.grants.size).toBe(0);
    expect(app.bridge.targets(credentials.id)[0].state).toBe('approval_required');
  } catch (error) {
    if (rdp && optionsConsole) {
      try {
        console.error('[native Firefox options UI error]',
          await rdp.evaluate(optionsConsole, 'document.querySelector("#error")?.textContent'));
        const cached = await rdp.request(optionsConsole, 'getCachedMessages', { messageTypes: ['ConsoleAPI', 'PageError'] });
        console.error('[native Firefox options console]', JSON.stringify(cached).slice(-4000));
      } catch (diagnosticError) {
        console.error('[native Firefox diagnostic failure]', diagnosticError.message);
      }
    }
    console.error('[native Firefox smoke browser logs]', logs);
    throw error;
  } finally {
    if (client) await client.close();
    await stopBrowser();
    await app.close();
    tls.closeAllConnections();
    pageServer.closeAllConnections();
    await Promise.all([new Promise(resolve => tls.close(resolve)), new Promise(resolve => pageServer.close(resolve))]);
    store.close();
    await fs.rm(artifacts, { recursive: true, force: true });
  }
});
