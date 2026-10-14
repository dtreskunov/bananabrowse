import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Controller } from '../src/controller.js';
import { DeviceKeys } from '../src/keys.js';
import { workspacePayload, authPayload, verify } from '../../shared/protocol.js';

const origin = 'https://control.example';
const tenant_id = 't_abcdefghijklmnopqrstuv';
const description = 'Read the intended controls in this grouped browser page';
const flush = () => new Promise(resolve => setImmediate(resolve));
class Socket {
  constructor() { this.readyState = 1; this.sent = []; }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
}
async function fixture(t) {
  const calls = [], saved = {}, tabs = [{ id: 100, windowId: 10, groupId: 1, url: 'https://page.example/', status: 'complete', title: 'Fixture page' }];
  const keys = new DeviceKeys({ async get() {}, async put(record) { return record; } });
  const record = await keys.get(origin, tenant_id);
  record.identity = { device_id: 'device-1', tenant_id, client_id: 'client-1', client_label: 'Atlas' };
  let open = true, clock = Date.now();
  const adapter = {
    browserName: 'firefox', createdTabs: new Set(), attached: new Set(),
    async initialize() {}, async permissions() {},
    async browserInfo() { return { extension_version: '5.0.0', browser_name: 'firefox', browser_version: '146.0.1' }; },
    capabilities() { return ['navigate', 'get_text', 'type_text', 'get_page_snapshot', 'wait_for_page']; },
    async makeGroup() { return { groupId: 1, tabId: 100 }; },
    async panelOpen() { return open; },
    async protect(id) { calls.push(['protect', id]); },
    async attach(id) { calls.push(['attach', id]); },
    async release(id, options) { calls.push(['release', id, options]); },
    async prepareAction() { return { summary: ['Operation: get_text'], document_nonce: 'doc-1' }; },
    async releaseAction() {},
    async execute(tab, operation, args, check) { check(); calls.push(['execute', tab.tabId, operation]); return { text: 'Fixture' }; },
    api: {
      windows: { async get() { return { id: 10, type: 'normal' }; } },
      tabGroups: { async get() { return { windowId: 10 }; },
        async query() { return [{ id: 1, windowId: 10 }, { id: 2, windowId: 10 }]; },
        async update(_id, args) { calls.push(['color', args.color]); } },
      tabs: {
        async query() { return tabs; },
        async get(id) { return tabs.find(tab => tab.id === id); },
        async remove(id) { calls.push(['remove', id]); },
      },
    },
  };
  const controller = new Controller({ adapter, keys, Socket, extensionUrl: 'moz-extension://11111111-1111-4111-8111-111111111111/',
    storage: { async get() { return saved; }, async set(value) { Object.assign(saved, value); } },
    now: () => clock });
  controller.config = { service_origin: origin, tenant_id, enabled: true, local_protected_origins: [] };
  controller.record = record; controller.browserInfo = await adapter.browserInfo();
  controller.connect(); controller.socket.onopen();
  const socket = controller.socket;
  const binding = { tenant_id, epoch: crypto.randomUUID(), connection_id: crypto.randomUUID() };
  const receive = message => controller.receive(JSON.stringify(message), socket, controller.generation);
  const challenge = { ...binding, origin, key_id: record.key_id, nonce: 'nonce', type: 'challenge' };
  await receive(challenge);
  await receive({ ...binding, type: 'authenticated', device_id: 'device-1',
    client_id: 'client-1', client_label: 'Atlas', protected_origins: [origin] });
  t.after(() => controller.dispose());
  return { controller, adapter, calls, tabs, record, receive, socket, binding, challenge,
    setOpen(value) { open = value; }, advance(ms) { clock += ms; controller.lastPing = clock; } };
}
async function start(f) {
  await f.controller.startWorkspace(10);
  const workspace = [...f.controller.workspaces.values()][0];
  await f.receive({ type: 'workspace.active', ...f.binding, workspace_id: workspace.id,
    activation_id: workspace.activationId, revision: workspace.revision });
  return workspace;
}
function command(f, workspace, tab, patch = {}) {
  return { type: 'command', ...f.binding, workspace_id: workspace.id, activation_id: workspace.activationId,
    client_id: 'client-1', target_id: tab.targetId, request_id: crypto.randomUUID(),
    operation: 'get_text', args: {}, description, wait_timeout_ms: 25000, ...patch };
}

