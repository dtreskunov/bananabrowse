import { GroupAdapter } from './group-adapter.js';
import { Controller } from './controller.js';
import { DeviceKeys } from './keys.js';
import { errorCode, fail, isUiSender } from './security.js';
import { serviceOrigin } from '../../shared/protocol.js';

const api = typeof browser === 'undefined' ? chrome : browser;
const action = api.action || api.browserAction;
const adapter = new GroupAdapter(api, BUILD_BROWSER);
let controller;
let fatal;
const menu = api.menus || api.contextMenus;

async function badge() {
  const state = controller.snapshot();
  const count = state.pending_human.length;
  const active = state.workspaces.some(workspace => workspace.state === 'active');
  await action.setBadgeText({ text: count ? `${count}` : active ? 'ON' : '' });
  await action.setBadgeBackgroundColor({ color: count ? '#be6824' : '#365375' });
  await action.setTitle({ title: count ? `DomAgent: ${count} task(s) need your help` : active ? 'DomAgent: workspace active' : 'DomAgent: inactive' });
}

controller = new Controller({
  adapter, keys: new DeviceKeys(), storage: api.storage.local, extensionUrl: api.runtime.getURL(''),
  changed: () => { void badge().catch(error => console.error('DomAgent badge:', errorCode(error))); },
  notify: async requestId => {
    const options = { type: 'basic', iconUrl: api.runtime.getURL('icons/icon128.png'),
      title: 'DomAgent needs your help', message: 'Your assistant is waiting for a browser task. Click to go to the task.' };
    if (controller.notificationTasks.size > 1) {
      const updated = await api.notifications.update('domagent-human', {
        message: `${controller.notificationTasks.size} browser tasks need your help. Click to go to a task.`,
      });
      if (updated) return;
    }
    await api.notifications.create('domagent-human', options);
  },
  clearNotification: async () => {
    const remaining = controller.notificationTasks.size;
    if (!remaining) await api.notifications.clear('domagent-human');
    else await api.notifications.update('domagent-human', {
      message: `${remaining} browser task(s) need your help. Click to go to a task.`,
    });
  },
});
const ready = controller.initialize().catch(error => { fatal = error; controller.report(error); });
let localMutation = Promise.resolve();

async function uiAction(message) {
  await ready;
  if (fatal) throw fatal;
  if (message.type === 'ui.state') {
    const snapshot = controller.snapshot();
    const groups = message.windowId === undefined ? [] : await api.tabGroups.query({ windowId: message.windowId });
    return { ...snapshot, available_groups: groups.slice(0, 20).map(group => ({
      groupId: group.id, title: group.title || 'Untitled group',
    })), ...(message.windowId !== undefined ? {
      workspaces: snapshot.workspaces.filter(workspace => workspace.windowId === message.windowId),
    } : {}) };
  }
  if (message.type === 'ui.configure') {
    let value = message.service_origin.trim();
    if (!value.includes('://')) value = `https://${value}`;
    const origin = serviceOrigin(value);
    if (!await api.permissions.contains({ origins: [`${origin}/*`] })) fail('PERMISSION_REQUIRED');
    const response = await fetch(`${origin}/.well-known/domagent`, { credentials: 'omit', redirect: 'error',
      signal: AbortSignal.timeout(10000) });
    const raw = await response.text();
    if (!response.ok || raw.length > 4096) fail('INVALID_MESSAGE');
    const metadata = JSON.parse(raw);
    if (metadata.service !== 'domagent' || metadata.protocol_version !== 5) fail('PLATFORM_UNSUPPORTED');
    await controller.configure({ service_origin: origin });
    return controller.beginPairing();
  }
  if (message.type === 'ui.pairAgain') return controller.beginPairing();
  if (message.type === 'ui.confirmPairing') return controller.confirmPairing();
  if (message.type === 'ui.cancelPairing') return controller.cancelPairing();
  if (message.type === 'ui.connect') return controller.enable();
  if (message.type === 'ui.disconnect') return controller.disconnect();
  if (message.type === 'ui.switch') return controller.switchConnection(message.origin, message.tenant_id);
  if (message.type === 'ui.start') return controller.startWorkspace(message.windowId, message.groupId);
  if (message.type === 'ui.decision') return controller.decide(message.request_id, message.action);
  const workspace = controller.workspaces.get(message.workspace_id);
  if (!workspace) fail('WORKSPACE_INACTIVE');
  if (message.type === 'ui.pause') return controller.stopWorkspace(workspace, 'paused');
  if (message.type === 'ui.end') return controller.stopWorkspace(workspace, 'inactive');
  if (message.type === 'ui.focus') {
    if (!workspace.tabs.has(message.tabId)) fail('TAB_NOT_IN_WORKSPACE');
    return adapter.focusTab(message.tabId);
  }
  if (message.type === 'ui.add') {
    const tab = await adapter.selectedTab(workspace.windowId);
    if (!tab) fail('TARGET_STALE');
    adapter.createdTabs.delete(tab.id); workspace.excluded.delete(tab.id);
    await api.tabs.group({ groupId: workspace.groupId, tabIds: [tab.id] });
    return controller.refresh();
  }
  if (message.type === 'ui.move') {
    await controller.stopWorkspace(workspace, 'paused');
    const tabs = await api.tabs.query({ groupId: workspace.groupId });
    if (!tabs.length) fail('TAB_NOT_IN_WORKSPACE');
    const window = await api.windows.create({ tabId: tabs[0].id, type: 'normal', focused: true });
    if (tabs.length > 1) await api.tabs.move(tabs.slice(1).map(tab => tab.id), { windowId: window.id, index: -1 });
    workspace.groupId = await api.tabs.group({ tabIds: tabs.map(tab => tab.id) });
    workspace.windowId = window.id;
    await api.tabGroups.update(workspace.groupId, { title: `DomAgent - ${controller.connection.client_label}`, color: 'grey' });
    await adapter.openPanel({ windowId: window.id });
    return;
  }
  fail('INVALID_MESSAGE');
}

