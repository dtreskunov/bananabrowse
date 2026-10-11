import { parseConnectionUrl } from '../../shared/protocol.js';

const api = typeof browser === 'undefined' ? chrome : browser;
const byId = id => document.getElementById(id);
let busy = false;
let formLoaded = false;
let lastRender = '';

const errors = {
  INVALID_CONNECTION_LINK: 'Paste a connection link like https://example.org/join/… — not an approval link or a password.',
  INVALID_TENANT: 'This connection link is incomplete. Ask your assistant for a new link.',
  INVALID_SERVICE_ORIGIN: 'Use the secure connection link your assistant gave you.',
  PERMISSION_REQUIRED: 'Permission was declined. You can try again when you are ready.',
  NOT_AUTHORIZED: "You don't have access to this connection. Ask its owner, or check the link.",
  ENROLLMENT_EXPIRED: 'This request expired. Choose Start again.',
  BROWSER_OFFLINE: 'Connection lost. No tabs are being shared. Try again.',
  PROTECTION_UNAVAILABLE: 'Sharing is unavailable because browser protection could not start.',
  HANDOFF_REQUIRED: 'This operation is unavailable. You can complete it yourself in the shared tab.',
  PAGE_UNAVAILABLE: 'Sharing stopped because the browser could not inspect this page.',
  TARGET_STALE: 'The selected tab or document changed. Review the new request before approving.',
  COMMAND_EXPIRED: 'This action expired. Ask your assistant for a fresh request.',
  COMMAND_CANCELLED: 'The assistant cancelled this request. No new action will be started.',
  ACTION_DECLINED: 'This request was declined. No action will be started.',
  INVALID_MESSAGE: 'The action could not be started safely. Ask your assistant for a fresh request.',
  INVALID_ARGUMENT: 'The requested action was incomplete or invalid. Ask your assistant to correct it.',
  OUTCOME_UNKNOWN: 'The connection ended before the action was confirmed. It may already have happened; check the tab before trying again.',
  CAPABILITY_UNAVAILABLE: 'This action is not supported on the current page or browser.',
  APPROVAL_REQUIRED: 'This sharing request ended. Ask your assistant to try again.',
  ELEMENT_NOT_FOUND: 'No matching element was found. Ask your assistant to inspect the page again.',
  ELEMENT_AMBIGUOUS: 'More than one element matched. Ask your assistant to use a specific page reference.',
  ELEMENT_STALE: 'That element was removed or its snapshot expired. Ask your assistant for a fresh page snapshot.',
  ELEMENT_DISABLED: 'This control is disabled. Complete any required steps before trying again.',
  ELEMENT_READONLY: 'This field is read-only.',
  ELEMENT_NOT_VISIBLE: 'This control is not visible.',
  ELEMENT_OBSCURED: 'Another element covers this control. Dismiss the covering dialog before trying again.',
  ELEMENT_NOT_EDITABLE: 'This control does not support the requested operation.',
  OPTION_NOT_FOUND: 'The requested option is not available in this control.',
  WAIT_TIMEOUT: 'The page or control did not become ready in time. No waiting action was started.',
  OPERATION_FAILED: 'The control did not keep the requested state. Check the page before trying again.',
  RESULT_TOO_LARGE: 'The response exceeds its output budget. Ask your assistant to request a smaller, focused result.',
  SCRIPT_POLICY_BLOCKED: 'This page blocks JavaScript evaluation. Your assistant can use snapshots or targeted text instead.',
  SCRIPT_SYNTAX_ERROR: 'The supplied JavaScript is invalid. It must be an expression or script, not a function body.',
  SCRIPT_RUNTIME_ERROR: 'The supplied JavaScript failed on this page.',
  SCRIPT_SERIALIZATION_ERROR: 'The script result cannot be returned as JSON. Ask for plain JSON data.',
  SCRIPT_EXECUTION_UNAVAILABLE: 'The browser could not run page JavaScript. Snapshots and targeted text may still work.',
};

function showError(error) {
  byId('error').textContent = errors[error.message] || 'That did not work. Check your connection and try again.';
}

async function request(type, extra = {}) {
  const response = await api.runtime.sendMessage({ type: `ui.${type}`, ...extra });
  if (!response?.ok) throw new Error(response?.error?.code || 'BROWSER_OFFLINE');
  return response.value;
}