test('v5 identity and workspace signatures bind actual group and explicit tab handles', async t => {
  const f = await fixture(t);
  assert.equal(f.socket.sent[0].version, 5);
  assert(await verify(f.record.public_key, authPayload(f.challenge), f.socket.sent[1].signature));
  const workspace = await start(f);
  const sync = f.socket.sent.find(message => message.type === 'workspace.sync');
  assert(await verify(f.record.public_key, workspacePayload(sync), sync.signature));
  assert.equal(await verify(f.record.public_key, workspacePayload({ ...sync, group_id: 2 }), sync.signature), false);
  assert.equal(sync.tabs[0].tab_id, 100);
  assert.equal(workspace.state, 'active');
  assert(!f.calls.some(call => call[0] === 'remove'));
});

test('local UI reports starting until the fresh activation is acknowledged, including after Resume', async t => {
  const f = await fixture(t);
  await f.controller.startWorkspace(10);
  const workspace = [...f.controller.workspaces.values()][0];
  assert.equal(f.controller.snapshot().workspaces[0].acknowledged, false);
  await f.receive({ type: 'workspace.active', ...f.binding, workspace_id: workspace.id,
    activation_id: workspace.activationId, revision: workspace.revision });
  assert.equal(f.controller.snapshot().workspaces[0].acknowledged, true);
  const activation = workspace.activationId;
  await f.controller.stopWorkspace(workspace, 'paused');
  await f.controller.startWorkspace(10);
  assert.equal(f.controller.snapshot().workspaces[0].acknowledged, false);
  await f.receive({ type: 'workspace.active', ...f.binding, workspace_id: workspace.id,
    activation_id: activation, revision: workspace.revision });
  assert.equal(f.controller.snapshot().workspaces[0].acknowledged, false);
  await f.receive({ type: 'workspace.active', ...f.binding, workspace_id: workspace.id,
    activation_id: workspace.activationId, revision: workspace.revision });
  assert.equal(f.controller.snapshot().workspaces[0].acknowledged, true);
});

test('unknown native URLs are not fabricated, published empty or demoted to navigation-only during document transitions', async t => {
  const f = await fixture(t), workspace = await start(f);
  const target = workspace.tabs.get(100);
  f.tabs[0].url = '';
  f.tabs.push({ id: 101, windowId: 10, groupId: 1, url: '', status: 'loading' });
  await f.controller.refresh();
  assert.equal(target.url, 'https://page.example/');
  assert.equal(target.pageState, 'loading');
  assert.equal(workspace.tabs.has(101), false);
  const snapshot = f.socket.sent.filter(message => message.type === 'workspace.sync').at(-1);
  assert(snapshot.tabs.every(tab => tab.url));
  assert(snapshot.tabs[0].capabilities.includes('get_text'));
  f.tabs[0].url = 'https://page.example/new';
  f.tabs[1].url = 'about:blank';
  await f.controller.refresh();
  assert.equal(target.pageState, 'ready');
  assert.equal(workspace.tabs.get(101).pageState, 'navigation_only');
});

test('ordinary native form/click navigation retains loading capability through temporary neutral documents', async t => {
  const f = await fixture(t), workspace = await start(f), tab = workspace.tabs.get(100);
  f.adapter.onTabEvent(100, 'navigation_pending', 'https://page.example/post');
  f.tabs[0].url = 'about:blank';
  f.tabs[0].status = 'loading';
  await f.controller.refresh();
  assert.equal(tab.pageState, 'loading');
  assert.equal(tab.url, 'https://page.example/');
  assert.equal(tab.navigation.url, 'https://page.example/post');
  const sync = f.socket.sent.filter(message => message.type === 'workspace.sync').at(-1);
  assert(sync.tabs[0].capabilities.includes('wait_for_page'));
  f.tabs[0].url = 'https://page.example/post';
  f.tabs[0].status = 'complete';
  await f.controller.refresh();
  assert.equal(tab.pageState, 'ready');
});

