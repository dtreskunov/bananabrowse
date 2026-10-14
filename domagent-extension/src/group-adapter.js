import { BrowserAdapter } from './adapter.js';
import { fail } from './security.js';
import { navigationUrl, WORKSPACE_LEASE_MS } from '../../shared/protocol.js';
import { controlFrame } from './control-frame.js';

export class GroupAdapter extends BrowserAdapter {
  constructor(api, browserName) {
    super(api, browserName);
    this.panels = new Map();
    this.openWindows = new Set();
    this.createdTabs = new Set();
    this.managedGroups = new Set();
    this.controlledTabs = new Set();
    this.onGroupsChanged = () => {};
    this.onPanelClosed = () => {};
  }

  async initialize() {
    if (!this.api.tabs.group || !this.api.tabGroups?.update) fail('PLATFORM_UNSUPPORTED');
    if (this.browserName === 'chrome' && (!this.api.sidePanel?.onOpened || !this.api.sidePanel?.onClosed)) {
      fail('PLATFORM_UNSUPPORTED');
    }
    await super.initialize([]);
    const changed = () => this.onGroupsChanged();
    this.api.tabs.onUpdated.addListener(changed);
    this.api.tabs.onAttached.addListener(changed);
    this.api.tabs.onDetached.addListener(changed);
    this.api.tabs.onRemoved.addListener(changed);
    this.api.tabGroups.onRemoved.addListener(changed);
    this.api.tabGroups.onMoved.addListener(changed);
    this.api.tabs.onCreated.addListener(tab => {
      if (this.managedGroups.has(tab.groupId) || this.controlledTabs.has(tab.openerTabId)) this.createdTabs.add(tab.id);
      changed();
    });
    this.api.tabs.onRemoved.addListener(tabId => {
      this.createdTabs.delete(tabId); this.controlledTabs.delete(tabId);
    });
    if (this.browserName === 'chrome') {
      this.api.sidePanel.onOpened.addListener(info => {
        if (info.path.replace(/^\//, '').split('?')[0] === 'panel.html') this.openWindows.add(info.windowId);
      });
      this.api.sidePanel.onClosed.addListener(info => {
        this.openWindows.delete(info.windowId);
        this.onPanelClosed(info.windowId);
      });
    }
  }

  registerPanel(windowId, port) {
    this.panels.set(windowId, { port, touched: Date.now() });
  }

  touchPanel(windowId, port) {
    const panel = this.panels.get(windowId);
    if (panel?.port !== port) fail('NOT_AUTHORIZED');
    panel.touched = Date.now();
  }

  unregisterPanel(windowId, port) {
    if (this.panels.get(windowId)?.port !== port) return;
    this.panels.delete(windowId);
  }

  async panelOpen(windowId) {
    const panel = this.panels.get(windowId);
    if (!panel || Date.now() - panel.touched >= WORKSPACE_LEASE_MS) {
      return false;
    }
    if (this.browserName === 'firefox') return this.api.sidebarAction.isOpen({ windowId });
    return this.openWindows.has(windowId);
  }

  async openPanel(tab) {
    if (this.browserName === 'chrome') return this.api.sidePanel.open({ windowId: tab.windowId });
    return this.api.sidebarAction.open();
  }

  async selectedTab(windowId) {
    const window = windowId ?? this.selectedWindowId ?? (await this.api.windows.getCurrent()).id;
    if ((await this.api.windows.get(window)).type !== 'normal') fail('TARGET_STALE');
    return (await this.api.tabs.query({ windowId: window, active: true }))[0] || null;
  }

  async setControlFrame(grant, visible) {
    const target = { tabId: grant.tabId, frameIds: [0] };
    if (visible) {
      await this.assertWorkspace(grant);
      const current = await this.api.tabs.get(grant.tabId);
      navigationUrl(current.pendingUrl || current.url, grant.protected_origins);
      await this.api.scripting.insertCSS({ target, files: ['control-frame.css'], origin: 'USER' });
    } else await this.api.scripting.removeCSS({ target, files: ['control-frame.css'], origin: 'USER' });
    const result = await this.api.scripting.executeScript({ target, world: 'ISOLATED', func: controlFrame, args: [visible] });
    if (!result?.[0]?.result || result[0].error) fail('CONTROL_FRAME_UNAVAILABLE');
    return result[0].result.visible;
  }

  async release(tabId, options) {
    void this.setControlFrame({ tabId }, false).catch(error => {
      console.warn('DomAgent controlled-page indicator cleanup unavailable; control remains revoked.');
    });
    return super.release(tabId, options);
  }

  async makeGroup(windowId, label) {
    const tab = await this.api.tabs.create({ windowId, url: 'about:blank', active: false });
    try {
      const groupId = await this.api.tabs.group({ tabIds: [tab.id] });
      await this.api.tabGroups.update(groupId, { title: `DomAgent - ${label}`, color: 'blue', collapsed: false });
      this.managedGroups.add(groupId);
      this.createdTabs.delete(tab.id);
      return { groupId, tabId: tab.id };
    } catch (error) {
      await this.api.tabs.remove(tab.id);
      throw error;
    }
  }

  async assertWorkspace(grant) {
    const tab = await this.api.tabs.get(grant.tabId);
    const group = await this.api.tabGroups.get(grant.groupId);
    if (tab.windowId !== grant.windowId || tab.groupId !== grant.groupId || group.windowId !== grant.windowId) {
      fail('TAB_NOT_IN_WORKSPACE');
    }
  }

  async execute(grant, operation, args, check, preview) {
    if (operation !== 'navigate') return super.execute(grant, operation, args, check, preview);
    await this.assertWorkspace(grant);
    check();
    const url = navigationUrl(args.url, grant.protected_origins);
    const prior = await this.api.tabs.get(grant.tabId);
    grant.navigation = { from: prior.url, url };
    await this.api.tabs.update(grant.tabId, { url });
    grant.url = url; grant.pageState = 'loading';
    check(true);
    return { url, navigation_started: true };
  }

  async prepareAction(grant, operation, args, check) {
    if (operation !== 'navigate') return super.prepareAction(grant, operation, args, check);
    await this.assertWorkspace(grant);
    check();
    return { summary: [`Operation: navigate`, `Destination: ${navigationUrl(args.url, grant.protected_origins)}`] };
  }

  async focusTab(tabId) {
    const tab = await this.api.tabs.get(tabId);
    await this.api.windows.update(tab.windowId, { focused: true });
    await this.api.tabs.update(tabId, { active: true });
  }
}
