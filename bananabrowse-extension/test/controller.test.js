import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Controller } from '../src/controller.js';

const listener = () => ({ addListener() {} });
function fixture({ groups = [], tabs = [], values = {}, run = false, firefox = true, now = Date.now } = {}) {
  const sent = [];
  const saved = {};
  const updates = [];
  const api = {
    tabs: {
      onCreated: listener(),
      onRemoved: listener(),
      onAttached: listener(),
      onDetached: listener(),
      onUpdated: listener(),
      async query(filter = {}) {
        return tabs.filter((tab) => filter.groupId === undefined || tab.groupId === filter.groupId);
      },
      async ungroup() {},
      async get(id) {
        const tab = tabs.find((tab) => tab.id === id);
        if (!tab) throw new Error('No tab');
        return tab;
      },
      async remove(id) {
        const index = tabs.findIndex((tab) => tab.id === id);
        if (index >= 0) tabs.splice(index, 1);
      },
    },
    tabGroups: {
      onUpdated: listener(),
      onRemoved: listener(),
      async query() {
        return groups;
      },
      async get(id) {
        const group = groups.find((g) => g.id === id);
        if (!group) throw new Error('No group');
        return group;
      },
      async update(id, properties) {
        updates.push({ id, ...properties });
        Object.assign(groups.find((group) => group.id === id) || {}, properties);
      },
    },
    windows: {
      async get() {
        return { focused: false };
      },
    },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} },
    runtime: { getURL: (path) => path },
    ...(firefox
      ? {
          sessions: {
            async getTabValue(id) {
              return values[id];
            },
          },
        }
      : {}),
  };
  const adapter = {
    browserName: firefox ? 'firefox' : 'chrome',
    capabilities: () => ['navigate'],
    async protect() {},
    async attach() {},
    async release() {},
    attached: new Set(),
  };
  const storage = {
    async get() {
      return {};
    },
    async set(items) {
      Object.assign(saved, items);
    },
  };
  const session = {
    async get() {
      return run ? { run: true } : {};
    },
    async set() {},
  };
  const controller = new Controller({
    api,
    adapter,
    identity: {},
    storage,
    sessionStorage: session,
    browserName: adapter.browserName,
    extensionUrl: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/',
    now,
  });
  controller.connection = { connection_id: 'c' };
  controller.socket = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
  return { controller, sent, saved, updates, tabs };
}
const A = '11111111-1111-4111-8111-111111111111';
const server = [{ session_id: 's1', client_id: A, agent_id: 'atlas', title: 'Flights', purpose: 'p', group_id: 'g1' }];

test('pairing preserves the self-reported OAuth client warning for the approval UI', () => {
  const { controller } = fixture();
  controller.pairing = { code: 'K7MP-4QTX', state: 'ready', expires_at: Date.now() + 300_000, proposal: null };
  controller.proposal({
    request_id: A,
    agent: { id: 'oauth-test', name: 'OAuth client', url: null, oauth_client: true },
  });
  assert.equal(controller.snapshot().pairing.proposal.agent.oauth_client, true);
});

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
  const own = fixture({
    groups: [{ id: 5, title: 'Flights', windowId: 1 }],
    tabs: [
      { id: 1, groupId: 5 },
      { id: 2, groupId: 5 },
    ],
    values: { 1: tagged, 2: { client_id: A, tab_id: 't2' } },
  });
  await own.controller.reattach(server);
  assert.equal(own.controller.sessions.get(A).state, 'attached');
  assert.equal(own.controller.sessions.get(A).groupId, 5);
  // One tagged tab was dragged into the user's own group while the window was closed.
  const foreign = fixture({
    groups: [{ id: 9, title: 'Banking', windowId: 1 }],
    tabs: [
      { id: 1, groupId: 9 },
      { id: 3, groupId: 9 },
      { id: 4, groupId: 9 },
    ],
    values: { 1: tagged },
  });
  await foreign.controller.reattach(server);
  assert.equal(foreign.controller.sessions.has(A), false);
});

test('Chrome in a new browser run asks before reattaching by title', async () => {
  const { controller } = fixture({
    firefox: false,
    groups: [{ id: 7, title: 'Flights', windowId: 1 }],
    tabs: [{ id: 3, groupId: 7, url: 'https://a.example/' }],
  });
  controller.records = [{ client_id: A, title: 'Flights', tabs: [{ key: 99, id: 't1', url: 'https://a.example/' }] }];
  await controller.reattach(server);
  assert.equal(controller.sessions.get(A).state, 'unconfirmed');
  assert.deepEqual(
    controller.sessions.get(A).candidates.map((c) => c.groupId),
    [7],
  );
});