test('a loading blank native tab is never signed with ordinary DOM capabilities during admission races', async t => {
  const f = await fixture(t), workspace = await start(f), tab = workspace.tabs.get(100);
  tab.url = 'about:blank'; tab.pageState = 'loading';
  await f.controller.sync(workspace);
  let signed = f.socket.sent.filter(message => message.type === 'workspace.sync').at(-1).tabs[0];
  assert.equal(signed.page_state, 'navigation_only');
  assert.deepEqual(signed.capabilities, ['navigate']);
  f.adapter.onTabEvent(100, 'navigation_pending', 'https://page.example/new');
  await f.controller.sync(workspace);
  signed = f.socket.sent.filter(message => message.type === 'workspace.sync').at(-1).tabs[0];
  assert.equal(signed.url, 'https://page.example/new');
  assert.equal(signed.page_state, 'loading');
  assert(signed.capabilities.includes('wait_for_page'));
});

test('grouped background tabs execute without per-action approval and unknown tabs remain inaccessible', async t => {
  const f = await fixture(t), workspace = await start(f);
  f.tabs.push({ id: 101, windowId: 10, groupId: 1, url: 'https://other.example/', title: 'Other task', status: 'complete' });
  await f.controller.refresh();
  assert.equal(workspace.tabs.size, 2);
  const tab = workspace.tabs.get(101), work = command(f, workspace, tab);
  f.controller.enqueue(work); await flush();
  assert(f.socket.sent.some(message => message.type === 'command.ready' && message.request_id === work.request_id));
  await f.receive({ type: 'command.execute', ...f.binding, request_id: work.request_id, target_id: tab.targetId, execution_timeout_ms: 25000 });
  await flush();
  assert.deepEqual(f.calls.find(call => call[0] === 'execute'), ['execute', 101, 'get_text']);
  assert.equal(f.socket.sent.find(message => message.type === 'result' && message.request_id === work.request_id).result.text, 'Fixture');
  const foreign = { ...work, target_id: crypto.randomUUID(), request_id: crypto.randomUUID() };
  f.controller.enqueue(foreign);
  assert.equal(f.socket.sent.at(-1).error.code, 'TAB_NOT_IN_WORKSPACE');
});

test('user pause revokes before cleanup; dashboard closure retains explicit group authority without replay', async t => {
  const f = await fixture(t), workspace = await start(f);
  const tab = workspace.tabs.get(100), work = command(f, workspace, tab);
  f.adapter.prepareAction = () => new Promise(() => {});
  f.controller.enqueue(work);
  const stop = f.controller.stopWorkspace(workspace, 'paused');
  assert.equal(workspace.state, 'paused'); assert.equal(workspace.tabs.size, 0);
  await stop;
  assert.equal(f.socket.sent.find(message => message.type === 'result' && message.request_id === work.request_id).error.code, 'WORKSPACE_PAUSED');
  assert(!f.calls.some(call => call[0] === 'remove'));
  const previous = workspace.activationId;
  f.adapter.prepareAction = async () => ({ document_nonce: 'doc-1' });
  await f.controller.startWorkspace(10);
  assert.notEqual(workspace.activationId, previous);
  assert.notEqual(workspace.tabs.get(100).targetId, tab.targetId);
  f.setOpen(false);
  await f.controller.refresh();
  assert.equal(workspace.state, 'active');
  assert.equal(workspace.tabs.size, 1);
  await f.receive({ ...f.binding, type: 'workspace.active', workspace_id: workspace.id,
    activation_id: workspace.activationId, revision: workspace.revision });
  const background = command(f, workspace, workspace.tabs.get(100));
  f.controller.enqueue(background); await flush();
  assert(f.socket.sent.some(message => message.type === 'command.ready' && message.request_id === background.request_id));
  assert(!f.calls.some(call => call[0] === 'remove'));
});

