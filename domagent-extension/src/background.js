import { BrowserAdapter } from './adapter.js';
import { Controller, LOCAL_END_REASONS } from './controller.js';
import { DeviceKeys } from './keys.js';
import { errorCode, fail, isUiSender, needsSetup } from './security.js';
import { parseConnectionUrl } from '../../shared/protocol.js';

const api = typeof browser === 'undefined' ? chrome : browser;
const adapter = new BrowserAdapter(api, BUILD_BROWSER);
let controller;
let ready;
let fatalError;

function updateBadge() {
  if (!controller) return;
  const snapshot = controller.snapshot();
  const active = snapshot.targets.some(target => target.state === 'active');
  let badge = 'OFF';
  if (active) badge = 'ON';
  else if (snapshot.pending.length) badge = '?';
  else if (snapshot.phase === 'authenticated') badge = 'IDLE';
  let title = 'DomAgent: not connected. No tabs are being shared.';
  if (active) {
    const names = snapshot.targets.filter(target => target.state === 'active').map(target => target.client_label);
    title = `DomAgent: ${names.join(', ')} can use the shared tab.`;
  } else if (snapshot.pending.length) title = 'DomAgent: sharing request waiting';
  else if (snapshot.phase === 'authenticated') {
    title = `DomAgent: connected to ${snapshot.identity.tenant_label}. No tabs are being shared.`;
  }
  Promise.all([
    api.action.setBadgeText({ text: badge }),
    api.action.setBadgeBackgroundColor({ color: active ? '#a4262c' : '#365375' }),
    api.action.setTitle({ title }),
  ]).catch(error => console.error('DomAgent badge update:', error));
}

function notify(title, message) {
  api.notifications.create(crypto.randomUUID(), {
    type: 'basic', iconUrl: api.runtime.getURL('icons/icon128.png'), title, message,
  }).catch(error => console.error('DomAgent notification:', error));
}

controller = new Controller({
  adapter, keys: new DeviceKeys(), storage: api.storage.local,
  inventoryStorage: api.storage.session,
  extensionUrl: api.runtime.getURL(''), changed: updateBadge, notify,
});
ready = controller.initialize().catch(error => {
  fatalError = error;
  controller.report(error);
});

api.runtime.onInstalled.addListener(details => {
  void ready.then(() => {
    if (needsSetup(details.reason, controller.snapshot().identity)) return api.runtime.openOptionsPage();
  }).catch(error => controller.report(error));
});

let localMutation = Promise.resolve();
async function uiAction(message) {
  await ready;
  if (fatalError) fail('PROTECTION_UNAVAILABLE');
  if (!message || typeof message !== 'object') fail('INVALID_MESSAGE');
  if (message.type === 'ui.state') return controller.snapshot();
  if (message.type === 'ui.configure') {
    const { origin } = parseConnectionUrl(message.config.connection_url);
    if (!await api.permissions.contains({ origins: [`${origin}/*`] })) fail('PERMISSION_REQUIRED');
    return controller.configure(message.config);
  }
  if (message.type === 'ui.switch') return controller.switchConnection(message.connection_url);
  if (message.type === 'ui.enroll') return controller.enroll(message.label);
  if (message.type === 'ui.openSignIn') {
    const enrollment = controller.snapshot().enrollment;
    if (!enrollment || enrollment.expires_at <= Date.now()) fail('ENROLLMENT_EXPIRED');
    return api.tabs.create({ url: enrollment.verification_url, active: true });
  }
  if (message.type === 'ui.enrollmentStatus') return controller.enrollmentStatus();
  if (message.type === 'ui.confirmEnrollment') return controller.confirmEnrollment();
  if (message.type === 'ui.connect') return controller.enable();
  if (message.type === 'ui.disconnect') return controller.disconnect();
  if (message.type === 'ui.approve') return controller.approve(message.request_id, message.capabilities);
  if (message.type === 'ui.deny') return controller.deny(message.request_id);
  if (message.type === 'ui.end') {
    if (!LOCAL_END_REASONS.has(message.reason)) fail('INVALID_ARGUMENT');
    return controller.end(message.target_id, message.reason);
  }
  if (message.type === 'ui.resume') return controller.resume(message.client_id);
  if (message.type === 'ui.inspectTab') {
    if (!controller.snapshot().targets.some(target => target.tabId === message.tabId)) fail('NOT_AUTHORIZED');
    return api.tabs.update(message.tabId, { active: true });
  }
  fail('INVALID_MESSAGE');
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'page.stop') {
    // This one content-script action cannot mutate settings or grant authority.
    ready.then(() => controller.stopFromPage(message, sender, api.runtime.id)).then(
      () => sendResponse({ ok: true }),
      () => sendResponse({ ok: false, error: { code: 'NOT_AUTHORIZED' } }),
    );
    return true;
  }
  if (!isUiSender(sender, api.runtime)) {
    sendResponse({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
    return false;
  }
  const run = () => uiAction(message);
  const immediate = ['ui.state', 'ui.end', 'ui.disconnect'].includes(message?.type);
  const operation = immediate ? run() : localMutation.then(run, run);
  if (!immediate) localMutation = operation;
  operation.then(
    value => sendResponse({ ok: true, value }),
    error => {
      controller.report(error);
      sendResponse({ ok: false, error: { code: errorCode(error) } });
    },
  );
  return true;
});
