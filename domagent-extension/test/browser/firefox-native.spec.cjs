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

test('native Firefox: collaborative sharing, guarded decisions, persistent restart and no-UI heartbeat', async () => {
  test.setTimeout(180_000);
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
  manifest.permissions.push('http://*/*', 'https://*/*');
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', path.join(artifacts, 'ca-key.pem'), '-out', path.join(artifacts, 'ca.pem'),
    '-days', '1', '-subj', '/CN=DomAgent native test CA',
    '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign'], { stdio: 'ignore' });
  execFileSync('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', path.join(artifacts, 'key.pem'), '-out', path.join(artifacts, 'server.csr'),
    '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
  await fs.writeFile(path.join(artifacts, 'server.ext'),
    'subjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth');
  execFileSync('openssl', ['x509', '-req', '-in', path.join(artifacts, 'server.csr'),
    '-CA', path.join(artifacts, 'ca.pem'), '-CAkey', path.join(artifacts, 'ca-key.pem'),
    '-CAcreateserial', '-out', path.join(artifacts, 'cert.pem'), '-days', '1',
    '-extfile', path.join(artifacts, 'server.ext')], { stdio: 'ignore' });
  const ca = await fs.readFile(path.join(artifacts, 'ca.pem'), 'utf8');
  let app;
  let protectedHits = 0;
  const tls = https.createServer({
    key: await fs.readFile(path.join(artifacts, 'key.pem')),
    cert: await fs.readFile(path.join(artifacts, 'cert.pem')),
  }, (req, res) => {
    if (req.url === '/protected-hit') {
      protectedHits++;
      res.end('Protected');
      return;
    }
    app.server.listeners('request')[0](req, res);
  });
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
      res.writeHead(302, { Location: `${origin}/protected-hit` }); res.end(); return;
    }
    if (req.url === '/csp') res.setHeader('Content-Security-Policy', "script-src 'self'");
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Native Firefox page</title><h1>Native owned page</h1>' +
      '<input type="password"><div data-sitekey="fixture"></div><button id="explicit">Page control</button>');
  });
  pageServer.listen(0, '127.0.0.1');
  await once(pageServer, 'listening');
  const pageOrigin = `http://127.0.0.1:${pageServer.address().port}`;
  const port = await freePort();
  const prefs = {
    'devtools.debugger.remote-enabled': true, 'devtools.debugger.prompt-connection': false,
    'devtools.debugger.force-local': true, 'devtools.chrome.enabled': true,
    'xpinstall.signatures.required': false, 'browser.shell.checkDefaultBrowser': false,
  };
  await fs.writeFile(path.join(profile, 'user.js'), Object.entries(prefs)
    .map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`).join('\n'));
  let browser;
  let browserExit;
  let rdp;
  let client;
  let optionsConsole;
  let watcherActor;
  let parent;
  let logs = '';
  function launch() {
    browser = spawn(firefox.executablePath(), [
      '--no-remote', '--headless', '--profile', profile, '--start-debugger-server', String(port), 'about:blank',
    ], { env: { ...process.env, TMPDIR: artifacts }, stdio: ['ignore', 'pipe', 'pipe'] });
    browserExit = new Promise(resolve => browser.once('close', resolve));
    browser.stdout.on('data', data => { logs = (logs + data).slice(-4000); });
    browser.stderr.on('data', data => { logs = (logs + data).slice(-4000); });
  }
  async function stopBrowser() {
    rdp?.close();
    if (browser.exitCode === null && browser.signalCode === null) browser.kill('SIGTERM');
    let timer;
    await Promise.race([browserExit, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
    clearTimeout(timer);
    if (browser.exitCode === null && browser.signalCode === null) browser.kill('SIGKILL');
    await browserExit;
  }
  async function connectOptions() {
    rdp = await openNativeRdp(port);
    const rootActor = await rdp.request('root', 'getRoot');
    const installed = await rdp.request(rootActor.addonsActor, 'installTemporaryAddon', { addonPath: extension });
    expect(installed.addon.id).toBe(manifest.browser_specific_settings.gecko.id);
    const { addons } = await rdp.request('root', 'listAddons');
    const descriptor = addons.find(addon => addon.id === installed.addon.id);
    expect(descriptor.warnings).toEqual([]);
    const { processDescriptor } = await rdp.request('root', 'getProcess', { id: 0 });
    ({ process: parent } = await rdp.request(processDescriptor.actor, 'getTarget'));
    const optionsUrl = await rdp.evaluate(parent.consoleActor, `(() => {
      Cc["@mozilla.org/security/x509certdb;1"].getService(Ci.nsIX509CertDB)
        .addCertFromBase64(${JSON.stringify(ca.replace(/-----[^-]+-----|\s/g, ''))}, "CT,,");
      const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
      const extension = ExtensionParent.GlobalManager.getExtension(${JSON.stringify(installed.addon.id)});
      const url = extension.manifest.options_ui.page;
      const window = Services.wm.getMostRecentWindow("navigator:browser");
      window.gBrowser.selectedTab = window.gBrowser.addTab(url, {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
      });
      return url;
    })()`);
    const watcher = await rdp.request(descriptor.actor, 'getWatcher');
    watcherActor = watcher.actor;
    await rdp.request(watcher.actor, 'watchTargets', { targetType: 'frame' });
    const { target } = await rdp.event(packet => packet.type === 'target-available-form' && packet.target.url === optionsUrl);
    optionsConsole = target.consoleActor;
  }
  const evaluate = expression => rdp.evaluate(optionsConsole, expression);
  const request = message => evaluate(`browser.runtime.sendMessage(${JSON.stringify(message)}).then(response => {
    if (!response.ok) throw new Error(response.error.code); return response.value;
  })`);
  const state = () => request({ type: 'ui.state' });
  launch();
  try {
    await connectOptions();
    await request({ type: 'ui.configure', config: { connection_url: `${origin}/join/${tenant.id}`, local_protected_origins: [] } });
    await request({ type: 'ui.enroll', label: 'My Firefox' });
    store.approveEnrollment((await state()).enrollment.enrollment_id, ownerId, tenant.id);
    await expect.poll(async () => (await state()).phase).toBe('authenticated');
    const deviceId = (await state()).identity.device_id;
    const keyBefore = (await state()).key_id;
    client = new Client({ name: 'native-firefox-smoke', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${backend.port}/mcp/${tenant.id}`), {
      requestInit: { headers: { Authorization: `Bearer ${credentials.credential}` } },
    }));
    const userTab = await evaluate(`browser.tabs.create({url:${JSON.stringify(pageOrigin)},active:true})`);
    await expect.poll(() => evaluate(`browser.tabs.get(${userTab.id}).then(tab => tab.status)`)).toBe('complete');
    async function share() {
      const waiting = client.callTool({ name: 'request_browser_access', arguments: {
        device_id: deviceId, description: 'Share my selected Firefox tab',
      } });
      await expect.poll(async () => (await state()).pending.length).toBe(1);
      await evaluate(`browser.tabs.update(${userTab.id},{active:true})`);
      await request({ type: 'ui.approve', request_id: (await state()).pending[0].request_id, tabId: userTab.id });
      expect((await waiting).isError).not.toBe(true);
      await expect.poll(async () => (await state()).targets[0]?.state).toBe('active');
      return (await state()).targets[0];
    }
    let grant = await share();
    const advertised = (await state()).capabilities;
    expect(advertised).toContain('evaluate_script');
    expect(advertised.includes('get_screenshot')).toBe(await evaluate('typeof browser.tabs.captureTab === "function"'));
    async function call(name, args = {}, decision = 'approve') {
      if (name === 'get_text') args = { selector: 'body', ...args };
      const waiting = client.callTool({ name, arguments: {
        target_id: grant.target_id, description: `Native fixture ${name}`, ...args,
      } });
      if ((advertised.includes(name) && !grant.allow_all) || name === 'request_handoff') {
        await expect.poll(async () => (await state()).targets[0]?.commands[0]?.state).toBe('pending');
        const queued = (await state()).targets[0].commands[0];
        // Native RDP cannot provide trusted DOM gestures. Use only the trusted
        // options runtime boundary; never weaken the production overlay guard.
        await request({ type: 'ui.decision', target_id: grant.target_id,
          request_id: queued.request_id, action: decision });
      }
      return waiting;
    }
    expect(JSON.stringify(await call('get_text'))).toContain('Native owned page');
    expect(JSON.parse((await call('evaluate_script', {
      script: '[typeof globalThis.browser?.runtime, typeof globalThis.chrome?.runtime]',
    })).content[0].text)).toEqual({ value: ['undefined', 'undefined'] });
    const pendingHuman = client.callTool({ name: 'request_handoff', arguments: {
      target_id: grant.target_id, description: 'Complete login in the shared tab',
    } });
    await expect.poll(async () => (await state()).targets[0]?.commands[0]?.state).toBe('pending');
    await evaluate(`browser.tabs.update(${grant.tabId},{url:${JSON.stringify(`${pageOrigin}/after-login`)}})`);
    await expect.poll(() => evaluate(`browser.tabs.get(${grant.tabId}).then(tab => tab.status)`)).toBe('complete');
    await expect.poll(() => evaluate(`browser.scripting.executeScript({
      target:{tabId:${grant.tabId},frameIds:[0]},world:"ISOLATED",
      func:() => Boolean(document.querySelector("[data-domagent-sharing]")?.shadowRoot)
    }).then(results => results[0]?.result)`)).toBe(true);
    await evaluate(`browser.scripting.executeScript({
      target:{tabId:${grant.tabId},frameIds:[0]},world:"MAIN",
      func:() => {
        const root = document.querySelector("[data-domagent-sharing]").shadowRoot;
        Array.from(root.querySelectorAll("button")).find(button => button.textContent === "Done").click();
      }
    })`);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect((await state()).targets[0].commands[0].state).toBe('pending');
    await request({ type: 'ui.decision', target_id: grant.target_id,
      request_id: (await state()).targets[0].commands[0].request_id, action: 'done' });
    expect(JSON.parse((await pendingHuman).content[0].text)).toEqual({ state: 'completed', user_confirmed: true });
    expect((await state()).targets[0].state).toBe('active');
    await call('get_text', {}, 'allow_all');
    grant = (await state()).targets[0];
    expect((await call('click', { selector: '#explicit' })).isError).not.toBe(true);
    const capture = await call('get_screenshot');
    expect(capture.isError === true).toBe(!advertised.includes('get_screenshot'));
    expect((await call('navigate', { url: `${pageOrigin}/csp` })).isError).not.toBe(true);
    await expect.poll(() => evaluate(`browser.tabs.get(${grant.tabId}).then(tab => tab.status)`)).toBe('complete');
    expect(JSON.parse((await call('evaluate_script', { script: '41 + 1' })).content[0].text)).toEqual({ error: 'CAPABILITY_UNAVAILABLE' });
    expect((await call('get_text')).isError).not.toBe(true);
    await call('navigate', { url: `${pageOrigin}/redirect` });
    await expect.poll(async () => (await state()).targets.length).toBe(0);
    expect(protectedHits).toBe(0);
    expect(app.bridge.grants.size).toBe(0);
    await evaluate(`browser.tabs.update(${userTab.id},{url:${JSON.stringify(pageOrigin)},active:true})`);
    await expect.poll(() => evaluate(`browser.tabs.get(${userTab.id}).then(tab => tab.status)`)).toBe('complete');
    grant = await share();
    const beforeRestart = grant.target_id;
    await stopBrowser();
    await expect.poll(() => app.bridge.grants.size).toBe(0);
    launch();
    await connectOptions();
    await expect.poll(async () => (await state()).phase).toBe('authenticated');
    expect((await state()).key_id).toBe(keyBefore);
    expect((await state()).identity.device_id).toBe(deviceId);
    expect((await state()).targets).toEqual([]);
    const old = await client.callTool({ name: 'get_text', arguments: {
      target_id: beforeRestart, selector: 'body', description: 'Cannot resurrect the old grant',
    } });
    expect(old.isError).toBe(true);
    const unattendedConnection = app.bridge.connections.get(deviceId).connection_id;
    const unwatch = JSON.stringify({ to: watcherActor, type: 'unwatchTargets', targetType: 'frame' });
    rdp.socket.write(`${Buffer.byteLength(unwatch)}:${unwatch}`);
    await rdp.evaluate(parent.consoleActor, `(() => {
      for (const window of Services.wm.getEnumerator("navigator:browser")) {
        for (const tab of Array.from(window.gBrowser.tabs)) {
          if (tab.linkedBrowser.currentURI.spec.startsWith("moz-extension://")) window.gBrowser.removeTab(tab);
        }
      }
      return true;
    })()`);
    // No UI polling or extension page can keep this persistent MV2 background alive.
    await new Promise(resolve => setTimeout(resolve, 65_000));
    expect(app.bridge.connections.get(deviceId)?.connection_id).toBe(unattendedConnection);
    expect(app.bridge.grants.size).toBe(0);
    expect(app.bridge.targets(credentials.id)[0].state).toBe('approval_required');
  } catch (error) {
    console.error('[native Firefox fixture failure]', logs);
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