test('new site-created grouped tabs are excluded until explicit user re-add; removed handles never revive', async t => {
  const f = await fixture(t), workspace = await start(f), old = workspace.tabs.get(100);
  f.adapter.createdTabs.add(101);
  f.tabs.push({ id: 101, windowId: 10, groupId: 1, url: 'https://popup.example/', status: 'complete' });
  await f.controller.refresh();
  assert.equal(workspace.tabs.has(101), false);
  f.tabs.splice(1, 1);
  await f.controller.refresh();
  f.tabs.push({ id: 101, windowId: 10, groupId: 1, url: 'https://popup.example/', status: 'complete' });
  await f.controller.refresh();
  assert.equal(workspace.tabs.has(101), true);
  f.tabs.splice(0, 1); await f.controller.refresh();
  assert.equal(workspace.tabs.has(100), false);
  f.tabs.push({ id: 100, windowId: 10, groupId: 1, url: 'https://page.example/', status: 'complete' });
  await f.controller.refresh();
  assert.notEqual(workspace.tabs.get(100).targetId, old.targetId);
});

test('human handoff notifies globally, click is not completion, Done is explicit and cancellation clears it', async t => {
  const f = await fixture(t), workspace = await start(f), tab = workspace.tabs.get(100);
  const notifications = [];
  f.controller.notify = async id => { notifications.push(id); };
  f.controller.clearNotification = async id => { notifications.push(`clear:${id}`); };
  const work = command(f, workspace, tab, { operation: 'request_handoff', wait_timeout_ms: 60000 });
  f.controller.enqueue(work); await flush();
  assert.deepEqual(notifications, [work.request_id]);
  assert(!f.socket.sent.some(message => message.type === 'command.ready'));
  await f.controller.decide(work.request_id, 'done');
  await f.receive({ type: 'command.execute', ...f.binding, request_id: work.request_id,
    target_id: tab.targetId, execution_timeout_ms: 25000 });
  await flush();
  assert.equal(f.socket.sent.find(message => message.type === 'result').result.user_confirmed, true);
  assert(notifications.includes(`clear:${work.request_id}`));
  f.controller.notify = async () => { throw new Error('Notification API denied'); };
  const denied = command(f, workspace, tab, { operation: 'request_handoff' });
  f.controller.enqueue(denied); await flush();
  assert.equal(f.socket.sent.find(message => message.type === 'result' && message.request_id === denied.request_id).error.code, 'NOTIFICATION_UNAVAILABLE');
});

test('startup and restored native panels do not restore workspace authority', async t => {
  const f = await fixture(t);
  assert.equal(f.controller.workspaces.size, 0);
  f.controller.config.enabled = false;
  await f.controller.initialize();
  assert.equal(f.controller.workspaces.size, 0);
});

test('server access prompts notify once and do not activate or override a paused group', async t => {
  const f = await fixture(t), workspace = await start(f);
  await f.controller.stopWorkspace(workspace, 'paused');
  const notifications = [], cleared = [];
  f.controller.notifyAccess = async id => notifications.push(id);
  f.controller.clearAccessNotification = async id => cleared.push(id);
  const request = { type: 'workspace.request', ...f.binding, client_id: 'client-1',
    request_id: crypto.randomUUID(), description, remaining_ms: 60000 };
  await f.receive(request); await flush();
  assert.deepEqual(notifications, [request.request_id]);
  assert.equal(workspace.state, 'paused');
  assert.equal(workspace.tabs.size, 0);
  assert.equal(f.controller.snapshot().access_requests[0].description, description);
  let opened = 0;
  await f.controller.reviewAccess(request.request_id, async () => { opened++; });
  assert.equal(opened, 1);
  assert.equal(workspace.state, 'paused');
  assert.equal(workspace.tabs.size, 0);
  await f.receive({ ...request, remaining_ms: 100000 }); await flush();
  assert.equal(notifications.length, 1);
  assert(f.socket.sent.some(message => message.type === 'workspace.request.received' && message.status === 'created'));
  f.controller.declineAccess(request.request_id); await flush();
  assert.equal(f.controller.accessRequests.size, 0);
  assert.deepEqual(cleared, [request.request_id]);
  assert.equal(f.socket.sent.at(-1).type, 'workspace.request.decline');
  assert.equal(workspace.state, 'paused');
  await f.controller.reviewAccess(request.request_id, async () => { opened++; });
  assert.equal(opened, 1);
});

