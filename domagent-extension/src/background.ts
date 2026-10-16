// The extension UI and all browser control live in the app window (app.html).
// This background script only opens/focuses that window and cleans up after it closes.
declare const browser: any;
declare const chrome: any;
declare const BUILD_BROWSER: 'chrome' | 'firefox';
const api: any = typeof browser === 'undefined' ? chrome : browser;
const APP = 'app.html';

async function appWindowId() {
  const { appWindowId: id } = await api.storage.session.get('appWindowId');
  if (!Number.isInteger(id)) return null;
  try { await api.windows.get(id); return id; }
  catch { await api.storage.session.remove('appWindowId'); return null; }
}

async function openApp() {
  const existing = await appWindowId();
  if (existing !== null) { await api.windows.update(existing, { focused: true }); return; }
  const { bounds } = await api.storage.local.get('bounds');
  const size = { width: 440, height: 760 };
  if (bounds && Number.isInteger(bounds.width) && Number.isInteger(bounds.height)) {
    Object.assign(size, { width: Math.max(360, bounds.width), height: Math.max(480, bounds.height) });
    if (Number.isInteger(bounds.left) && Number.isInteger(bounds.top)) Object.assign(size, { left: bounds.left, top: bounds.top });
  }
  const window = await api.windows.create({ url: api.runtime.getURL(APP), type: 'popup', focused: true, ...size });
  await api.storage.session.set({ appWindowId: window.id });
}

async function cleanup() {
  // Browser authority ends with the window; remove anything it could not tear down while unloading.
  await api.action.setBadgeText({ text: '' }).catch(() => {});
  await api.action.setTitle({ title: 'DomAgent (closed)' }).catch(() => {});
  await (api.menus || api.contextMenus).removeAll().catch(() => {});
  const notifications = await api.notifications.getAll().catch(() => ({}));
  for (const id of Object.keys(notifications)) if (id.startsWith('domagent-')) await api.notifications.clear(id).catch(() => {});
  if (BUILD_BROWSER === 'chrome') {
    const rules = await api.declarativeNetRequest.getSessionRules().catch(() => []);
    if (rules.length) await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map((rule: any) => rule.id) }).catch(() => {});
    const targets = await api.debugger.getTargets().catch(() => []);
    for (const target of targets) {
      if (target.attached && Number.isInteger(target.tabId)) await api.debugger.detach({ tabId: target.tabId }).catch(() => {});
    }
  }
}

api.action.onClicked.addListener(() => { void openApp().catch(error => console.error('DomAgent:', error?.message)); });
api.runtime.onInstalled.addListener((details: any) => {
  if (details.reason === 'install') void openApp().catch(error => console.error('DomAgent:', error?.message));
});
api.runtime.onStartup.addListener(() => {
  void api.storage.local.get('settings').then(({ settings }: any) => {
    if (settings?.openAtStartup === true) return openApp();
    return cleanup();
  }).catch((error: any) => console.error('DomAgent:', error?.message));
});
api.windows.onRemoved.addListener((windowId: number) => {
  void api.storage.session.get('appWindowId').then(async ({ appWindowId: id }: any) => {
    if (id !== windowId) return;
    await api.storage.session.remove('appWindowId');
    await cleanup();
  }).catch(() => {});
});
api.runtime.onMessage.addListener((message: any, sender: any, respond: (response: unknown) => void) => {
  if (sender.id !== api.runtime.id || message?.type !== 'open-app') return false;
  void openApp().then(() => respond({ ok: true }), () => respond({ ok: false }));
  return true;
});
