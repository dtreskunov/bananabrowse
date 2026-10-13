const path = require('node:path');
const fs = require('node:fs/promises');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
const localRequire = createRequire(path.join(__dirname, '../../../domagent-mcp/package.json'));
const { freePort } = require('./firefox-rdp.cjs');
const { openNativeRdp } = require('./native-rdp.cjs');
const { test, expect, chromium, firefox } = localRequire('@playwright/test');

test('Chrome platform gate: native group and window-scoped panel close evidence', async () => {
  const root = path.resolve(__dirname, '../../..');
  const directory = path.join(root, 'domagent-extension/.browser-artifacts/platform');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'DomAgent platform fixture', version: '1.0.0',
    permissions: ['tabs', 'sidePanel', 'tabGroups'],
    background: { service_worker: 'background.js' },
    side_panel: { default_path: 'panel.html' },
  }));
  await fs.writeFile(path.join(directory, 'background.js'), `
    globalThis.observed=[];
    chrome.sidePanel.onOpened?.addListener(info => observed.push({event:'open',...info}));
    chrome.sidePanel.onClosed?.addListener(info => observed.push({event:'close',...info}));
    chrome.runtime.onConnect.addListener(port => {
      observed.push({event:'port'});
      port.onDisconnect.addListener(() => observed.push({event:'disconnect'}));
    });
  `);
  await fs.writeFile(path.join(directory, 'panel.html'), '<script src="panel.js"></script><p>Native panel fixture</p>');
  await fs.writeFile(path.join(directory, 'panel.js'), 'chrome.runtime.connect({name:"native-panel"});');
  await fs.writeFile(path.join(directory, 'probe.html'), '<button id="open">Open</button><script src="probe.js"></script>');
  await fs.writeFile(path.join(directory, 'probe.js'), `
    chrome.windows.getCurrent().then(window => {
      document.querySelector('#open').onclick=() => chrome.sidePanel.open({windowId:window.id});
    });
  `);
  const oldTmp = process.env.TMPDIR;
  process.env.TMPDIR = '/tmp';
  let context;
  try {
    context = await chromium.launchPersistentContext(path.join(directory, 'profile'), {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${directory}`, `--load-extension=${directory}`, '--no-sandbox'],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const api = await worker.evaluate(() => ({
      open: !!chrome.sidePanel.onOpened, close: !!chrome.sidePanel.onClosed,
      groups: !!chrome.tabs.group && !!chrome.tabGroups.update,
    }));
    expect(api).toEqual({ open: true, close: true, groups: true });
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/probe.html`);
    const windowId = await page.evaluate(() => chrome.windows.getCurrent().then(window => window.id));
    const tab = await page.evaluate(() => chrome.tabs.create({ active: false, url: 'about:blank' }));
    const grouped = await page.evaluate(async tabId => {
      const groupId = await chrome.tabs.group({ tabIds: [tabId] });
      return chrome.tabGroups.update(groupId, { title: 'DomAgent gate', color: 'blue' });
    }, tab.id);
    expect(grouped.title).toBe('DomAgent gate');
    await page.click('#open');
    await expect.poll(() => worker.evaluate(() => observed.some(entry => entry.event === 'port'))).toBe(true);
    await page.evaluate(windowId => chrome.sidePanel.close({ windowId }), windowId);
    await expect.poll(() => worker.evaluate(() => observed.some(entry => entry.event === 'close'))).toBe(true);
    console.log('Native Chrome gate evidence:', await worker.evaluate(() => observed));
  } finally {
    await context?.close();
    if (oldTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = oldTmp;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Firefox platform gate: native group API and sidebar open state follows browser UI', async () => {
  const root = path.resolve(__dirname, '../../..');
  const directory = path.join(root, 'domagent-extension/.browser-artifacts/platform-firefox');
  const profile = path.join(directory, 'profile');
  await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
    manifest_version: 2, name: 'DomAgent Firefox platform fixture', version: '1.0.0',
    browser_specific_settings: { gecko: { id: 'domagent-gate@example.test' } },
    permissions: ['tabs', 'tabGroups'],
    background: { scripts: ['background.js'], persistent: true },
    sidebar_action: { default_title: 'DomAgent platform gate', default_panel: 'panel.html' },
    options_ui: { page: 'probe.html', open_in_tab: true },
  }));
  await fs.writeFile(path.join(directory, 'background.js'), `
    browser.runtime.onConnect.addListener(port => port.onDisconnect.addListener(() => {}));
  `);
  await fs.writeFile(path.join(directory, 'panel.html'), '<script src="panel.js"></script><p>Native sidebar gate</p>');
  await fs.writeFile(path.join(directory, 'panel.js'), 'browser.runtime.connect({name:"native-panel"});');
  await fs.writeFile(path.join(directory, 'probe.html'), '<p>Native platform gate</p>');
  await fs.writeFile(path.join(profile, 'user.js'), [
    'user_pref("devtools.debugger.remote-enabled",true);',
    'user_pref("devtools.debugger.prompt-connection",false);',
    'user_pref("devtools.debugger.force-local",true);',
    'user_pref("devtools.chrome.enabled",true);',
  ].join('\n'));
  const port = await freePort();
  const child = spawn(firefox.executablePath(), [
    '--no-remote', '--headless', '--profile', profile, '--start-debugger-server', String(port), 'about:blank',
  ], { env: { ...process.env, TMPDIR: '/tmp' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let rdp;
  const exited = new Promise(resolve => child.once('close', resolve));
  try {
    rdp = await openNativeRdp(port);
    const rootActor = await rdp.request('root', 'getRoot');
    const addon = await rdp.request(rootActor.addonsActor, 'installTemporaryAddon', { addonPath: directory });
    const descriptor = (await rdp.request('root', 'listAddons')).addons.find(entry => entry.id === addon.addon.id);
    expect(descriptor.warnings).toEqual([]);
    const { processDescriptor } = await rdp.request('root', 'getProcess', { id: 0 });
    const { process: parent } = await rdp.request(processDescriptor.actor, 'getTarget');
    const optionsUrl = await rdp.evaluate(parent.consoleActor, `(() => {
      const {ExtensionParent}=ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
      const extension=ExtensionParent.GlobalManager.getExtension("domagent-gate@example.test");
      const window=Services.wm.getMostRecentWindow("navigator:browser");
      const url=extension.manifest.options_ui.page;
      window.gBrowser.selectedTab=window.gBrowser.addTab(url,{triggeringPrincipal:Services.scriptSecurityManager.getSystemPrincipal()});
      return url;
    })()`);
    const watcher = await rdp.request(descriptor.actor, 'getWatcher');
    await rdp.request(watcher.actor, 'watchTargets', { targetType: 'frame' });
    const { target } = await rdp.event(packet => packet.type === 'target-available-form' && packet.target.url === optionsUrl);
    const evaluate = expression => rdp.evaluate(target.consoleActor, expression);
    await rdp.evaluate(parent.consoleActor, 'Services.wm.getMostRecentWindow("navigator:browser").SidebarController.hide()');
    expect(await evaluate('browser.sidebarAction.isOpen({})')).toBe(false);
    const group = await evaluate(`browser.tabs.create({url:"about:blank",active:false}).then(tab =>
      browser.tabs.group({tabIds:[tab.id]})).then(groupId =>
      browser.tabGroups.update(groupId,{title:"DomAgent gate",color:"blue"}))`);
    expect(group.title).toBe('DomAgent gate');
    const command = await rdp.evaluate(parent.consoleActor, `(() => {
      const window=Services.wm.getMostRecentWindow("navigator:browser");
      return Array.from(window.SidebarController.sidebars.keys()).find(id => id.includes("domagent-gate"));
    })()`);
    expect(typeof command).toBe('string');
    await rdp.evaluate(parent.consoleActor, `Services.wm.getMostRecentWindow("navigator:browser").SidebarController.show(${JSON.stringify(command)})`);
    expect(await evaluate('browser.sidebarAction.isOpen({})')).toBe(true);
    await rdp.evaluate(parent.consoleActor, 'Services.wm.getMostRecentWindow("navigator:browser").SidebarController.hide()');
    expect(await evaluate('browser.sidebarAction.isOpen({})')).toBe(false);
    console.log('Native Firefox gate: actual group and native open/close state verified.');
  } finally {
    rdp?.close();
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(timer);
    await fs.rm(directory, { recursive: true, force: true });
  }
});