test('failed or cancelled access notifications are explicit and cannot leave stale grant-shaped UI', async t => {
  const f = await fixture(t);
  const request = { type: 'workspace.request', ...f.binding, client_id: 'client-1',
    request_id: crypto.randomUUID(), description, remaining_ms: 60000 };
  f.controller.notifyAccess = async () => { throw new Error('Synthetic native notification error'); };
  await f.receive(request); await flush();
  assert.equal(f.controller.accessRequests.size, 0);
  assert(f.socket.sent.some(message => message.type === 'workspace.request.received' && message.status === 'failed'));
  assert.equal(f.controller.currentError, 'NOTIFICATION_UNAVAILABLE');
  let complete;
  const cleared = [];
  f.controller.notifyAccess = () => new Promise(resolve => { complete = resolve; });
  f.controller.clearAccessNotification = async id => cleared.push(id);
  request.request_id = crypto.randomUUID();
  await f.receive(request);
  await f.receive({ ...request, type: 'workspace.request.cancel' });
  complete(); await flush();
  assert.equal(f.controller.accessRequests.size, 0);
  assert(cleared.includes(request.request_id));
  assert(!f.socket.sent.some(message => message.request_id === request.request_id && message.status === 'created'));
  assert.equal(f.controller.workspaces.size, 0);
});

test('server restart reconnect republishes an inactive empty summary and clears resolved pairing errors only', async t => {
  const f = await fixture(t), workspace = await start(f);
  const oldEpoch = f.binding.epoch, oldHandle = workspace.tabs.get(100).targetId;
  f.controller.report(Object.assign(new Error('NOT_AUTHORIZED'), { code: 'NOT_AUTHORIZED' }));
  f.controller.loseConnection(f.socket, f.controller.generation);
  clearTimeout(f.controller.reconnectTimer);
  assert.equal(workspace.state, 'inactive');
  assert.equal(workspace.tabs.size, 0);
  f.controller.connect();
  const socket = f.controller.socket;
  socket.onopen();
  const next = { tenant_id, epoch: crypto.randomUUID(), connection_id: crypto.randomUUID() };
  const receive = message => f.controller.receive(JSON.stringify(message), socket, f.controller.generation);
  await receive({ ...next, type: 'challenge', origin, key_id: f.record.key_id, nonce: 'next-nonce' });
  await receive({ ...next, type: 'authenticated', device_id: 'device-1', client_id: 'client-1',
    client_label: 'Atlas', service_started_at: f.controller.now(), protected_origins: [origin] });
  assert.equal(f.controller.phase, 'authenticated');
  assert.equal(f.controller.currentError, null);
  assert(f.controller.failures.includes('NOT_AUTHORIZED'));
  assert.equal(f.controller.snapshot().last_session_end.reason, 'SERVICE_RESTARTED');
  const status = socket.sent.find(message => message.type === 'session.status');
  assert.equal(status.previous_service_epoch, oldEpoch);
  const sync = socket.sent.find(message => message.type === 'workspace.sync');
  assert.equal(sync.state, 'inactive');
  assert.equal(sync.end_reason, 'SERVICE_RESTARTED');
  assert.deepEqual(sync.tabs, []);
  assert(await verify(f.record.public_key, workspacePayload(sync), sync.signature));
  assert.equal(f.calls.some(call => call[0] === 'execute'), false);
  await f.controller.startWorkspace(10);
  assert.notEqual(workspace.tabs.get(100).targetId, oldHandle);
  assert.equal(workspace.endReason, null);
  f.controller.report(Object.assign(new Error('HISTORY_UNAVAILABLE'), { code: 'HISTORY_UNAVAILABLE' }));
  await receive({ ...next, type: 'workspace.active', workspace_id: workspace.id,
    activation_id: workspace.activationId, revision: workspace.revision });
  assert.equal(f.controller.currentError, 'HISTORY_UNAVAILABLE');
});

