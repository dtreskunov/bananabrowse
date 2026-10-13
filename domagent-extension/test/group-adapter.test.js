import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GroupAdapter } from '../src/group-adapter.js';

function fixture(browserName = 'chrome') {
  const updates = [];
  let open = true;
  const api = {
    tabs: { async get() { return { id: 10, windowId: 1, groupId: 2, url: 'about:blank' }; },
      async update(id, args) { updates.push([id, args]); } },
    tabGroups: { async get() { return { id: 2, windowId: 1 }; } },
    sidebarAction: { async isOpen() { return open; } },
  };
  const adapter = new GroupAdapter(api, browserName);
  adapter.openWindows.add(1);
  const port = {};
  adapter.registerPanel(1, port);
  return { api, adapter, port, updates, close() { open = false; } };
}
test('native panel evidence and a fresh trusted heartbeat are both required; alive ports alone never authorize', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  const f = fixture();
  assert.equal(await f.adapter.panelOpen(1), true);
  f.adapter.openWindows.delete(1);
  assert.equal(await f.adapter.panelOpen(1), false);
  f.adapter.openWindows.add(1);
  t.mock.timers.tick(5000);
  assert.equal(await f.adapter.panelOpen(1), false);
  f.adapter.touchPanel(1, f.port);
  assert.equal(await f.adapter.panelOpen(1), true);
  assert.throws(() => f.adapter.touchPanel(1, {}), /NOT_AUTHORIZED/);
  let closed;
  f.adapter.onPanelClosed = id => { closed = id; };
  f.adapter.unregisterPanel(1, f.port);
  assert.equal(closed, 1);
  assert.equal(await f.adapter.panelOpen(1), false);
  const ff = fixture('firefox');
  assert.equal(await ff.adapter.panelOpen(1), true);
  ff.close();
  assert.equal(await ff.adapter.panelOpen(1), false);
});
test('blank or refused current documents can navigate without injection while destination restrictions remain intact', async () => {
  const f = fixture();
  const grant = { tabId: 10, windowId: 1, groupId: 2, protected_origins: ['https://control.test'] };
  f.adapter.inspect = async () => { throw new Error('Current document must not be injected'); };
  const result = await f.adapter.execute(grant, 'navigate', { url: 'https://ordinary.test/' }, () => {});
  assert.equal(result.navigation_started, true);
  assert.equal(grant.pageState, 'loading');
  assert.equal(f.updates.length, 1);
  await assert.rejects(f.adapter.execute(grant, 'navigate', { url: 'https://control.test/' }, () => {}), /HANDOFF_REQUIRED/);
  await assert.rejects(f.adapter.execute(grant, 'navigate', { url: 'about:config' }, () => {}), /HANDOFF_REQUIRED/);
  assert.equal(f.updates.length, 1);
  f.api.tabs.get = async () => ({ id: 10, windowId: 1, groupId: 9, url: 'https://ordinary.test/' });
  await assert.rejects(f.adapter.execute(grant, 'navigate', { url: 'https://ordinary.test/' }, () => {}), /TAB_NOT_IN_WORKSPACE/);
  assert.equal(f.updates.length, 1);
});
