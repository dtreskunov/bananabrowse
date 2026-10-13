const path = require('node:path');
const fs = require('node:fs/promises');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { freePort } = require('./firefox-rdp.cjs');
const { openNativeRdp } = require('./native-rdp.cjs');
const requireLocal = createRequire(path.join(__dirname, '../../../domagent-mcp/package.json'));
const { test, expect, firefox } = requireLocal('@playwright/test');

test('Firefox153 native user-script API: direct MAIN and isolated source execution under strict page CSP', async () => {
  const executable = process.env.DOMAGENT_FIREFOX_BINARY || firefox.executablePath();
  const version = execFileSync(executable, ['--version'], { encoding: 'utf8', env: { ...process.env, TMPDIR: '/tmp' } });
  expect(Number(version.match(/Firefox ([0-9]+)/)?.[1])).toBeGreaterThanOrEqual(153);
  const directory = path.resolve(__dirname, '../../.browser-artifacts/native-worlds');
  const profile = path.join(directory, 'profile');
  await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'DomAgent native world qualification', version: '1.0.0',
    browser_specific_settings: { gecko: { id: 'domagent-native-worlds@example.test', strict_min_version: '153.0' } },
    permissions: ['tabs'], optional_permissions: ['userScripts'], optional_host_permissions: ['http://*/*'],
    options_ui: { page: 'probe.html', open_in_tab: true },
  }));
  await fs.writeFile(path.join(directory, 'probe.html'), '<p>Native script qualification</p>');
  await fs.writeFile(path.join(profile, 'user.js'), [
    'user_pref("devtools.debugger.remote-enabled",true);',
    'user_pref("devtools.debugger.prompt-connection",false);',
    'user_pref("devtools.debugger.force-local",true);',
    'user_pref("devtools.chrome.enabled",true);',
  ].join('\n'));
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Security-Policy', "script-src 'none'; object-src 'none'");
    res.end('<title>Strict CSP fixture</title><h1>Original</h1>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = await freePort();
  const child = spawn(executable, ['--no-remote', '--headless', '--profile', profile,
    '--start-debugger-server', String(port), 'about:blank'], {
    env: { ...process.env, TMPDIR: '/tmp' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exit = new Promise(resolve => child.once('close', resolve));
  let rdp;
  try {
    rdp = await openNativeRdp(port);
    const root = await rdp.request('root', 'getRoot');
    const installed = await rdp.request(root.addonsActor, 'installTemporaryAddon', { addonPath: directory });
    const descriptor = (await rdp.request('root', 'listAddons')).addons.find(addon => addon.id === installed.addon.id);
    expect(descriptor.warnings).toEqual([]);
    const { processDescriptor } = await rdp.request('root', 'getProcess', { id: 0 });
    const { process: parent } = await rdp.request(processDescriptor.actor, 'getTarget');
    const url = await rdp.evaluate(parent.consoleActor, `(() => {
      const {ExtensionPermissions}=ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
      const {ExtensionParent}=ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
      const extension=ExtensionParent.GlobalManager.getExtension("domagent-native-worlds@example.test");
      const window=Services.wm.getMostRecentWindow("navigator:browser");
      return ExtensionPermissions.add(extension.id,{permissions:["userScripts"],origins:["http://*/*"]},extension).then(()=>{
        window.gBrowser.selectedTab=window.gBrowser.addTab(extension.manifest.options_ui.page,
          {triggeringPrincipal:Services.scriptSecurityManager.getSystemPrincipal()});
        return extension.manifest.options_ui.page;
      });
    })()`);
    const watcher = await rdp.request(descriptor.actor, 'getWatcher');
    await rdp.request(watcher.actor, 'watchTargets', { targetType: 'frame' });
    const { target } = await rdp.event(packet => packet.type === 'target-available-form' && packet.target.url === url);
    const evaluate = expression => rdp.evaluate(target.consoleActor, expression);
    const tab = await evaluate(`browser.tabs.create({url:${JSON.stringify(`http://127.0.0.1:${server.address().port}/`)},active:false})`);
    await expect.poll(() => evaluate(`browser.tabs.get(${tab.id}).then(tab=>tab.status)`)).toBe('complete');
    const execute = (world, code) => evaluate(`browser.userScripts.execute(${JSON.stringify({
      target: { tabId: tab.id, frameIds: [0] }, world, js: [{ code }],
    })})`);
    const main = await execute('MAIN', 'globalThis.nativeWorldFixture = "page"; document.title');
    console.log('Native MAIN source result:', main);
    expect(main[0].result).toBe('Strict CSP fixture');
    expect((await execute('USER_SCRIPT', 'typeof browser'))[0].result).toBe('undefined');
    expect((await execute('USER_SCRIPT', 'typeof globalThis.nativeWorldFixture'))[0].result).toBe('undefined');
    expect((await execute('MAIN', 'Promise.resolve(42)'))[0].result).toBe(42);
    const runtime = await execute('MAIN', 'throw new Error("Synthetic native stack failure")');
    console.log('Native exception contract:', runtime);
    expect(runtime[0].error).toBeTruthy();
    const syntax = await execute('MAIN', '(() =>');
    expect(syntax[0].error).toBeTruthy();
    expect((await execute('USER_SCRIPT', 'document.querySelector("h1").textContent = "Updated"; document.querySelector("h1").textContent'))[0].result).toBe('Updated');
    expect((await execute('MAIN', 'document.querySelector("h1").textContent'))[0].result).toBe('Updated');
  } finally {
    rdp?.close(); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exit; clearTimeout(timer);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