test('choosing a retained group requires explicit exact-group activation in a normal window, not sidebar presence', async t => {
  const f = await fixture(t);
  f.adapter.api.tabGroups.get = async groupId => ({ windowId: groupId === 2 ? 10 : 11, title: 'DomAgent - Atlas' });
  await f.controller.startWorkspace(10, 2);
  const workspace = [...f.controller.workspaces.values()][0];
  assert.equal(workspace.groupId, 2);
  assert.equal(f.calls.some(call => call[0] === 'remove'), false);
  f.setOpen(false);
  await f.controller.startWorkspace(10, 2);
  assert.equal(workspace.state, 'active');
  f.adapter.api.windows.get = async () => ({ type: 'popup' });
  await assert.rejects(f.controller.startWorkspace(10, 2), /WORKSPACE_CHANGED/);
  f.adapter.api.windows.get = async () => ({ type: 'normal' });
  f.setOpen(true);
  await assert.rejects(f.controller.startWorkspace(10, 3), /WORKSPACE_CHANGED/);
  assert.equal(f.controller.workspaces.size, 1);
});

test('a removed tracked group cannot trap End/Resume or prevent explicitly selecting another retained group', async t => {
  const f = await fixture(t), workspace = await start(f);
  f.adapter.api.tabGroups.query = async () => [{ id: 2, windowId: 10, title: 'DomAgent - Atlas' }];
  f.adapter.api.tabGroups.get = async groupId => {
    if (groupId === 1) throw new Error('No group with id: 1');
    return { id: groupId, windowId: 10 };
  };
  f.adapter.api.tabGroups.update = async groupId => {
    if (groupId === 1) throw new Error('No group with id: 1');
  };
  await f.controller.endWorkspace(workspace);
  assert.equal(f.controller.workspaces.size, 0);
  await f.controller.startWorkspace(10, 2);
  assert.equal([...f.controller.workspaces.values()][0].groupId, 2);
  assert.equal(f.calls.some(call => call[0] === 'remove'), false);
});

test('removed group refresh retires its local record without affecting tabs, and unrelated status errors remain explicit', async t => {
  const f = await fixture(t), workspace = await start(f);
  f.adapter.api.tabGroups.query = async () => [];
  await f.controller.refresh();
  assert.equal(f.controller.workspaces.size, 0);
  assert.equal(workspace.state, 'inactive');
  assert.equal(f.controller.currentError, 'GROUP_UNAVAILABLE');
  assert.equal(f.calls.some(call => call[0] === 'remove'), false);
  const sync = f.socket.sent.filter(message => message.type === 'workspace.sync').at(-1);
  assert.equal(sync.state, 'inactive');
  assert.deepEqual(sync.tabs, []);
  f.adapter.api.tabGroups.query = async () => [{ id: 1, windowId: 10 }];
  f.adapter.api.tabGroups.update = async () => { throw new Error('Group API permission failure'); };
  await assert.rejects(f.controller.groupColor(workspace), /Group API permission failure/);
});

test('group disappearing between existence query and native lookup still retires safely', async t => {
  const f = await fixture(t), workspace = await start(f);
  let queries = 0;
  f.adapter.api.tabGroups.query = async () => ++queries === 1 ? [{ id: 1, windowId: 10 }] : [];
  f.adapter.api.tabGroups.get = async () => { throw new Error('No group with id: 1'); };
  await f.controller.refresh();
  assert.equal(f.controller.workspaces.size, 0);
  assert.equal(workspace.state, 'inactive');
  assert.equal(f.controller.currentError, 'GROUP_UNAVAILABLE');
  assert.equal(f.calls.some(call => call[0] === 'remove'), false);
});

