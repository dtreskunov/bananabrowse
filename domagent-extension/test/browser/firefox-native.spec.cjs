const path = require('node:path');
const fs = require('node:fs/promises');
const https = require('node:https');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const { spawn, execFileSync } = require('node:child_process');
const { freePort } = require('./firefox-rdp.cjs');
const { openNativeRdp } = require('./native-rdp.cjs');
const { actionHtml, exerciseActions, respondToForm } = require('./action-fixtures.cjs');
const root = path.resolve(__dirname, '../../..');
const localRequire = createRequire(path.join(root, 'domagent-mcp/package.json'));
const { test, expect, firefox } = localRequire('@playwright/test');
const { Client } = localRequire('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = localRequire('@modelcontextprotocol/sdk/client/streamableHttp.js');
const description = 'Operate only this explicitly authorized disposable browser fixture';

test('v5 native Firefox: pairing, native sidebar lease, grouped background actions and persistent identity', async () => {
  test.setTimeout(180000);
  const { Store } = await import(pathToFileURL(path.join(root, 'domagent-mcp/store.js')).href);
  const { createApp } = await import(pathToFileURL(path.join(root, 'domagent-mcp/app.js')).href);
  const directory = path.join(root, 'domagent-extension/.browser-artifacts/v5-native');
  const profile = path.join(directory, 'profile'), extension = path.join(directory, 'extension');
  await fs.mkdir(profile, { recursive: true });
  await fs.cp(path.join(root, 'dist/firefox'), extension, { recursive: true });
  const manifestPath = path.join(extension, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', path.join(directory, 'ca-key.pem'), '-out', path.join(directory, 'ca.pem'),
    '-days', '1', '-subj', '/CN=DomAgent v5 native CA', '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign'], { stdio: 'ignore' });
  execFileSync('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', path.join(directory, 'key.pem'), '-out', path.join(directory, 'server.csr'),
    '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
  await fs.writeFile(path.join(directory, 'server.ext'),
    'subjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth');
  execFileSync('openssl', ['x509', '-req', '-in', path.join(directory, 'server.csr'),
    '-CA', path.join(directory, 'ca.pem'), '-CAkey', path.join(directory, 'ca-key.pem'), '-CAcreateserial',
    '-out', path.join(directory, 'cert.pem'), '-days', '1', '-extfile', path.join(directory, 'server.ext')], { stdio: 'ignore' });
  const ca = (await fs.readFile(path.join(directory, 'ca.pem'), 'utf8')).replace(/-----[^-]+-----|\s/g, '');
  let app;
  const tls = https.createServer({ key: await fs.readFile(path.join(directory, 'key.pem')),
    cert: await fs.readFile(path.join(directory, 'cert.pem')) }, (req, res) => app.server.listeners('request')[0](req, res));
  tls.on('upgrade', (req, socket, head) => app.bridge.upgrade(req, socket, head));
  await new Promise(resolve => tls.listen(0, '127.0.0.1', resolve));
  const origin = `https://127.0.0.1:${tls.address().port}`;
  const store = new Store(':memory:'), clientInfo = store.createClient('Atlas');
  app = createApp(store, { origin, protectedOrigins: [origin], bind: '127.0.0.1', port: 0 });
  const address = await app.listen();
  const pageServer = http.createServer(async (req, res) => {
    if (await respondToForm(req, res)) return;
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/strict-csp') {
      res.setHeader('Content-Security-Policy', "script-src 'none'; object-src 'none'");
      res.end('<title>Native strict CSP</title><h1 id="strict-heading">Native DOM</h1>');
      return;
    }
    res.end('<title>Native v5 page</title><h1>Grouped background fixture</h1>' + actionHtml);
  });
  await new Promise(resolve => pageServer.listen(0, '127.0.0.1', resolve));
  const pageUrl = `http://127.0.0.1:${pageServer.address().port}/`;
  await fs.writeFile(path.join(profile, 'user.js'), [
    'user_pref("devtools.debugger.remote-enabled",true);',
    'user_pref("devtools.debugger.prompt-connection",false);',
    'user_pref("devtools.debugger.force-local",true);',
    'user_pref("devtools.chrome.enabled",true);',
    'user_pref("devtools.jsonview.enabled",true);',
  ].join('\n'));
  const port = await freePort();
  let child, exit, rdp, client, parent, consoleActor, sidebarCommand;
  const launch = () => {
    child = spawn(process.env.DOMAGENT_FIREFOX_BINARY || firefox.executablePath(), ['--headless', '--no-remote', '--profile', profile,
      '--start-debugger-server', String(port), 'about:blank'], { env: { ...process.env, TMPDIR: '/tmp' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    exit = new Promise(resolve => child.once('close', resolve));
  };
  const stop = async () => {
    rdp?.close(); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exit; clearTimeout(timer);
  };
  const connect = async (addonPath = extension) => {
    if (!rdp) rdp = await openNativeRdp(port);
    const rootActor = await rdp.request('root', 'getRoot');
    const installed = await rdp.request(rootActor.addonsActor, 'installTemporaryAddon', { addonPath });
    const descriptor = (await rdp.request('root', 'listAddons')).addons.find(addon => addon.id === installed.addon.id);
    expect(descriptor.warnings).toEqual([]);
    const { processDescriptor } = await rdp.request('root', 'getProcess', { id: 0 });
    ({ process: parent } = await rdp.request(processDescriptor.actor, 'getTarget'));
    const url = await rdp.evaluate(parent.consoleActor, `(() => {
      Cc["@mozilla.org/security/x509certdb;1"].getService(Ci.nsIX509CertDB).addCertFromBase64(${JSON.stringify(ca)},"CT,,");
      const {ExtensionParent}=ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
      const extension=ExtensionParent.GlobalManager.getExtension("domagent-secure@domagent");
      const window=Services.wm.getMostRecentWindow("navigator:browser");
      window.gBrowser.selectedTab=window.gBrowser.addTab(extension.manifest.options_ui.page,
        {triggeringPrincipal:Services.scriptSecurityManager.getSystemPrincipal()});
      return extension.manifest.options_ui.page;
    })()`);
    await rdp.evaluate(parent.consoleActor, `(() => {
      const {ExtensionPermissions}=ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
      const {ExtensionParent}=ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
      return ExtensionPermissions.add("domagent-secure@domagent",
        {permissions:${JSON.stringify(addonPath === extension ? ['userScripts'] : [])},origins:["http://*/*","https://*/*"]},
        ExtensionParent.GlobalManager.getExtension("domagent-secure@domagent"));
    })()`);
    const watcher = await rdp.request(descriptor.actor, 'getWatcher');
    await rdp.request(watcher.actor, 'watchTargets', { targetType: 'frame' });
    const { target } = await rdp.event(packet => packet.type === 'target-available-form' && packet.target.url === url);
    consoleActor = target.consoleActor;
    sidebarCommand = await rdp.evaluate(parent.consoleActor, `Array.from(
      Services.wm.getMostRecentWindow("navigator:browser").SidebarController.sidebars.keys()
    ).find(id=>id.includes("domagent-secure"))`);
    await rdp.evaluate(parent.consoleActor,
      `Services.wm.getMostRecentWindow("navigator:browser").SidebarController.show(${JSON.stringify(sidebarCommand)})`);
  };
  const evaluate = expression => rdp.evaluate(consoleActor, expression);
  const request = message => evaluate(`browser.runtime.sendMessage(${JSON.stringify(message)}).then(response=>{
    if(!response.ok)throw new Error(response.error.code);return response.value;
  })`);
  const state = () => request({ type: 'ui.state' });
  launch();
  try {
    const legacy = process.env.DOMAGENT_LEGACY_FIREFOX_EXTENSION;
    await connect(legacy || extension);
    expect(await evaluate('browser.permissions.contains({origins:["http://*/*","https://*/*"]})')).toBe(true);
    await request({ type: 'ui.configure', service_origin: origin });
    client = new Client({ name: 'v5-native-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp/${clientInfo.tenant_id}`), {
      requestInit: { headers: { Authorization: `Bearer ${clientInfo.credential}` } },
    }));
    await client.callTool({ name: 'adopt_browser', arguments: { pairing_code: (await state()).pairing.code } });
    await expect.poll(async () => (await state()).pairing?.state).toBe('proposed');
    await request({ type: 'ui.confirmPairing' });
    await expect.poll(async () => (await state()).phase).toBe('authenticated');
    const device = (await state()).identity.device_id;
    if (legacy) {
      console.log('Legacy MV2 pairing authenticated; loading MV3 into the same persisted profile after restart.');
      await stop(); rdp = null; launch();
      await connect();
      await expect.poll(async () => (await state()).phase).toBe('authenticated');
      expect((await state()).identity.device_id).toBe(device);
      expect((await state()).workspaces).toHaveLength(0);
      expect((await state()).browser_info.extension_version).toBe(manifest.version);
      console.log('Real MV2 5.0.4 -> MV3 same-profile identity/storage upgrade verified; no re-pairing.');
    }
    const windowId = await evaluate('browser.windows.getCurrent().then(window=>window.id)');
    await new Promise(resolve => setTimeout(resolve, 500));
    await request({ type: 'ui.start', windowId });
    const workspace = (await state()).workspaces[0];
    const listing = async () => JSON.parse((await client.callTool({ name: 'list_workspace_tabs',
      arguments: { workspace_id: workspace.workspace_id } })).content[0].text);
    await expect.poll(async () => (await listing()).length).toBe(1);
    let target = (await listing())[0];
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: { target_id: target.target_id, description, ...args } });
      if (result.isError && name === 'get_page_snapshot') console.log('Synthetic native snapshot refusal:',
        result, await state(), await evaluate(`browser.tabs.query({groupId:${workspace.groupId}})`));
      return result;
    };
    expect((await call('navigate', { url: pageUrl })).isError).not.toBe(true);
    const waiting = await call('wait_for_page');
    if (waiting.isError) console.log('Native navigation fixture failure:', waiting,
      await evaluate(`browser.tabs.query({groupId:${workspace.groupId}})`));
    expect(waiting.isError).not.toBe(true);
    await expect.poll(async () => (await listing())[0].page_state).toBe('ready');
    await exerciseActions(call);
    expect((await call('navigate', { url: `${pageUrl}strict-csp` })).isError).not.toBe(true);
    const content = await call('wait_for_page', { content_selector: '#strict-heading' });
    expect(content.isError).not.toBe(true);
    expect(JSON.parse(content.content[0].text).content_ready).toBe(true);
    const main = await call('evaluate_script', { world: 'MAIN', script: 'globalThis.fixtureMainValue = 42; document.title' });
    expect(main.isError).not.toBe(true);
    expect(JSON.parse(main.content[0].text)).toMatchObject({ value: 'Native strict CSP', execution_world: 'MAIN' });
    const user = await call('evaluate_script', { world: 'USER_SCRIPT',
      script: '({ dom: document.querySelector("h1").textContent, page: typeof globalThis.fixtureMainValue, privileged: typeof browser, dynamic: new Function("return 42")() })' });
    expect(user.isError).not.toBe(true);
    expect(JSON.parse(user.content[0].text)).toMatchObject({ execution_world: 'USER_SCRIPT',
      value: { dom: 'Native DOM', page: 'undefined', privileged: 'undefined', dynamic: 42 } });
    const policy = await call('evaluate_script', { world: 'MAIN', script: 'new Function("return 42")()' });
    expect(policy.isError).toBe(true);
    const policyError = JSON.parse(policy.content[0].text);
    expect(policyError.error).toBe('SCRIPT_POLICY_BLOCKED');
    expect(policyError.diagnostics.name).toBe('EvalError');
    expect(policyError.diagnostics.stack).toBeTruthy();
    expect((await call('navigate', { url: pageUrl })).isError).not.toBe(true);
    expect((await call('wait_for_page')).isError).not.toBe(true);
    const unshared = await evaluate(`browser.tabs.create({url:${JSON.stringify(pageUrl)},active:true})`);
    expect((await call('get_text', { selector: 'body' })).isError).not.toBe(true);
    expect((await listing()).some(tab => tab.tab_id === unshared.id)).toBe(false);
    await rdp.evaluate(parent.consoleActor, 'Services.wm.getMostRecentWindow("navigator:browser").SidebarController.hide()');
    await new Promise(resolve => setTimeout(resolve, 35000));
    expect((await state()).workspaces[0].state).toBe('active');
    expect((await call('get_text', { selector: 'body' })).isError).not.toBe(true);
    await request({ type: 'ui.pauseAll' });
    await expect.poll(async () => (await state()).workspaces[0].state).toBe('paused');
    expect((await call('get_text', { selector: 'body' })).isError).toBe(true);
    expect(await evaluate(`browser.tabs.query({groupId:${workspace.groupId}}).then(tabs=>tabs.length)`)).toBe(1);
    await stop(); rdp = null; launch(); await connect();
    await expect.poll(async () => (await state()).phase).toBe('authenticated');
    expect((await state()).identity.device_id).toBe(device);
    expect((await state()).workspaces).toHaveLength(0);
  } finally {
    await client?.close(); await stop(); await app.close(); store.close();
    tls.closeAllConnections(); pageServer.closeAllConnections();
    await Promise.all([new Promise(resolve => tls.close(resolve)), new Promise(resolve => pageServer.close(resolve))]);
    await fs.rm(directory, { recursive: true, force: true });
  }
});
