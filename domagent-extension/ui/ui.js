import { serviceOrigin } from '../../shared/protocol.js';

const api = typeof browser === 'undefined' ? chrome : browser;
const byId = id => document.getElementById(id);
let state, busy = false, windowId;
const errors = {
  PLATFORM_UNSUPPORTED: 'Update the browser: native tab groups and sidebar lifecycle support are required.',
  NOT_AUTHORIZED: 'This connection is not authorized. Check the selected client or pair again.',
  PAIRING_UNAVAILABLE: 'Pairing expired or is unavailable. Start again for a fresh code.',
  PAIRING_CODE_COLLISION: 'That code could not be reserved. Choose Start again.',
  WORKSPACE_INACTIVE: 'Open the DomAgent sidebar and explicitly start/resume this workspace.',
  WORKSPACE_PAUSED: 'This workspace is paused. Resume it yourself when ready.',
  DOCUMENT_NOT_CONTROLLABLE: 'This document cannot be inspected. Ordinary website navigation may still be available.',
  PERMISSION_REQUIRED: 'Website permission was declined. Nothing has been authorized.',
  BROWSER_OFFLINE: 'The browser connection is offline. Reconnect; existing work will not be replayed.',
  PANEL_OPEN_REQUIRED: 'Click the DomAgent toolbar in this window to open its native sidebar.',
  TAB_LIMIT_REACHED: 'The workspace has reached its eight-tab limit.',
  NOTIFICATION_UNAVAILABLE: 'The system notification could not be delivered. Check browser notification settings.',
};
function error(value) { byId('error').textContent = errors[value.message] || `DomAgent: ${value.message}`; }
async function request(type, fields = {}) {
  const response = await api.runtime.sendMessage({ type: `ui.${type}`, ...fields });
  if (!response?.ok) throw new Error(response?.error?.code || 'BROWSER_OFFLINE');
  return response.value;
}
async function run(operation) {
  if (busy) return;
  busy = true; byId('error').textContent = '';
  try { await operation(); await refresh(); } catch (failure) { error(failure); } finally { busy = false; }
}
function text(parent, value) {
  const node = document.createElement('p'); node.textContent = value; parent.append(node);
}
function button(parent, label, operation) {
  const node = document.createElement('button'); node.type = 'button'; node.textContent = label;
  node.onclick = () => { void run(operation); }; parent.append(node);
}
function render(snapshot) {
  state = snapshot;
  byId('status').textContent = snapshot.phase === 'authenticated'
    ? `Connected to ${snapshot.identity?.client_label || snapshot.identity?.tenant_label || 'your assistant'}`
    : 'No browser access enabled. Connect your assistant.';
  byId('identity').textContent = snapshot.browser_info
    ? `Extension ${snapshot.browser_info.extension_version} - ${snapshot.browser_info.browser_name} ${snapshot.browser_info.browser_version || ''}`
    : '';
  if (byId('pairing')) {
    byId('pairing').replaceChildren();
    const pairing = snapshot.pairing;
    if (pairing) {
      text(byId('pairing'), `Tell your assistant this pairing code: ${pairing.code}`);
      text(byId('pairing'), `Expires ${new Date(pairing.expires_at).toLocaleTimeString()}. It is not an application credential.`);
      button(byId('pairing'), 'Copy code', () => navigator.clipboard.writeText(pairing.code));
      if (pairing.state === 'proposed') {
        text(byId('pairing'), `${pairing.proposal.client_label} wants to connect. This application label is not a verified human identity.`);
        button(byId('pairing'), 'Connect and start workspace', async () => {
          const permission = api.permissions.request({ origins: ['http://*/*', 'https://*/*'] });
          const opening = api.sidePanel ? api.sidePanel.open({ windowId }) : api.sidebarAction.open();
          if (!await permission) throw new Error('PERMISSION_REQUIRED');
          await request('confirmPairing');
          await opening;
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            const snapshot = await request('state');
            if (snapshot.phase === 'authenticated') {
              await request('start', { windowId }); return;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          throw new Error('BROWSER_OFFLINE');
        });
        button(byId('pairing'), 'Decline', () => request('cancelPairing'));
      } else button(byId('pairing'), 'Start again', () => request('pairAgain'));
    }
  }
  const targets = byId('targets');
  if (targets) {
    targets.replaceChildren();
    const workspace = snapshot.workspaces[0];
    if (!workspace) {
      text(targets, 'Start a fresh grouped workspace. Normal website logins are reused; this is not a sandbox.');
      button(targets, 'Start browsing with your assistant', async () => {
        const granted = await api.permissions.request({ origins: ['http://*/*', 'https://*/*'] });
        if (!granted) throw new Error('PERMISSION_REQUIRED');
        await request('start', { windowId });
      });
    } else {
      text(targets, `Workspace ${workspace.state}. Grouped tabs are available in the background.`);
      if (workspace.state !== 'active') {
        button(targets, 'Resume workspace', () => request('start', { windowId }));
      } else button(targets, 'Pause all', () => request('pause', { workspace_id: workspace.workspace_id }));
      button(targets, 'End session', () => request('end', { workspace_id: workspace.workspace_id }));
      button(targets, 'Add current tab', () => request('add', { workspace_id: workspace.workspace_id }));
      button(targets, 'Move task to its own window', () => request('move', { workspace_id: workspace.workspace_id }));
      for (const tab of workspace.tabs) {
        const row = document.createElement('article');
        text(row, `${tab.title} - ${tab.page_state}`);
        button(row, 'Go to tab', () => request('focus', { workspace_id: workspace.workspace_id, tabId: tab.tabId }));
        for (const command of tab.commands) {
          text(row, `${command.operation}: ${command.description}`);
          if (command.human && !command.executing) {
            button(row, 'Done', () => request('decision', { request_id: command.request_id, action: 'done' }));
            button(row, 'Cancel', () => request('decision', { request_id: command.request_id, action: 'cancel' }));
          }
        }
        targets.append(row);
      }
    }
  }
  if (byId('activity')) {
    byId('activity').replaceChildren();
    for (const event of snapshot.activity.slice(-50).reverse()) {
      text(byId('activity'), `${new Date(event.time).toLocaleTimeString()} ${event.event} ${event.operation || ''} ${event.code || ''}`);
    }
    if (byId('connections')) {
      byId('connections').replaceChildren();
      for (const connection of snapshot.saved_connections) {
        if (connection.origin === snapshot.config.service_origin && connection.tenant_id === snapshot.config.tenant_id) continue;
        button(byId('connections'), `Select ${connection.label}`, () => request('switch', {
          origin: connection.origin, tenant_id: connection.tenant_id,
        }));
      }
    }
  }
  if (snapshot.failures.length) error(new Error(snapshot.failures.at(-1)));
}
async function refresh() { render(await request('state', location.pathname === '/panel.html' ? { windowId } : {})); }
byId('config')?.addEventListener('submit', event => {
  event.preventDefault();
  void run(async () => {
    let input = byId('domain').value.trim();
    if (!input.includes('://')) input = `https://${input}`;
    const origin = serviceOrigin(input);
    if (!await api.permissions.request({ origins: [`${origin}/*`] })) throw new Error('PERMISSION_REQUIRED');
    await request('configure', { service_origin: origin });
  });
});
byId('options')?.addEventListener('click', () => api.runtime.openOptionsPage().catch(error));
byId('connect')?.addEventListener('click', () => { void run(() => request('connect')); });
byId('disconnect')?.addEventListener('click', () => { void run(() => request('disconnect')); });
byId('open-panel')?.addEventListener('click', () => {
  const open = api.sidePanel ? api.sidePanel.open({ windowId }) : api.sidebarAction.open();
  void open.catch(error);
});
void api.windows.getCurrent().then(browserWindow => {
  windowId = browserWindow.id;
  if (location.pathname === '/panel.html') {
    const port = api.runtime.connect({ name: 'domagent-panel' });
    const heartbeat = () => port.postMessage({ type: 'heartbeat', windowId });
    const timer = setInterval(heartbeat, 1000);
    port.onMessage.addListener(message => { if (message.type === 'state') render(message.value); });
    port.onDisconnect.addListener(() => { clearInterval(timer); error(new Error('WORKSPACE_INACTIVE')); });
    window.addEventListener('pagehide', () => { clearInterval(timer); port.disconnect(); }, { once: true });
    heartbeat();
  } else setInterval(() => { if (!busy) void refresh().catch(error); }, 1500);
  return refresh();
}).catch(error);
