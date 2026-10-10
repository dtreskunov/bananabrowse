import { serviceOrigin } from '../../shared/protocol.js';

const api = typeof browser === 'undefined' ? chrome : browser;
const byId = id => document.getElementById(id);
let busy = false;
let formLoaded = false;
let lastRender = '';

function showError(error) {
  byId('error').textContent = error.message || 'OUTCOME_UNKNOWN';
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
  byId('status').textContent = `Service: ${snapshot.config.service_origin || 'not configured'} · ${snapshot.phase}`;
  byId('identity').textContent = snapshot.identity
    ? `Owner: ${snapshot.identity.owner_label} · ID: ${snapshot.identity.owner_id} · Device: ${snapshot.identity.device_id}`
    : `Not enrolled. Key: ${snapshot.key_id || 'not generated'}`;
  byId('connect').disabled = !snapshot.identity || snapshot.phase !== 'disconnected';
  byId('disconnect').disabled = snapshot.phase === 'disconnected' && !snapshot.config.enabled;
  if (byId('config')) {
    if (!formLoaded) {
      byId('origin').value = snapshot.config.service_origin;
      byId('protected').value = snapshot.config.local_protected_origins.join('\n');
      formLoaded = true;
    }
    byId('protections').replaceChildren(...snapshot.protected_origins.map(origin => {
      const element = document.createElement('li');
      element.textContent = origin;
      return element;
    }));
    byId('enroll').disabled = !snapshot.config.service_origin || snapshot.phase !== 'disconnected';
    byId('check-enrollment').disabled = !snapshot.enrollment;
    byId('confirm-enrollment').disabled = snapshot.enrollment?.state !== 'approved';
    byId('enrollment').replaceChildren();
    if (snapshot.enrollment) {
      paragraph(byId('enrollment'), `Enrollment: ${snapshot.enrollment.state} · Expires: ${new Date(snapshot.enrollment.expires_at).toLocaleString()}`);
      const link = document.createElement('a');
      link.href = snapshot.enrollment.verification_url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Open this service’s owner dashboard to verify enrollment';
      byId('enrollment').append(link);
      if (snapshot.enrollment.state === 'approved') {
        paragraph(byId('enrollment'), `Verify before local confirmation: owner ${snapshot.enrollment.owner_label} · owner ID ${snapshot.enrollment.owner_id} · key ${snapshot.enrollment.key_id}`);
      }
    }
  }
  byId('requests').replaceChildren();
  if (!snapshot.pending.length) paragraph(byId('requests'), 'No pending approvals.');
  for (const pending of snapshot.pending) {
    const article = document.createElement('article');
    paragraph(article, `Client ID: ${pending.client_id}`);
    paragraph(article, `Untrusted client label: ${pending.client_label}`);
    paragraph(article, `Policy: ${pending.policy_id} · Expires: ${new Date(pending.expires_at).toLocaleString()}`);
    const selections = [];
    for (const capability of snapshot.capabilities) {
      const label = document.createElement('label');
      label.className = 'capability';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = capability !== 'evaluate_script';
      selections.push({ input, capability });
      label.append(input, document.createTextNode(` ${capability}`));
      article.append(label);
    }
    button(article, 'Approve new dedicated-tab control', async () => {
      const capabilities = selections.filter(selection => selection.input.checked).map(selection => selection.capability);
      if (!capabilities.length) throw new Error('Select at least one page capability.');
      // Call permissions.request directly within the trusted user click gesture.
      const granted = await api.permissions.request({ origins: ['http://*/*', 'https://*/*'] });
      if (!granted) throw new Error('PERMISSION_REQUIRED');
      await request('approve', { request_id: pending.request_id, capabilities });
    });
    button(article, 'Reject', () => request('deny', { request_id: pending.request_id }));
    byId('requests').append(article);
  }
  byId('targets').replaceChildren();
  if (!snapshot.targets.length) paragraph(byId('targets'), 'No dedicated tabs.');
  for (const target of snapshot.targets) {
    const article = document.createElement('article');
    paragraph(article, `Client ID: ${target.client_id} · ${target.state}`);
    button(article, 'Inspect tab', () => request('inspectTab', { tabId: target.tabId }));
    if (target.target_id) {
      button(article, 'Pause', () => request('end', { target_id: target.target_id, reason: 'OWNER_PAUSED' }));
      button(article, 'Human handoff', () => request('end', { target_id: target.target_id, reason: 'HANDOFF' }));
      button(article, 'Revoke', () => request('end', { target_id: target.target_id, reason: 'REVOKED' }));
    } else {
      button(article, 'Request fresh approval (not resume)', () => request('resume', { client_id: target.client_id }));
    }
    byId('targets').append(article);
  }
  if (snapshot.failures.length) byId('error').textContent = `Recent failures: ${snapshot.failures.join(', ')}`;
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
    const origin = serviceOrigin(byId('origin').value.trim());
    const granted = await api.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) throw new Error('PERMISSION_REQUIRED');
    await request('configure', { config: { service_origin: origin,
      local_protected_origins: byId('protected').value.split(/\s+/).filter(Boolean) } });
  });
});
byId('enroll')?.addEventListener('click', () => action(() => request('enroll', { label: byId('label').value })));
byId('check-enrollment')?.addEventListener('click', () => action(() => request('enrollmentStatus')));
byId('confirm-enrollment')?.addEventListener('click', () => action(() => request('confirmEnrollment')));
byId('connect').addEventListener('click', () => action(() => request('connect')));
byId('disconnect').addEventListener('click', () => action(() => request('disconnect')));
byId('options')?.addEventListener('click', () => api.runtime.openOptionsPage().catch(showError));
refresh().catch(showError);
setInterval(() => {
  if (!busy) refresh().catch(showError);
}, 1500);