async function action(run) {
  if (busy) return;
  busy = true;
  byId('error').textContent = '';
  try {
    await run();
    lastRender = '';
    await refresh();
  } catch (error) {
    showError(error);
  } finally {
    busy = false;
  }
}

function button(parent, label, run) {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.addEventListener('click', () => action(run));
  parent.append(element);
}

function paragraph(parent, value) {
  const element = document.createElement('p');
  element.textContent = value;
  parent.append(element);
}

function render(snapshot) {
  const connected = snapshot.phase === 'authenticated';
  const active = snapshot.targets.filter(target => target.state === 'active');
  const name = snapshot.identity?.tenant_label || 'your assistant';
  let status = 'Connect your browser. No tabs are being shared.';
  if (active.length) status = `${active.map(target => target.client_label || name).join(', ')} can use your selected shared tabs.`;
  else if (connected) status = `You're connected to ${name}. No tabs are being shared.`;
  else if (['connecting', 'authenticating', 'proving'].includes(snapshot.phase)) {
    status = `Connecting to ${name}… No tabs are being shared.`;
  } else if (snapshot.enrollment) status = 'Finish connecting your browser. No tabs are being shared.';
  else if (snapshot.identity) status = 'Connection lost. No tabs are being shared.';
  byId('status').textContent = status;
  byId('identity').textContent = snapshot.config.service_origin
    ? new URL(snapshot.config.service_origin).host : 'Paste the link your assistant or administrator gave you.';
  byId('connect').disabled = !snapshot.identity || snapshot.phase !== 'disconnected';
  byId('disconnect').disabled = snapshot.phase === 'disconnected' && !snapshot.config.enabled;

  if (byId('config')) {
    if (!formLoaded) {
      byId('connection-link').value = snapshot.config.connection_url || '';
      byId('protected').value = snapshot.config.local_protected_origins.join('\n');
      formLoaded = true;
    }
    byId('config').hidden = Boolean(snapshot.identity && snapshot.config.enabled);
    byId('heading').textContent = connected ? 'Your browser is connected' : 'Connect your browser';
    byId('done').hidden = !connected;
    byId('enrollment').replaceChildren();
    if (snapshot.enrollment) {
      paragraph(byId('enrollment'), snapshot.enrollment.expires_at <= Date.now()
        ? 'The sign-in request expired. Start again to continue.'
        : 'Sign in on the website and choose Connect browser. This screen will finish automatically.');
      if (snapshot.enrollment.expires_at > Date.now()) {
        button(byId('enrollment'), 'Open sign-in again', () => request('openSignIn'));
      }
      button(byId('enrollment'), 'Start again', async () => {
        await request('enroll', { label: 'My browser' });
        await request('openSignIn');
      });
    }
    byId('protections').replaceChildren(...snapshot.protected_origins.map(origin => {
      const element = document.createElement('li');
      element.textContent = origin;
      return element;
    }));
  }

  byId('connections').replaceChildren();
  for (const pair of snapshot.saved_connections) {
    const article = document.createElement('article');
    paragraph(article, `${pair.label} · ${new URL(pair.origin).host}`);
    if (pair.connection_url !== snapshot.config.connection_url) {
      button(article, 'Switch connection', () => request('switch', { connection_url: pair.connection_url }));
    } else paragraph(article, 'Selected connection');
    byId('connections').append(article);
  }

  byId('requests').replaceChildren();
  if (!snapshot.pending.length) paragraph(byId('requests'), 'No sharing requests.');
  for (const pending of snapshot.pending) {
    const article = document.createElement('article');
    paragraph(article, `${pending.client_label} would like you to share a tab.`);
    paragraph(article, pending.description);
    paragraph(article, 'Agent explanation above is unverified; the tab and sharing scope below determine access.');
    paragraph(article, 'This name was supplied by the application. It is not a verified identity.');
    paragraph(article, 'Visit an existing or new website tab, then use the DomAgent toolbar to share that tab. You remain free to navigate and interact.');
    paragraph(article, 'Sharing allows page actions, including page scripts, only on your selected tab. Each action asks for approval unless you choose Allow all while sharing.');
    const selected = snapshot.selected_tab;
    paragraph(article, selected ? `Selected tab: ${selected.title || 'Untitled'} · ${selected.url}` : 'No website tab selected. Visit a website in a normal browser window first.');
    button(article, `Share this tab with ${pending.client_label}`, async () => {
      if (!selected) throw new Error('TARGET_STALE');
      // The permission call must remain directly inside the user's click, before
      // any messaging or asynchronous work loses browser user activation.
      const granted = await api.permissions.request({ origins: ['http://*/*', 'https://*/*'] });
      if (!granted) throw new Error('PERMISSION_REQUIRED');
      await request('approve', { request_id: pending.request_id, tabId: selected.tabId });
    });
    article.lastElementChild.disabled = !selected;
    button(article, 'Not now', () => request('deny', { request_id: pending.request_id }));
    byId('requests').append(article);
  }

  byId('targets').replaceChildren();
  if (!snapshot.targets.length) paragraph(byId('targets'), 'No shared tabs.');
  for (const target of snapshot.targets) {
    const article = document.createElement('article');
    paragraph(article, target.state === 'active'
      ? `${target.client_label || name} can use this tab.` : 'This tab is not being shared.');
    if (target.indicator_unavailable) {
      paragraph(article, 'This tab is still being shared, but its banner could not be displayed. You can stop sharing here.');
    }
    if (target.allow_all) paragraph(article, 'Allow all while sharing is on for ordinary actions in this tab only. Human assistance still requires Done.');
    for (const command of target.commands || []) {
      const pending = document.createElement('article');
      paragraph(pending, `${command.operation}: ${command.description}`);
      paragraph(pending, 'Agent explanation is unverified. Review the operation-derived details:');
      for (const line of command.summary || []) paragraph(pending, line);
      if (command.preparing) paragraph(pending, 'Inspecting the target before approval…');
      if (command.state === 'pending' && !command.preparing && command === target.commands[0]) {
        const decide = action => request('decision', {
          target_id: target.target_id, request_id: command.request_id, action,
        });
        if (command.operation === 'request_handoff') {
          paragraph(pending, 'Complete this task yourself in the shared tab. Done confirms completion without stopping sharing.');
          button(pending, 'Done', () => decide('done'));
          button(pending, 'Cancel', () => decide('decline'));
        } else {
          button(pending, 'Approve', () => decide('approve'));
          button(pending, 'Decline', () => decide('decline'));
          button(pending, 'Allow all while sharing', () => decide('allow_all'));
        }
      } else paragraph(pending, command.state === 'pending' ? 'Queued for review.' :
        command.state === 'executing' ? 'Action running…' : 'Approved; waiting for service…');
      article.append(pending);
    }
    button(article, 'View tab', () => request('inspectTab', { tabId: target.tabId }));
    if (target.target_id) {
      button(article, 'Stop sharing', () => request('end', { target_id: target.target_id, reason: 'OWNER_PAUSED' }));
    }
    byId('targets').append(article);
  }
  const failures = snapshot.failures.filter(code => code !== 'INDICATOR_UNAVAILABLE');
  if (failures.length) showError(new Error(failures.at(-1)));
  else byId('error').textContent = '';
}

