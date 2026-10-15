const path = require('node:path');
const fs = require('node:fs/promises');
const { createRequire } = require('node:module');
const { startService, description, root } = require('./v6-fixture.cjs');
const { exerciseActions } = require('./action-fixtures.cjs');
const localRequire = createRequire(path.join(root, 'domagent-mcp/package.json'));
const { test, expect, chromium } = localRequire('@playwright/test');

test('v6 Chrome: app window setup, pairing, approved session, actions, handoff, close and reattach', async () => {
  test.setTimeout(180_000);
  const directory = path.join(root, 'domagent-extension/.browser-artifacts/v6-chrome');
  await fs.rm(directory, { recursive: true, force: true });
  const service = await startService(directory);
  const extension = path.join(directory, 'extension');
  await fs.cp(path.join(root, 'dist/chrome'), extension, { recursive: true });
  const manifestPath = path.join(extension, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  // Pre-grant site access so the real click-time permission request resolves without a native prompt.
  manifest.host_permissions = ['http://*/*', 'https://*/*'];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const previousTmp = process.env.TMPDIR; process.env.TMPDIR = '/tmp';
  let context;
  try {
    context = await chromium.launchPersistentContext(path.join(directory, 'profile'), {
      channel: 'chromium', headless: true, ignoreHTTPSErrors: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--ignore-certificate-errors', '--no-sandbox'],
    });
    context.on('console', message => { if (message.type() === 'error') console.error('Extension console:', message.text()); });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const appUrl = `chrome-extension://${new URL(worker.url()).host}/app.html`;
    const findApp = async () => {
      await expect.poll(() => context.pages().some(page => page.url() === appUrl), { timeout: 15_000 }).toBe(true);
      return context.pages().find(page => page.url() === appUrl);
    };
    // Installing opens the app window as a popup-type window.
    let app = await findApp();
    expect(await worker.evaluate(() => chrome.windows.getAll({ windowTypes: ['popup'] }).then(w => w.length))).toBe(1);

    await app.locator('#domain').fill(service.origin);
    await app.locator('#name').fill("Bob's Chrome");
    await app.getByRole('button', { name: 'Connect' }).click();
    await expect(app.locator('.status')).toHaveText('Connected', { timeout: 15_000 });
    await expect(app.getByRole('heading', { name: "Bob's Chrome" })).toBeVisible();

    await app.getByRole('button', { name: 'Pair an agent' }).click();
    await expect(app.getByText(/Expires in/)).toBeVisible();
    const code = (await app.locator('output.code').textContent()).trim();
    expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const agent = await service.mcp();
    const pairing = agent.call('pair_browser', { code });
    await expect(app.getByRole('heading', { name: 'Pair with Atlas?' })).toBeVisible();
    await app.getByRole('button', { name: 'Approve' }).click();
    const paired = await pairing;
    expect(paired).toMatchObject({ name: "Bob's Chrome", paired: true });
    expect(await agent.call('list_browsers')).toEqual([expect.objectContaining({ browser_id: paired.browser_id, online: true })]);

    const requested = agent.call('request_session', { browser_id: paired.browser_id, purpose: 'Check the disposable fixture page' +
      ' and then keep going with a deliberately long purpose that would not fit on a single line of the window'.repeat(3),
      urls: [service.pageUrl], title: 'Fixture task' });
    await expect(app.getByRole('heading', { name: 'Atlas wants to open a session' })).toBeVisible();
    await expect(app.getByText(/^Check the disposable fixture page/)).toBeVisible();
    await app.getByRole('button', { name: 'Approve' }).click();
    const session = await requested;
    expect(session).toMatchObject({ state: 'attached', title: 'Fixture task' });
    expect(session.tabs).toHaveLength(1);
    const tabId = session.tabs[0].tab_id;
    const group = await worker.evaluate(() => chrome.tabGroups.query({ title: 'Fixture task' }).then(groups => groups[0]));
    expect(group.color).toBe('green');
    expect(await worker.evaluate(id => chrome.tabs.query({ groupId: id }).then(tabs => tabs.map(t => t.active)), group.id)).toEqual([false]);

    const call = (name, args = {}) => agent.raw(name, { tab_id: tabId, description, ...args });
    const waited = await call('wait_for_page');
    expect(waited.isError).not.toBe(true);
    await exerciseActions(call);
    await expect(app.getByText('Atlas', { exact: true }).first()).toBeVisible();
    await expect(app.locator('.feed').first()).toBeVisible();

    const created = await agent.call('create_tab', { session_id: session.session_id, url: `${service.pageUrl}login`, description });
    expect(created.tab_id).toMatch(/^t[0-9a-z]+$/);
    // A tab the user drags into the group is in scope too.
    await worker.evaluate(async ({ id, url }) => {
      const tab = await chrome.tabs.create({ url, active: false });
      await chrome.tabs.group({ groupId: id, tabIds: [tab.id] });
    }, { id: group.id, url: `${service.pageUrl}login` });
    await expect.poll(async () => (await agent.call('list_tabs', { session_id: session.session_id })).length).toBe(3);

    await agent.call('report_progress', { session_id: session.session_id, message: 'Fixture checks are halfway done' });
    await expect(app.getByText('Fixture checks are halfway done')).toBeVisible();

    const handoff = agent.call('request_handoff', { tab_id: tabId, instructions: 'Confirm the fixture page looks right. ' +
      'Order #WN65795153 https://example.test/a/very/long/unbroken/path/'.repeat(4) + 'x'.repeat(200) })
      .then(value => ({ value }), error => ({ error }));
    await expect(app.getByRole('heading', { name: 'Atlas needs your help' })).toBeVisible();
    // Long instructions, purposes and tab titles wrap or ellipsize; nothing scrolls sideways, even in a narrow window.
    expect(await app.locator('textarea').count()).toBe(0);
    for (const width of [900, 360]) {
      await app.setViewportSize({ width, height: 760 });
      expect(await app.evaluate(() => [...document.querySelectorAll('main *')]
        .filter(element => element.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
        .map(element => element.className || element.tagName))).toEqual([]);
      expect(await app.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    }
    await expect.poll(() => worker.evaluate(id => chrome.tabGroups.get(id).then(g => g.color), group.id), { timeout: 5000 }).toBe('grey');
    await expect.poll(() => worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('1');
    await app.getByRole('button', { name: 'Done' }).click();
    expect(await handoff).toEqual({ value: { state: 'completed', user_confirmed: true } });
    await expect.poll(() => worker.evaluate(id => chrome.tabGroups.get(id).then(g => g.color), group.id)).toBe('green');

    // Closing the window asks first, then ends the connection gracefully.
    const dialogs = [];
    app.on('dialog', dialog => { dialogs.push(dialog.type()); void dialog.accept(); });
    await app.close({ runBeforeUnload: true });
    await expect.poll(() => dialogs).toEqual(['beforeunload']);
    await expect.poll(async () => (await agent.call('list_browsers'))[0].online).toBe(false);
    expect((await agent.call('list_sessions'))[0].state).toBe('detached');
    await expect(agent.call('list_tabs', { session_id: session.session_id })).rejects.toMatchObject({ code: 'BROWSER_OFFLINE' });
    // The extension's own debugger sessions are gone: detaching any session tab is refused.
    await expect.poll(() => worker.evaluate(id => chrome.tabs.query({ groupId: id }).then(tabs => Promise.all(tabs.map(tab =>
      chrome.debugger.detach({ tabId: tab.id }).then(() => 'detached', () => 'not-attached')))), group.id))
      .toEqual(['not-attached', 'not-attached', 'not-attached']);
    await expect.poll(() => worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules().then(r => r.length))).toBe(0);

    // Reopening reattaches the live group with the same tab IDs, without another approval.
    await worker.evaluate(() => chrome.windows.create({ url: chrome.runtime.getURL('app.html'), type: 'popup' }));
    app = await findApp();
    await expect(app.locator('.status')).toHaveText('Connected', { timeout: 15_000 });
    await expect.poll(async () => (await agent.call('list_sessions'))[0]?.state).toBe('attached');
    const tabs = await agent.call('list_tabs', { session_id: session.session_id });
    expect(tabs.map(tab => tab.tab_id)).toContain(tabId);
    expect(tabs).toHaveLength(3);
    expect((await agent.raw('get_text', { tab_id: tabId, description, selector: 'h1' })).isError).not.toBe(true);

    // A second app page is refused while one is open.
    const duplicate = await context.newPage();
    await duplicate.goto(appUrl);
    await expect(duplicate.getByRole('heading', { name: 'DomAgent is already open' })).toBeVisible();
    await duplicate.close();

    // Ungrouping the tabs ends the session; tabs stay open.
    const before = await worker.evaluate(() => chrome.tabs.query({}).then(tabs => tabs.length));
    await worker.evaluate(id => chrome.tabs.query({ groupId: id }).then(tabs => chrome.tabs.ungroup(tabs.map(t => t.id))), group.id);
    await expect.poll(async () => (await agent.call('list_sessions')).length).toBe(0);
    expect(await worker.evaluate(() => chrome.tabs.query({}).then(tabs => tabs.length))).toBe(before);
    await expect(agent.call('get_text', { tab_id: tabId, description, selector: 'h1' })).rejects.toMatchObject({ code: 'SESSION_ENDED' });

    // A declined request creates nothing; an agent-ended session ungroups but keeps tabs.
    const declined = agent.call('request_session', { browser_id: paired.browser_id, purpose: 'This one gets declined' })
      .then(() => null, error => error);
    await expect(app.getByRole('heading', { name: 'Atlas wants to open a session' })).toBeVisible();
    await app.getByRole('button', { name: 'Decline' }).click();
    expect(await declined).toMatchObject({ code: 'ACTION_DECLINED' });
    const second = agent.call('request_session', { browser_id: paired.browser_id, purpose: 'Second fixture session' });
    await app.getByRole('button', { name: 'Approve' }).click();
    const two = await second;
    await agent.call('end_session', { session_id: two.session_id });
    await expect.poll(() => worker.evaluate(() => chrome.tabGroups.query({}).then(g => g.length))).toBe(0);
  } finally {
    process.env.TMPDIR = previousTmp;
    await context?.close().catch(() => {});
    await service.close();
  }
});

test('v6 Chrome new browser run (simulated): group IDs change, the user confirms the reattach and tab IDs survive', async () => {
  test.setTimeout(180_000);
  const directory = path.join(root, 'domagent-extension/.browser-artifacts/v6-chrome-restart');
  await fs.rm(directory, { recursive: true, force: true });
  const service = await startService(directory);
  const extension = path.join(directory, 'extension');
  await fs.cp(path.join(root, 'dist/chrome'), extension, { recursive: true });
  const manifestPath = path.join(extension, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.host_permissions = ['http://*/*', 'https://*/*'];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const previousTmp = process.env.TMPDIR; process.env.TMPDIR = '/tmp';
  const launch = () => chromium.launchPersistentContext(path.join(directory, 'profile'), {
    channel: 'chromium', headless: true, ignoreHTTPSErrors: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--ignore-certificate-errors',
      '--no-sandbox'],
  });
  let context;
  try {
    context = await launch();
    let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const appUrl = `chrome-extension://${new URL(worker.url()).host}/app.html`;
    const findApp = async () => {
      await expect.poll(() => context.pages().some(page => page.url() === appUrl), { timeout: 15_000 }).toBe(true);
      return context.pages().find(page => page.url() === appUrl);
    };
    let app = await findApp();
    await app.locator('#domain').fill(service.origin);
    await app.getByRole('button', { name: 'Connect' }).click();
    await expect(app.locator('.status')).toHaveText('Connected', { timeout: 15_000 });
    await app.getByRole('button', { name: 'Pair an agent' }).click();
    await expect(app.getByText(/Expires in/)).toBeVisible();
    const agent = await service.mcp();
    const pairing = agent.call('pair_browser', { code: (await app.locator('output.code').textContent()).trim() });
    await app.getByRole('button', { name: 'Approve' }).click();
    const paired = await pairing;
    const requested = agent.call('request_session', { browser_id: paired.browser_id, purpose: 'Survive a restart',
      urls: [service.pageUrl, `${service.pageUrl}login`], title: 'Restart task' });
    await app.getByRole('button', { name: 'Approve' }).click();
    const session = await requested;
    await expect.poll(async () => (await agent.call('list_tabs', { session_id: session.session_id }))
      .map(tab => tab.url).sort()).toEqual([service.pageUrl, `${service.pageUrl}login`]);
    const before = await agent.call('list_tabs', { session_id: session.session_id });
    const oldGroup = await worker.evaluate(() => chrome.tabGroups.query({ title: 'Restart task' }).then(g => g[0].id));
    // Idle windows must not loop on their own group/tab events, and records are saved before closing.
    const refreshes = await app.evaluate(() => globalThis.domagent.controller.refreshCount);
    await new Promise(resolve => setTimeout(resolve, 3000));
    expect((await app.evaluate(() => globalThis.domagent.controller.refreshCount)) - refreshes).toBeLessThanOrEqual(3);
    expect((await worker.evaluate(() => chrome.storage.local.get('sessions'))).sessions[0].tabs.map(tab => tab.id).sort())
      .toEqual(before.map(tab => tab.tab_id).sort());
    await app.close({ runBeforeUnload: false });
    await expect.poll(async () => (await agent.call('list_browsers'))[0].online).toBe(false);
    // Headless Chromium does not restore groups across a real restart, so reproduce what a restart changes:
    // a new browser run (session storage cleared) and the same tabs in a group with a new native ID.
    await worker.evaluate(async id => {
      await chrome.storage.session.remove('run');
      const tabs = await chrome.tabs.query({ groupId: id });
      await chrome.tabs.ungroup(tabs.map(tab => tab.id));
      const group = await chrome.tabs.group({ tabIds: tabs.map(tab => tab.id) });
      await chrome.tabGroups.update(group, { title: 'Restart task' });
    }, oldGroup);
    expect(await worker.evaluate(() => chrome.tabGroups.query({ title: 'Restart task' }).then(g => g[0].id))).not.toBe(oldGroup);
    await worker.evaluate(() => chrome.windows.create({ url: chrome.runtime.getURL('app.html'), type: 'popup' }));
    app = await findApp();
    await expect(app.getByRole('heading', { name: 'Reconnect “Restart task”?' })).toBeVisible({ timeout: 15_000 });
    expect((await agent.call('list_sessions'))[0].state).toBe('detached');
    await expect(agent.call('list_tabs', { session_id: session.session_id })).rejects.toMatchObject({ code: 'SESSION_DETACHED' });
    await app.getByRole('button', { name: 'Reconnect' }).click();
    await expect.poll(async () => (await agent.call('list_sessions'))[0]?.state).toBe('attached');
    const after = await agent.call('list_tabs', { session_id: session.session_id });
    expect(after.map(tab => [tab.tab_id, tab.url]).sort()).toEqual(before.map(tab => [tab.tab_id, tab.url]).sort());
  } finally {
    process.env.TMPDIR = previousTmp;
    await context?.close().catch(() => {});
    await service.close();
  }
});
