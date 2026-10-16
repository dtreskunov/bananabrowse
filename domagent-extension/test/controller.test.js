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

test('tabs close only after the user approves in the window; the service can never close them', async () => {
  const { controller, sent } = fixture({ tabs: [{ id: 1, groupId: 5 }, { id: 2, groupId: 5 }] });
  const removed = [], notified = [];
  controller.api.tabs.remove = async id => { removed.push(id); };
  controller.api.notifications = { async create(id, options) { notified.push({ id, ...options }); }, async clear() {} };
  const tab = (tabId, id) => ({ tabId, id, title: `Tab ${id}`, url: `https://a.example/${id}`, queue: [] });
  const session = { client_id: A, session_id: 's1', agent_id: 'atlas', title: 'Flights', state: 'attached', groupId: 5,
    tabs: new Map([[1, tab(1, 't1')], [2, tab(2, 't2')]]), tasks: [], running: 0, creating: 0 };
  controller.sessions.set(A, session);
  const description = 'Close the scratch tab I opened to compare fares; it is no longer needed.';
  const command = (request_id, operation, args) => ({ type: 'command', request_id, session_id: 's1', tab_id: null,
    operation, args, description, wait_timeout_ms: 60_000 });
  const R1 = '22222222-2222-4222-8222-222222222222', R2 = '33333333-3333-4333-8333-333333333333';

  controller.enqueue(command(R1, 'close_tab', { tab_id: 't1' }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(removed, []);
  assert.equal(sent.some(m => m.type === 'command.ready'), false, 'not ready before the user decides');
  assert.equal(notified.length, 1);
  assert.match(notified[0].title, /asks to close “Tab t1”/);
  const [prompt] = controller.snapshot().closures;
  assert.deepEqual([prompt.kind, prompt.description, prompt.tabs.map(t => t.tabId)], ['tab', description, [1]]);
  assert.equal(controller.pendingCount(), 1);

  // A legacy close order from the service only ungroups.
  await controller.sessionEnded({ client_id: 'other', close_tabs: true });
  // "Keep open" declines; nothing closes.
  controller.decideClose(R1, false);
  assert.deepEqual(sent.at(-1), { type: 'result', request_id: R1, error: { code: 'ACTION_DECLINED' } });
  assert.equal(controller.snapshot().closures.length, 0);

  controller.enqueue(command(R2, 'close_tab', { tab_id: 't1' }));
  controller.decideClose(R2, true);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(sent.at(-1), { type: 'command.ready', request_id: R2 });
  assert.deepEqual(removed, []);
  await controller.executeReady({ request_id: R2, execution_timeout_ms: 10_000 });
  assert.deepEqual(removed, [1]);
  assert.deepEqual(sent.at(-1), { type: 'result', request_id: R2, result: { tab_id: 't1', session_ended: false } });
  assert.equal(controller.sessions.get(A), session);

  await controller.sessionEnded({ client_id: A, close_tabs: true });
  assert.deepEqual(removed, [1], 'session.end never closes tabs');
  assert.equal(controller.sessions.has(A), false);
});