test('a pending approval is resolved against the server after a reconnect', async () => {
  const { controller } = fixture();
  controller.ready = true;
  const removed = [];
  controller.api.tabs.remove = async (ids) => {
    removed.push(...ids);
  };
  controller.sessions.set(A, {
    client_id: A,
    state: 'pending',
    request_id: 'r',
    startTabs: [41],
    tabs: new Map(),
    tasks: [],
  });
  await controller.reattach([]);
  assert.equal(controller.sessions.has(A), false);
  assert.deepEqual(removed, [41]);
});

test('close requests need fresh approval and generic session.end never uses completion consent', async () => {
  const { controller, sent } = fixture({
    tabs: [
      { id: 1, groupId: 5 },
      { id: 2, groupId: 5 },
    ],
  });
  const removed = [],
    notified = [];
  controller.api.tabs.remove = async (id) => {
    removed.push(id);
  };
  controller.api.notifications = {
    async create(id, options) {
      notified.push({ id, ...options });
    },
    async clear() {},
  };
  const tab = (tabId, id) => ({ tabId, id, title: `Tab ${id}`, url: `https://a.example/${id}`, queue: [] });
  const session = {
    client_id: A,
    session_id: 's1',
    agent_id: 'atlas',
    title: 'Flights',
    state: 'attached',
    groupId: 5,
    tabs: new Map([
      [1, tab(1, 't1')],
      [2, tab(2, 't2')],
    ]),
    tasks: [],
    running: 0,
    creating: 0,
    closeOnCompletion: true,
    createdTabs: new Set([1, 2]),
  };
  controller.sessions.set(A, session);
  const description = 'Close the scratch tab I opened to compare fares; it is no longer needed.';
  const command = (request_id, operation, args) => ({
    type: 'command',
    request_id,
    session_id: 's1',
    tab_id: null,
    operation,
    args,
    description,
    wait_timeout_ms: 60_000,
  });
  const R1 = '22222222-2222-4222-8222-222222222222',
    R2 = '33333333-3333-4333-8333-333333333333';

  controller.enqueue(command(R1, 'close_tab', { tab_id: 't1' }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(removed, []);
  assert.equal(
    sent.some((m) => m.type === 'command.ready'),
    false,
    'not ready before the user decides',
  );
  assert.equal(notified.length, 1);
  assert.match(notified[0].title, /asks to close “Tab t1”/);
  const [prompt] = controller.snapshot().closures;
  assert.deepEqual([prompt.kind, prompt.description, prompt.tabs.map((t) => t.tabId)], ['tab', description, [1]]);
  assert.equal(controller.pendingCount(), 1);

  // A legacy close order from the service only ungroups.
  await controller.sessionEnded({ client_id: 'other', close_tabs: true });
  // "Keep open" declines; nothing closes.
  controller.decideClose(R1, false);
  assert.deepEqual(sent.at(-1), { type: 'result', request_id: R1, error: { code: 'ACTION_DECLINED' } });
  assert.equal(controller.snapshot().closures.length, 0);

  controller.enqueue(command(R2, 'close_tab', { tab_id: 't1' }));
  controller.decideClose(R2, true);
  await new Promise((resolve) => setTimeout(resolve, 10));
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

const idleMs = 60 * 60_000;
function liveFixture(options = {}) {
  const f = fixture({
    groups: [{ id: 5, title: 'Flights', windowId: 1 }],
    tabs: [{ id: 1, groupId: 5, windowId: 1, url: 'https://a.example/', active: false }],
    ...options,
  });
  const session = {
    client_id: A,
    session_id: 's1',
    agent_id: 'atlas',
    title: 'Flights',
    purpose: 'Compare fares',
    state: 'attached',
    groupId: 5,
    windowId: 1,
    tabs: new Map(
      f.tabs.map((tab) => [
        tab.id,
        {
          tabId: tab.id,
          id: `t${tab.id}`,
          title: `Tab ${tab.id}`,
          url: tab.url,
          queue: [],
        },
      ]),
    ),
    tasks: [],
    running: 0,
    creating: 0,
    closeOnCompletion: true,
    createdTabs: new Set([1]),
    lastActivityAt: options.now?.() ?? Date.now(),
    stale: false,
    staleCollapsed: false,
  };
  f.controller.sessions.set(A, session);
  return { ...f, session };
}
async function complete(f, keep_tabs = false) {
  const request_id = '22222222-2222-4222-8222-222222222222';
  f.controller.enqueue({
    request_id,
    session_id: 's1',
    operation: 'end_session',
    args: { keep_tabs },
    description: 'Finish this task and apply the cleanup policy chosen at session approval.',
    wait_timeout_ms: 25_000,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await f.controller.executeReady({ request_id, execution_timeout_ms: 10_000 });
  return f.sent.find((message) => message.type === 'result' && message.request_id === request_id);
}

test('session approval defaults to completion cleanup and persists the user choice before the decision', async () => {
  for (const choice of [undefined, false]) {
    const f = fixture();
    f.controller.adapter.lastNormalWindow = async () => 1;
    f.controller.api.tabs.create = async () => ({ id: 1 });
    f.controller.api.tabs.group = async () => 5;
    f.controller.requests.set(A, {
      request_id: A,
      expires_at: Date.now() + 60_000,
      agent: { id: 'atlas', name: 'Atlas' },
      purpose: 'Compare fares',
      title: 'Flights',
      urls: [],
    });
    await f.controller.approveSession(A, choice);
    const [session] = f.controller.sessions.values();
    assert.equal(session.closeOnCompletion, choice !== false);
    assert.equal(f.saved.sessions[0].closeOnCompletion, choice !== false);
    assert.deepEqual(f.saved.sessions[0].tabs, [{ key: 1, id: null, url: 'about:blank', created: true }]);
    assert.equal(f.sent.at(-1).type, 'session.decision');
  }
});

test('completion consent closes only owned, tracked, unpinned tabs still in the group', async () => {
  const f = liveFixture({
    tabs: [
      { id: 1, groupId: 5 },
      { id: 2, groupId: 5 },
      { id: 3, groupId: 5, pinned: true },
      { id: 4, groupId: 9 },
    ],
  });
  f.session.createdTabs = new Set([1, 3, 4]);
  const result = await complete(f);
  assert.deepEqual(result.result, { tabs_closed: 1 });
  assert.deepEqual(
    f.tabs.map((tab) => tab.id),
    [2, 3, 4],
  );
  assert.equal(f.controller.sessions.size, 0);
  assert.equal(f.controller.closures.size, 0);
});

test('unchecked, legacy and explicit keep-tabs sessions preserve all tabs on completion', async () => {
  for (const consent of [false, undefined, true]) {
    const f = liveFixture();
    f.session.closeOnCompletion = consent;
    const result = await complete(f, consent === true);
    assert.deepEqual(result.result, { tabs_closed: 0 });
    assert.equal(f.tabs.length, 1);
    assert.equal(f.controller.sessions.size, 0);
  }
});

test('completion rechecks native membership and pins before closing', async () => {
  for (const change of [{ groupId: 9 }, { pinned: true }]) {
    const f = liveFixture();
    f.controller.api.tabs.get = async () => ({ ...f.tabs[0], ...change });
    assert.deepEqual((await complete(f)).result, { tabs_closed: 0 });
    assert.equal(f.tabs.length, 1);
  }
});

test('native close failures are returned, not reported as successful completion', async () => {
  const f = liveFixture();
  f.controller.api.tabs.remove = async () => {
    throw new Error('Native close failed');
  };
  assert((await complete(f)).error);
  assert.equal(f.controller.sessions.get(A), f.session);
  assert.equal(f.session.completing, false);
  assert.equal(f.tabs.length, 1);
});

test('a concurrent inventory scan cannot end completion before its receipt', async () => {
  const f = liveFixture();
  const remove = f.controller.api.tabs.remove;
  f.controller.api.tabs.remove = async (id) => {
    await remove(id);
    f.controller.api.tabGroups.get = async () => {
      throw new Error('Group disappeared with its last tab');
    };
    await f.controller.refresh();
    assert.equal(f.controller.sessions.get(A), f.session);
    assert.equal(
      f.sent.some((message) => message.type === 'result'),
      false,
    );
  };
  assert.deepEqual((await complete(f)).result, { tabs_closed: 1 });
  assert.equal(f.controller.sessions.size, 0);
});

test('an end command cannot enable consent or claim user-added tabs', async () => {
  const f = liveFixture();
  f.session.closeOnCompletion = false;
  f.controller.enqueue({
    request_id: '22222222-2222-4222-8222-222222222222',
    session_id: 's1',
    operation: 'end_session',
    args: { keep_tabs: false, closeOnCompletion: true },
    description: 'Finish this task and apply the cleanup policy chosen at session approval.',
    wait_timeout_ms: 25_000,
  });
  assert.equal(f.sent.at(-1).error.code, 'INVALID_ARGUMENT');
  assert.equal(f.session.closeOnCompletion, false);
  assert.equal(f.tabs.length, 1);
});

test('completion consent, ownership and the idle clock survive same-run Chrome reattach', async () => {
  const f = liveFixture({ firefox: false, run: true });
  f.session.lastActivityAt = 123;
  f.session.stale = true;
  f.session.staleCollapsed = true;
  await f.controller.persist();
  f.controller.sessions.clear();
  await f.controller.reattach(server);
  await f.controller.refresh();
  const restored = f.controller.sessions.get(A);
  assert.equal(restored.closeOnCompletion, true);
  assert.equal(restored.createdTabs.has(1), true);
  assert.equal(restored.lastActivityAt, 123);
  assert.equal(restored.staleCollapsed, true);
  assert.deepEqual((await complete(f)).result, { tabs_closed: 1 });
});

test('Firefox restores close provenance from native tab values across browser restarts', async () => {
  const f = liveFixture({ values: { 1: { client_id: A, tab_id: 't1', created: true } } });
  await f.controller.persist();
  f.controller.sessions.clear();
  await f.controller.reattach(server);
  await f.controller.refresh();
  assert.deepEqual((await complete(f)).result, { tabs_closed: 1 });
});

test('tabs moved out while the app was closed lose provenance even if the user later adds them back', async () => {
  for (const firefox of [false, true]) {
    const f = liveFixture({
      firefox,
      run: true,
      tabs: [
        { id: 1, groupId: 5, url: 'https://a.example/one' },
        { id: 2, groupId: 5, url: 'https://a.example/two' },
      ],
      values: {
        1: { client_id: A, tab_id: 't1', created: true },
        2: { client_id: A, tab_id: 't2', created: true },
      },
    });
    f.session.createdTabs.add(2);
    await f.controller.persist();
    f.controller.sessions.clear();
    f.tabs[1].groupId = 9;
    await f.controller.reattach(server);
    await f.controller.refresh();
    const restored = f.controller.sessions.get(A);
    assert.equal(restored.createdTabs.has(2), false);
    f.tabs[1].groupId = 5;
    await f.controller.refresh();
    assert.deepEqual((await complete(f)).result, { tabs_closed: 1 });
    assert.deepEqual(
      f.tabs.map((tab) => tab.id),
      [2],
    );
  }
});

test('Chrome URL-only reattach never restores automatic tab-close authority', async () => {
  const f = liveFixture({ firefox: false });
  await f.controller.persist();
  f.controller.sessions.clear();
  await f.controller.reattach(server);
  await f.controller.confirmReattach(A, 5);
  assert.equal(f.controller.sessions.get(A).closeOnCompletion, true);
  assert.deepEqual((await complete(f)).result, { tabs_closed: 0 });
  assert.equal(f.tabs.length, 1);
});

test('idle staleness starts at exactly one hour and collapses once per activity period', async () => {
  let now = 1_000_000;
  const f = liveFixture({ now: () => now });
  f.controller.socket = null;
  now += idleMs - 1;
  await f.controller.tick();
  assert.equal(f.session.stale, false);
  now++;
  await f.controller.tick();
  assert.equal(f.controller.snapshot().sessions[0].stale, true);
  assert.equal(f.updates.filter((update) => update.collapsed).length, 1);
  // The user expands the group; sync and heartbeats must not renew activity or re-collapse it.
  await f.controller.api.tabGroups.update(5, { collapsed: false });
  await f.controller.sync(true);
  await f.controller.tick();
  assert.equal(f.updates.filter((update) => update.collapsed).length, 1);
  f.controller.progress({ session_id: 's1', message: 'Continuing the task' });
  assert.equal(f.session.stale, false);
  now += idleMs;
  await f.controller.tick();
  assert.equal(f.updates.filter((update) => update.collapsed).length, 2);
  assert.equal(f.tabs.length, 1, 'staleness never closes tabs');
});

test('collapse waits until the user is no longer viewing the stale group', async () => {
  let now = 1_000_000;
  const f = liveFixture({ now: () => now });
  f.tabs[0].active = true;
  let focused = true;
  f.controller.api.windows.get = async () => ({ focused });
  now += idleMs;
  await f.controller.markIdleSessions();
  assert.equal(f.session.stale, true);
  assert.equal(f.session.staleCollapsed, false);
  focused = false;
  await f.controller.markIdleSessions();
  assert.equal(f.session.staleCollapsed, true);
});

test('work, creation and pending human decisions defer staleness', async () => {
  for (const state of ['running', 'creating', 'help', 'approval', 'completing']) {
    const f = liveFixture({ now: () => 2 * idleMs });
    f.session.lastActivityAt = 0;
    if (state === 'help') f.session.tabs.get(1).queue.push({ human: true });
    else if (state === 'approval') f.session.tasks.push({ confirm: true });
    else f.session[state] = 1;
    await f.controller.markIdleSessions();
    assert.equal(f.session.stale, false, state);
    assert.deepEqual(f.updates, []);
  }
});