test('new-group recovery ends even an intact inactive workspace without touching retained tabs or authority', async t => {
  const f = await fixture(t), previous = await start(f);
  const oldTarget = previous.tabs.get(100).targetId;
  await f.controller.stopWorkspace(previous, 'inactive', 'WORKSPACE_CHANGED');
  f.adapter.makeGroup = async () => {
    f.calls.push(['makeGroup']);
    return { groupId: 2, tabId: 200 };
  };
  f.tabs.splice(0, 1, { id: 200, windowId: 10, groupId: 2, url: 'about:blank', status: 'complete' });
  f.controller.currentError = 'OUTCOME_UNKNOWN';
  await f.controller.startNewWorkspace(10);
  const current = [...f.controller.workspaces.values()][0];
  assert.equal(f.controller.workspaces.size, 1);
  assert.notEqual(current.id, previous.id);
  assert.equal(current.groupId, 2);
  assert.equal(previous.state, 'inactive');
  assert.equal(previous.tabs.size, 0);
  assert.equal(current.tabs.get(200).pageState, 'navigation_only');
  assert(f.calls.some(call => call[0] === 'makeGroup'));
  assert(!f.calls.some(call => call[0] === 'remove'));
  await f.receive({ ...f.binding, type: 'workspace.active', workspace_id: current.id,
    activation_id: current.activationId, revision: current.revision });
  assert.equal(f.controller.currentError, null);
  f.controller.enqueue(command(f, current, { targetId: oldTarget }));
  assert.equal(f.socket.sent.at(-1).error.code, 'TAB_NOT_IN_WORKSPACE');
});

test('failed fresh activation leaves no authority, and End still clears the local record when its status update fails', async t => {
  const f = await fixture(t);
  f.adapter.api.tabGroups.update = async () => { throw new Error('Group status API failure'); };
  await assert.rejects(f.controller.startWorkspace(10), /Group status API failure/);
  const workspace = [...f.controller.workspaces.values()][0];
  assert.equal(workspace.state, 'inactive');
  assert.equal(workspace.tabs.size, 0);
  await assert.rejects(f.controller.endWorkspace(workspace), /Group status API failure/);
  assert.equal(f.controller.workspaces.size, 0);
  assert(!f.calls.some(call => call[0] === 'remove'));
});

test('protected navigation revokes authority synchronously but retains its rejection guard', async t => {
  const f = await fixture(t), workspace = await start(f);
  f.adapter.onTabEvent(100, 'protected_pending');
  assert.equal(workspace.tabs.size, 0);
  await flush();
  const cleanup = f.calls.find(call => call[0] === 'release');
  assert.equal(cleanup[2].retainProtection, true);
});

test('workspace creation cancellation and activation change cannot publish or navigate a late tab', async t => {
  const f = await fixture(t), workspace = await start(f);
  let resolveCreate;
  f.adapter.api.tabs.create = () => new Promise(resolve => { resolveCreate = resolve; });
  f.adapter.api.tabs.group = async () => { f.calls.push(['group']); };
  const message = command(f, workspace, { targetId: workspace.id }, {
    operation: 'create_workspace_tab', args: { url: 'https://page.example/' },
  });
  f.controller.enqueue(message); await flush();
  const executing = f.controller.executeReady({ request_id: message.request_id, target_id: workspace.id, execution_timeout_ms: 25000 });
  await flush();
  const task = workspace.tasks[0];
  await f.receive({ ...f.binding, type: 'command.cancel', request_id: message.request_id, target_id: workspace.id });
  assert.equal(task.cancelled, true);
  await f.controller.stopWorkspace(workspace, 'paused');
  await f.controller.startWorkspace(10);
  resolveCreate({ id: 201, windowId: 10 });
  await executing; await flush();
  assert(!f.calls.some(call => call[0] === 'group'));
  assert(f.calls.some(call => call[0] === 'remove' && call[1] === 201));
  assert(!f.calls.some(call => call[0] === 'execute' && call[1] === 201));
});
