const path = require('node:path');
const fs = require('node:fs/promises');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
const { freePort } = require('./firefox-rdp.cjs');
const { openNativeRdp } = require('./native-rdp.cjs');
const { exerciseActions } = require('./action-fixtures.cjs');
const { startService, description, root } = require('./v6-fixture.cjs');
const localRequire = createRequire(path.join(root, 'bananabrowse-mcp/package.json'));
const { test, expect, firefox } = localRequire('@playwright/test');
const ADDON = 'bananabrowse-secure@bananabrowse';

test('v6 native Firefox: app window, pairing, session, actions, user scripts, close, reattach across restart', async () => {
  test.setTimeout(240_000);
  const directory = path.join(root, 'bananabrowse-extension/.browser-artifacts/v6-firefox');
  await fs.rm(directory, { recursive: true, force: true });
  const service = await startService(directory);
  const profile = path.join(directory, 'profile'),
    extension = path.join(directory, 'extension');
  await fs.mkdir(profile, { recursive: true });
  await fs.cp(path.join(root, 'dist/firefox'), extension, { recursive: true });
  await fs.writeFile(
    path.join(profile, 'user.js'),
    [
      'user_pref("devtools.debugger.remote-enabled",true);',
      'user_pref("devtools.debugger.prompt-connection",false);',
      'user_pref("devtools.debugger.force-local",true);',
      'user_pref("devtools.chrome.enabled",true);',
      'user_pref("browser.startup.page",3);',
      'user_pref("browser.sessionstore.resume_from_crash",true);',
      'user_pref("browser.tabs.groups.enabled",true);',
      'user_pref("extensions.webextensions.keepStorageOnUninstall",true);',
      'user_pref("extensions.webextensions.keepUuidOnUninstall",true);',
    ].join('\n'),
  );
  const port = await freePort();
  let child, exit, rdp, parent, appConsole;
  const launch = () => {
    child = spawn(
      process.env.BANANABROWSE_FIREFOX_BINARY || firefox.executablePath(),
      ['--headless', '--no-remote', '--profile', profile, '--start-debugger-server', String(port), 'about:blank'],
      { env: { ...process.env, TMPDIR: '/tmp' }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    exit = new Promise((resolve) => child.once('close', resolve));
  };
  const stop = async () => {
    rdp?.close();
    rdp = null;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    await exit;
    clearTimeout(timer);
  };
  const evaluateParent = (expression) => rdp.evaluate(parent.consoleActor, expression);
  const install = async () => {
    rdp = await openNativeRdp(port);
    const rootActor = await rdp.request('root', 'getRoot');
    const { processDescriptor } = await rdp.request('root', 'getProcess', { id: 0 });
    ({ process: parent } = await rdp.request(processDescriptor.actor, 'getTarget'));
    await evaluateParent(`Cc["@mozilla.org/security/x509certdb;1"].getService(Ci.nsIX509CertDB)
      .addCertFromBase64(${JSON.stringify(service.ca)},"CT,,") && true`);
    const installed = await rdp.request(rootActor.addonsActor, 'installTemporaryAddon', { addonPath: extension });
    const descriptor = (await rdp.request('root', 'listAddons')).addons.find(
      (addon) => addon.id === installed.addon.id,
    );
    expect(descriptor.warnings).toEqual([]);
    // Native permission store stands in for the user's click-time grants (not a broadened manifest).
    await evaluateParent(`(() => {
      const {ExtensionPermissions}=ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
      const {ExtensionParent}=ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
      return ExtensionPermissions.add("${ADDON}", {permissions:["userScripts"],origins:["http://*/*","https://*/*"]},
        ExtensionParent.GlobalManager.getExtension("${ADDON}")).then(() => true);
    })()`);
    const watcher = await rdp.request(descriptor.actor, 'getWatcher');
    await rdp.request(watcher.actor, 'watchTargets', { targetType: 'frame' });
    return { descriptor, watcher };
  };
  const findTarget = async (suffix) => {
    const target = await rdp.event(
      (packet) => packet.type === 'target-available-form' && packet.target.url.endsWith(suffix),
    );
    const actor = target.target.consoleActor;
    // The target exists before the page script has booted the controller.
    if (suffix === '/app.html') {
      await expect
        .poll(() => rdp.evaluateRaw(actor, 'typeof globalThis.bananabrowse?.controller'), { timeout: 15_000 })
        .toBe('object');
    }
    return actor;
  };
  const app = (expression) =>
    rdp.evaluate(appConsole, `(() => { const c = globalThis.bananabrowse.controller; return (${expression}); })()`);
  const poll = (expression, options) => expect.poll(() => app(expression), { timeout: 15_000, ...options });
  launch();
  try {
    await install();
    // Installation opens the app window; it is a popup-type window.
    appConsole = await findTarget('/app.html');
    expect(await rdp.evaluate(appConsole, 'browser.windows.getCurrent().then(w => w.type)')).toBe('popup');
    await app(`c.setup({ domain: ${JSON.stringify(service.origin)}, name: "Bob's Firefox" }).then(() => true)`);
    await poll('c.phase').toBe('online');
    await app('c.startPairing() || true');
    await poll('c.pairing?.state').toBe('waiting');
    const agent = await service.mcp();
    const pairing = agent.call('pair_browser', { code: await app('c.pairing.code') });
    await poll('c.pairing?.proposal?.agent.name').toBe('Atlas');
    await app('c.decidePairing(true) || true');
    const paired = await pairing;
    expect(paired).toMatchObject({ name: "Bob's Firefox", paired: true });

    const requested = agent.call('request_session', {
      browser_id: paired.browser_id,
      purpose: 'Native Firefox fixture',
      urls: [service.pageUrl],
      title: 'Firefox task',
    });
    await poll('c.requests.size').toBe(1);
    await app('c.approveSession([...c.requests.keys()][0]).then(() => true)');
    const session = await requested;
    expect(session.tabs).toHaveLength(1);
    const tabId = session.tabs[0].tab_id;
    const call = (name, args = {}) => agent.raw(name, { tab_id: tabId, description, ...args });
    expect((await call('wait_for_page')).isError).not.toBe(true);
    await exerciseActions(call);
    const isolated = await agent.call('evaluate_script', {
      tab_id: tabId,
      description,
      script: '(() => { globalThis.fixtureScratch = 1; return typeof document.querySelector("h1").textContent; })()',
      world: 'USER_SCRIPT',
    });
    expect(isolated).toMatchObject({ value: 'string', execution_world: 'USER_SCRIPT' });
    // Protected origins stay blocked by the window's webRequest guard.
    await expect(agent.call('navigate', { tab_id: tabId, url: service.origin, description })).rejects.toMatchObject({
      code: 'HANDOFF_REQUIRED',
    });

    const handoff = agent.call('request_handoff', { tab_id: tabId, instructions: 'Confirm the native fixture' });
    await poll('c.handoffs.size').toBe(1);
    await app('c.decideHandoff([...c.handoffs.keys()][0], "done") || true');
    expect(await handoff).toEqual({ state: 'completed', user_confirmed: true });
    await agent.call('report_progress', { session_id: session.session_id, message: 'Native Firefox halfway' });
    await poll('c.feed.some(entry => entry.description === "Native Firefox halfway")').toBe(true);
    const tagged = await app(`browser.tabs.query({ groupId: [...c.sessions.values()][0].groupId })
      .then(tabs => browser.sessions.getTabValue(tabs[0].id, "bananabrowse"))`);
    expect(tagged).toEqual({ client_id: expect.any(String), tab_id: tabId });

    // Closing the window disconnects; reopening reattaches without approval.
    await app('browser.windows.getCurrent().then(w => browser.windows.remove(w.id)).then(() => true)').catch(
      () => null,
    );
    await expect.poll(async () => (await agent.call('list_browsers'))[0].online, { timeout: 15_000 }).toBe(false);
    expect((await agent.call('list_sessions'))[0].state).toBe('detached');
    await evaluateParent(`(() => { const w = Services.wm.getMostRecentWindow("navigator:browser");
      w.gBrowser.selectedTab = w.gBrowser.addTab("moz-extension://" +
        WebExtensionPolicy.getByID("${ADDON}").mozExtensionHostname + "/app.html",
        { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); return true; })()`);
    appConsole = await findTarget('/app.html');
    await poll('c.phase').toBe('online');
    await expect.poll(async () => (await agent.call('list_sessions'))[0]?.state, { timeout: 15_000 }).toBe('attached');
    expect((await agent.call('list_tabs', { session_id: session.session_id })).map((tab) => tab.tab_id)).toEqual([
      tabId,
    ]);

    // Full browser restart: Firefox restores the group and per-tab values keep the same session and tab IDs.
    await app('(c.shutdown(), true)');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await stop();
    launch();
    await install();
    appConsole = await findTarget('/app.html');
    await poll('c.phase', { timeout: 20_000 }).toBe('online');
    await expect.poll(async () => (await agent.call('list_sessions'))[0]?.state, { timeout: 20_000 }).toBe('attached');
    expect((await agent.call('list_tabs', { session_id: session.session_id })).map((tab) => tab.tab_id)).toEqual([
      tabId,
    ]);
    // Firefox restores the tab lazily and never re-submits the last POST: same ID, navigation-only until navigated.
    await expect(agent.call('get_text', { tab_id: tabId, description, selector: 'h1' })).rejects.toMatchObject({
      code: 'DOCUMENT_NOT_CONTROLLABLE',
    });
    await agent.call('navigate', { tab_id: tabId, url: service.pageUrl, description });
    await agent.call('wait_for_page', { tab_id: tabId, description });
    expect((await agent.call('get_text', { tab_id: tabId, description, selector: 'h1' })).text).toBe(
      'Approved session fixture',
    );

    const tabCount = 'browser.tabs.query({}).then(tabs => tabs.length)';
    const before = await app(tabCount);
    const ending = agent.call('end_session', { session_id: session.session_id, close_tabs: true, description });
    await poll('c.closures.size').toBe(1);
    expect(await app(tabCount)).toBe(before);
    await app('c.decideClose([...c.closures.keys()][0], true) || true');
    expect(await ending).toEqual({ session_id: session.session_id, ended: true, tabs_closed: true });
    await poll('c.sessions.size').toBe(0);
    await poll('browser.tabGroups.query({}).then(groups => groups.length)').toBe(0);
    await poll(tabCount).toBe(before - 1);
  } finally {
    await stop().catch(() => {});
    await service.close();
  }
});
