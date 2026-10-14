import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Controller } from '../src/controller.js';

const listener = () => ({ addListener() {} });
function fixture({ groups = [], tabs = [], values = {}, run = false, firefox = true } = {}) {
  const sent = [];
  const api = {
    tabs: { onCreated: listener(), onRemoved: listener(), onAttached: listener(), onDetached: listener(), onUpdated: listener(),
      async query(filter = {}) { return tabs.filter(tab => filter.groupId === undefined || tab.groupId === filter.groupId); },
      async ungroup() {}, async remove() {} },
    tabGroups: { onUpdated: listener(), onRemoved: listener(), async query() { return groups; },
      async get(id) { const group = groups.find(g => g.id === id); if (!group) throw new Error('No group'); return group; } },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} },
    runtime: { getURL: path => path },
    ...(firefox ? { sessions: { async getTabValue(id) { return values[id]; } } } : {}),
  };
  const adapter = { browserName: firefox ? 'firefox' : 'chrome', capabilities: () => ['navigate'], async protect() {},
    async attach() {}, async release() {}, attached: new Set() };
  const storage = { async get() { return {}; }, async set() {} };
  const session = { async get() { return run ? { run: true } : {}; }, async set() {} };
  const controller = new Controller({ api, adapter, identity: {}, storage, sessionStorage: session,
    browserName: adapter.browserName, extensionUrl: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/' });
  controller.connection = { connection_id: 'c' };
  controller.socket = { readyState: 1, send: raw => sent.push(JSON.parse(raw)) };
  return { controller, sent };
}
const A = '11111111-1111-4111-8111-111111111111';
const server = [{ session_id: 's1', client_id: A, agent_id: 'atlas', title: 'Flights', purpose: 'p', group_id: 'g1' }];

test('no inventory is sent until reattach has finished', async () => {
  const { controller, sent } = fixture();
  controller.ready = false;
  await controller.sync(true);
  assert.deepEqual(sent, []);
  controller.ready = true;
  await controller.sync(true);
  assert.deepEqual(sent, [{ type: 'sync', groups: [] }]);
});

test('Firefox reattaches a group only when most of its tabs carry the session tag', async () => {
  const tagged = { client_id: A, tab_id: 't1' };
  const own = fixture({ groups: [{ id: 5, title: 'Flights', windowId: 1 }],
    tabs: [{ id: 1, groupId: 5 }, { id: 2, groupId: 5 }], values: { 1: tagged, 2: { client_id: A, tab_id: 't2' } } });
  await own.controller.reattach(server);
  assert.equal(own.controller.sessions.get(A).state, 'attached');
  assert.equal(own.controller.sessions.get(A).groupId, 5);
  // One tagged tab was dragged into the user's own group while the window was closed.
  const foreign = fixture({ groups: [{ id: 9, title: 'Banking', windowId: 1 }],
    tabs: [{ id: 1, groupId: 9 }, { id: 3, groupId: 9 }, { id: 4, groupId: 9 }], values: { 1: tagged } });
  await foreign.controller.reattach(server);
  assert.equal(foreign.controller.sessions.has(A), false);
});

test('Chrome in a new browser run asks before reattaching by title', async () => {
  const { controller } = fixture({ firefox: false, groups: [{ id: 7, title: 'Flights', windowId: 1 }],
    tabs: [{ id: 3, groupId: 7, url: 'https://a.example/' }] });
  controller.records = [{ client_id: A, title: 'Flights', tabs: [{ key: 99, id: 't1', url: 'https://a.example/' }] }];
  await controller.reattach(server);
  assert.equal(controller.sessions.get(A).state, 'unconfirmed');
  assert.deepEqual(controller.sessions.get(A).candidates.map(c => c.groupId), [7]);
});

test('a pending approval is resolved against the server after a reconnect', async () => {
  const { controller } = fixture();
  controller.ready = true;
  const removed = [];
  controller.api.tabs.remove = async ids => { removed.push(...ids); };
  controller.sessions.set(A, { client_id: A, state: 'pending', request_id: 'r', startTabs: [41], tabs: new Map(), tasks: [] });
  await controller.reattach([]);
  assert.equal(controller.sessions.has(A), false);
  assert.deepEqual(removed, [41]);
});