api.runtime.onMessage.addListener((message, sender, respond) => {
  if (!isUiSender(sender, api.runtime)) { respond({ ok: false, error: { code: 'NOT_AUTHORIZED' } }); return false; }
  const run = () => uiAction(message);
  const immediate = ['ui.state', 'ui.pause', 'ui.end', 'ui.disconnect', 'ui.decision'].includes(message.type);
  const work = immediate ? run() : localMutation.then(run, run);
  if (!immediate) localMutation = work;
  work.then(value => respond({ ok: true, value }), error => {
    controller.report(error); respond({ ok: false, error: { code: errorCode(error) } });
  });
  return true;
});

api.runtime.onConnect.addListener(port => {
  const sender = port.sender;
  if (port.name !== 'domagent-panel' || !isUiSender(sender, api.runtime) ||
      new URL(sender.url).pathname !== '/panel.html' || sender.tab) {
    port.disconnect(); return;
  }
  let windowId;
  port.onMessage.addListener(message => {
    void ready.then(async () => {
      if (message.type !== 'heartbeat' || !Number.isSafeInteger(message.windowId)) fail('INVALID_MESSAGE');
      if (windowId === undefined) {
        windowId = message.windowId;
        adapter.registerPanel(windowId, port);
      } else if (message.windowId !== windowId) fail('NOT_AUTHORIZED');
      adapter.touchPanel(windowId, port);
      const snapshot = controller.snapshot();
      const groups = await api.tabGroups.query({ windowId });
      port.postMessage({ type: 'state', value: { ...snapshot,
        available_groups: groups.slice(0, 20).map(group => ({ groupId: group.id, title: group.title || 'Untitled group' })),
        workspaces: snapshot.workspaces.filter(workspace => workspace.windowId === windowId) } });
    }).catch(error => { controller.report(error); port.disconnect(); });
  });
  port.onDisconnect.addListener(() => { if (windowId !== undefined) adapter.unregisterPanel(windowId, port); });
});

async function goToHuman(requestId) {
  const task = controller.notificationTasks.get(requestId);
  if (!task) return;
  controller.check(task.workspace, task.tab, task.task);
  await adapter.focusTab(task.tab.tabId);
  await adapter.openPanel({ windowId: task.workspace.windowId });
}
api.notifications.onClicked.addListener(requestId => {
  const pending = requestId === 'domagent-human' ? [...controller.notificationTasks.keys()][0] : requestId;
  if (pending) void goToHuman(pending).catch(error => controller.report(error));
});
action.onClicked.addListener(tab => {
  const opening = adapter.openPanel(tab);
  void opening.then(async () => {
    await ready;
    if (fatal) throw fatal;
    const human = [...controller.notificationTasks.keys()][0];
    if (human) return goToHuman(human);
    if (!controller.record?.identity) return api.runtime.openOptionsPage();
    const workspace = [...controller.workspaces.values()].find(workspace => workspace.windowId === tab.windowId);
    if (workspace?.state === 'paused' || workspace?.state === 'active') return;
    const permission = await api.permissions.contains({ origins: ['http://*/*', 'https://*/*'] });
    if (!permission) return;
    if (!workspace) {
      const groups = await api.tabGroups.query({ windowId: tab.windowId });
      if (groups.some(group => group.title?.startsWith('DomAgent - '))) return;
    }
    const deadline = Date.now() + 3000;
    while (!await adapter.panelOpen(tab.windowId)) {
      if (Date.now() >= deadline) fail('PANEL_OPEN_REQUIRED');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await controller.startWorkspace(tab.windowId);
  }).catch(error => controller.report(error));
});
api.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') void api.runtime.openOptionsPage().catch(error => controller.report(error));
});
void ready.then(async () => {
  await menu.removeAll();
  const create = properties => new Promise((resolve, reject) => {
    menu.create(properties, () => {
      const error = api.runtime.lastError;
      if (error) reject(new Error('TAB_MENU_UNAVAILABLE')); else resolve();
    });
  });
  try {
    await create({ id: 'domagent-add', title: 'Add to DomAgent workspace', contexts: ['tab'] });
    await create({ id: 'domagent-remove', title: 'Remove from DomAgent workspace', contexts: ['tab'] });
  } catch (error) {
    console.warn('DomAgent native tab menus unavailable; toolbar/sidebar remains available.');
    await menu.removeAll();
    await create({ id: 'domagent-add', title: 'Add to DomAgent workspace', contexts: ['page'] });
  }
}).catch(error => controller.report(error));
menu.onClicked.addListener((info, tab) => {
  void ready.then(async () => {
    const workspace = [...controller.workspaces.values()].find(workspace => workspace.windowId === tab.windowId);
    if (!workspace) fail('WORKSPACE_INACTIVE');
    if (info.menuItemId === 'domagent-remove') {
      const controlled = workspace.tabs.get(tab.id);
      if (controlled) controller.dropTab(workspace, controlled, 'TAB_NOT_IN_WORKSPACE');
      await api.tabs.ungroup([tab.id]);
      await controller.sync(workspace);
    } else if (info.menuItemId === 'domagent-add') {
      adapter.createdTabs.delete(tab.id); workspace.excluded.delete(tab.id);
      await api.tabs.group({ groupId: workspace.groupId, tabIds: [tab.id] });
      await controller.refresh();
    }
  }).catch(error => controller.report(error));
});