async function refresh() {
  const snapshot = await request('state');
  const serialized = JSON.stringify(snapshot);
  if (serialized !== lastRender) {
    render(snapshot);
    lastRender = serialized;
  }
}

byId('config')?.addEventListener('submit', event => {
  event.preventDefault();
  void action(async () => {
    let pair;
    try { pair = parseConnectionUrl(byId('connection-link').value); } catch { throw new Error('INVALID_CONNECTION_LINK'); }
    const granted = await api.permissions.request({ origins: [`${pair.origin}/*`] });
    if (!granted) throw new Error('PERMISSION_REQUIRED');
    await request('configure', { config: { connection_url: pair.connection_url,
      local_protected_origins: byId('protected').value.split(/\s+/).filter(Boolean) } });
    const snapshot = await request('state');
    if (snapshot.identity) await request('connect');
    else {
      await request('enroll', { label: 'My browser' });
      await request('openSignIn');
    }
  });
});
byId('connect').addEventListener('click', () => action(() => request('connect')));
byId('disconnect').addEventListener('click', () => action(() => request('disconnect')));
byId('options')?.addEventListener('click', () => api.runtime.openOptionsPage().catch(showError));
byId('add-connection')?.addEventListener('click', () => {
  byId('config').hidden = false;
  byId('connection-link').focus();
});
byId('done')?.addEventListener('click', () => window.close());
refresh().catch(showError);
setInterval(() => { if (!busy) refresh().catch(showError); }, 250);
