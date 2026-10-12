import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  VERSION, tenantId, connectionUrl, extensionOrigin, keyId, startPayload,
  statusPayload, enrollmentPayload, verify,
} from '../shared/protocol.js';
import { token } from './store.js';
import { BridgeServer } from './server.js';
import { handleMcp } from './mcp.js';
import { Fault, requireValue, failureCode, audit } from './errors.js';

const COOKIE = '__Host-domagent_session';
const FLOW_COOKIE = '__Host-domagent_flow';
const SETUP_COOKIE = '__Host-domagent_setup';
const RELEASE = 'https://github.com/dtreskunov/domagent/releases/tag/v4.3.0-beta.1';
const secureCookie = (name, value, age) =>
  `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const escape = value => String(value).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fields = values => Object.entries(values).map(([key, value]) =>
  `<input type="hidden" name="${escape(key)}" value="${escape(value)}">`).join('');
const form = (action, csrf, values, content) =>
  `<form method="post" action="${action}">${fields({ csrf, ...values })}${content}</form>`;
const button = text => `<button type="submit">${text}</button>`;
const connectionField = url => `<input id="connection-link" readonly aria-label="Connection link" value="${escape(url)}">
  <button type="button" data-copy>Copy connection link</button><p id="copy-status" role="status"></p>
  <script src="/copy.js" defer></script>`;
const page = content => `<!doctype html><html lang="en"><meta charset="utf-8">
  <meta name="viewport" content="width=device-width"><title>DomAgent</title>
  <link rel="stylesheet" href="/style.css"><main><h1>DomAgent</h1>${content}</main></html>`;

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(part => {
    const index = part.indexOf('=');
    return [part.slice(0, index).trim(), part.slice(index + 1)];
  }));
}
async function body(req, limit = 262144) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    requireValue(size <= limit, 'PAYLOAD_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  requireValue(req.headers['content-type']?.startsWith('application/json'), 'CONTENT_TYPE_REQUIRED', 415);
  try { return JSON.parse(text); } catch { throw new Fault('INVALID_JSON'); }
}
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}
function html(res, value) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page(value));
}
function redirect(res, location, cookie) {
  res.writeHead(303, { Location: location, ...(cookie ? { 'Set-Cookie': cookie } : {}) });
  res.end();
}
const setupScript = `(() => {
  const token = new URLSearchParams(location.hash.slice(1)).get("token");
  history.replaceState(null, "", location.pathname);
  if (!token) { document.querySelector("#status").textContent = "This link is incomplete. Ask for a new one."; return; }
  const id = location.pathname.split("/").pop();
  fetch("/api/setup-requests/" + id + "/open", {
    method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({token})
  }).then(response => {
    if (!response.ok) throw new Error("This link has expired or is no longer available. Ask for a new one.");
    location.replace(location.pathname);
  }).catch(error => { document.querySelector("#status").textContent = error.message; });
})();`;
const copyScript = `document.querySelector("[data-copy]").addEventListener("click", async () => {
  const input = document.querySelector("#connection-link");
  const status = document.querySelector("#copy-status");
  try {
    await navigator.clipboard.writeText(input.value);
    status.textContent = "Copied. Paste it into the browser extension.";
  } catch {
    input.select();
    status.textContent = "Copy the selected link, then paste it into the browser extension.";
  }
});`;
const pageFailure = code => ({
  TENANT_ACCESS_REQUIRED: "You don't have access to this connection. Ask its owner.",
  OWNER_DISABLED: 'Your account has been disabled. Contact the server administrator.',
  ENROLLMENT_UNAVAILABLE: 'This connection request has expired or is no longer available. Start again in the extension.',
  SETUP_UNAVAILABLE: 'This link has expired or has already been used. Ask for a new one.',
  OIDC_LOGIN_FAILED: "We couldn't sign you in. Try again.",
  OIDC_STATE_INVALID: 'Your sign-in request expired. Start again.',
  CSRF_INVALID: 'This page is out of date. Reload it and try again.',
})[code] || "We couldn't complete this request. Try again or contact the administrator.";

export function createApp(store, config, oidc) {
  const bridge = new BridgeServer(store, config);
  const challenges = new Map();
  const flows = new Map();
  const setupFlows = new Map();
  const rates = new Map();
  const rateLimit = req => {
    const now = Date.now();
    const key = req.socket.remoteAddress;
    const value = rates.get(key);
    if (!value || now - value.since > 60_000) rates.set(key, { since: now, count: 1 });
    else requireValue(++value.count <= 600, 'RATE_LIMITED', 429);
    for (const [id, entry] of rates) if (now - entry.since > 60_000) rates.delete(id);
    for (const map of [challenges, flows, setupFlows]) {
      for (const [id, entry] of map) if (entry.expires < now) map.delete(id);
    }
  };
  const publicEnrollment = e => ({
    state: e.owner_id ? 'approved' : 'pending', enrollment_id: e.id, key_id: e.key_id,
    nonce: e.nonce, owner_id: e.owner_id, owner_label: e.owner_id ? store.owner(e.owner_id)?.label : undefined,
    extension_origin: e.extension_origin, protected_origins: config.protectedOrigins,
    tenant_id: e.tenant_id, tenant_label: store.tenant(e.tenant_id)?.label, expires_at: e.expires,
  });
  const setupFlow = (req, id) => {
    const flow = setupFlows.get(cookies(req)[SETUP_COOKIE]);
    return flow?.id === id && flow.expires > Date.now() ? flow : undefined;
  };
  const server = createServer((req, res) => {
    route(req, res).catch(error => {
      audit('http_failure', { code: failureCode(error) });
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof Fault ? error.status : 500;
      if (/^\/(connect|pair|dashboard|join|login|oidc)(?:\/|\?|$)/.test(req.url || '')) {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page(`<h2>Unable to continue</h2><p>${escape(pageFailure(failureCode(error)))}</p>`));
      } else json(res, status, { error: failureCode(error) });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.on('upgrade', (req, socket, head) => {
    try { rateLimit(req); bridge.upgrade(req, socket, head); }
    catch (error) {
      audit('ws_rejected', { code: failureCode(error) });
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
    }
  });

  async function route(req, res) {
    rateLimit(req);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy',
      "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    const url = new URL(req.url, config.origin);
    const path = url.pathname;
    const method = req.method;
    const sourceOrigin = req.headers.origin;
    if (path === '/mcp' || path === '/extension' || path.startsWith('/api/enrollment')) {
      throw new Fault('TENANT_UPGRADE_REQUIRED', 410);
    }
    if (path === '/.well-known/domagent' && method === 'GET') {
      json(res, 200, { service: 'domagent', protocol_version: VERSION, setup_requests: '/api/setup-requests' });
      return;
    }
    if (path === '/api/setup-requests' && method === 'POST') {
      requireValue(!sourceOrigin, 'NOT_AUTHORIZED', 403);
      const data = await body(req, 4096);
      const request = store.createSetup(data?.agent_name, data?.request_description);
      json(res, 201, {
        request_id: request.id, verification_url: `${config.origin}/connect/${request.id}#token=${request.token}`,
        status_receipt: request.receipt, expires_at: request.expires,
      });
      return;
    }
    const setupApi = /^\/api\/setup-requests\/([0-9a-f-]{36})\/(open|status)$/.exec(path);
    if (setupApi && method === 'POST') {
      const [, id, action] = setupApi;
      const data = await body(req, 2048);
      if (action === 'status') {
        requireValue(!sourceOrigin, 'NOT_AUTHORIZED', 403);
        requireValue(typeof data?.status_receipt === 'string', 'SETUP_UNAVAILABLE', 404);
        const request = store.setupWithReceipt(id, data.status_receipt);
        requireValue(request, 'SETUP_UNAVAILABLE', 404);
        json(res, 200, { state: request.state, tenant_id: request.tenant_id, expires_at: request.expires,
          ...(request.tenant_id ? { connection_url: connectionUrl(config.origin, request.tenant_id),
            mcp_url: `${config.origin}/mcp/${request.tenant_id}` } : {}) });
      } else {
        requireValue(sourceOrigin === config.origin && typeof data?.token === 'string', 'NOT_AUTHORIZED', 403);
        const request = store.setupWithToken(id, data.token);
        requireValue(request?.state === 'pending', 'SETUP_UNAVAILABLE', 404);
        requireValue(setupFlows.size < 1000, 'RATE_LIMITED', 429);
        const cookie = token();
        setupFlows.set(cookie, { id, token: data.token, expires: request.expires });
        res.setHeader('Set-Cookie', secureCookie(SETUP_COOKIE, cookie, Math.ceil((request.expires - Date.now()) / 1000)));
        json(res, 200, { state: 'ready' });
      }
      return;
    }
    const enrollmentApi = /^\/api\/tenants\/(t_[A-Za-z0-9_-]{22})\/enrollment\/(challenge|start|status|confirm)$/.exec(path);
    if (enrollmentApi) {
      const [, tenant, action] = enrollmentApi;
      requireValue(store.tenant(tenant), 'TENANT_UNAVAILABLE', 404);
      if (sourceOrigin) {
        try { extensionOrigin(sourceOrigin); } catch { throw new Fault('NOT_AUTHORIZED', 403); }
        res.setHeader('Access-Control-Allow-Origin', sourceOrigin);
        res.setHeader('Vary', 'Origin');
      }
      if (method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type' });
        res.end();
        return;
      }
      if (action === 'challenge' && method === 'GET') {
        requireValue(challenges.size < 1000, 'RATE_LIMITED', 429);
        const nonce = token();
        challenges.set(nonce, { expires: Date.now() + 60_000, origin: sourceOrigin, tenant_id: tenant });
        json(res, 200, { nonce, origin: config.origin, tenant_id: tenant });
        return;
      }
      requireValue(method === 'POST', 'METHOD_NOT_ALLOWED', 405);
      const data = await body(req, 8192);
      requireValue(data && typeof data === 'object' && !Array.isArray(data) && data.tenant_id === tenant, 'INVALID_ARGUMENTS');
      if (action === 'start') {
        const challenge = challenges.get(data.nonce);
        challenges.delete(data.nonce);
        requireValue(challenge && challenge.expires > Date.now() && challenge.tenant_id === tenant &&
          (!challenge.origin || challenge.origin === sourceOrigin), 'CHALLENGE_UNAVAILABLE');
        const extension = extensionOrigin(data.extension_origin);
        requireValue(!sourceOrigin || extension === sourceOrigin, 'NOT_AUTHORIZED', 403);
        requireValue(typeof data.label === 'string' && data.label.trim() && data.label.length <= 80 &&
          await keyId(data.public_key) === data.key_id, 'INVALID_PUBLIC_KEY');
        requireValue(await verify(data.public_key, startPayload({ ...data, origin: config.origin }), data.signature), 'NOT_AUTHORIZED', 403);
        const { kty, crv, x, y } = data.public_key;
        const e = { ...data, public_key: { kty, crv, x, y }, id: randomUUID(), nonce: token(), expires: Date.now() + 300_000 };
        store.enrollmentStart(e);
        json(res, 201, { enrollment_id: e.id, tenant_id: tenant,
          verification_url: `${config.origin}/pair/${tenant}?enrollment=${e.id}`, expires_at: e.expires });
        return;
      }
      const e = store.enrollment(data.enrollment_id, tenant);
      requireValue(e && (!sourceOrigin || e.extension_origin === sourceOrigin), 'ENROLLMENT_UNAVAILABLE', 404);
      requireValue(action === 'status' || e.owner_id, 'ENROLLMENT_UNAVAILABLE', 404);
      const payload = action === 'status'
        ? statusPayload({ origin: config.origin, tenant_id: tenant, enrollment_id: e.id })
        : enrollmentPayload({ ...publicEnrollment(e), origin: config.origin });
      requireValue(await verify(JSON.parse(e.public_key), payload, data.signature), 'NOT_AUTHORIZED', 403);
      if (action === 'status') json(res, 200, publicEnrollment(e));
      else {
        requireValue(action === 'confirm' && e.owner_id, 'ENROLLMENT_UNAVAILABLE', 404);
        const d = store.confirmEnrollment(e.id, tenant);
        audit('device_enrolled', { tenant_id: tenant, device_id: d.id, owner_id: d.owner_id });
        json(res, 201, { device_id: d.id, key_id: d.key_id, tenant_id: tenant,
          tenant_label: store.tenant(tenant).label, owner_id: d.owner_id,
          owner_label: store.owner(d.owner_id).label, protected_origins: config.protectedOrigins });
      }
      return;
    }
    const mcp = /^\/mcp\/(t_[A-Za-z0-9_-]{22})$/.exec(path);
    if (mcp) {
      requireValue(!sourceOrigin, 'NOT_AUTHORIZED', 403);
      const credential = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(req.headers.authorization || '')?.[1];
      const client = credential && store.authenticateClient(credential, mcp[1]);
      if (!client) res.setHeader('WWW-Authenticate', 'Bearer realm="domagent"');
      requireValue(client, 'NOT_AUTHORIZED', 401);
      requireValue(method === 'POST', 'METHOD_NOT_ALLOWED', 405);
      res.setHeader('X-Accel-Buffering', 'no');
      await handleMcp(req, res, await body(req), client, bridge);
      return;
    }
    if ((path === '/' || path === '/health') && ['GET', 'HEAD'].includes(method)) {
      json(res, 200, { service: 'domagent', status: 'ok', version: '4.3.0-beta.1', protocol_version: VERSION });
      return;
    }
    if (path === '/style.css' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end('body{font:16px system-ui;line-height:1.5;background:#f6f7f9;color:#20232a}main{max-width:760px;margin:3rem auto;padding:1rem}input,button,select{font:inherit;padding:.5rem;margin:.3rem}form{margin:1rem 0}code{overflow-wrap:anywhere}section{border-top:1px solid #ccc;padding:1rem 0}');
      return;
    }
    if (path === '/setup.js' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' }); res.end(setupScript); return;
    }
    if (path === '/copy.js' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' }); res.end(copyScript); return;
    }
    if (path === '/login' && method === 'GET') {
      requireValue(flows.size < 1000, 'RATE_LIMITED', 429);
      let next = '/dashboard';
      const setup = url.searchParams.get('setup');
      const enrollment = url.searchParams.get('enrollment');
      const tenant = url.searchParams.get('tenantId');
      if (setup && setupFlow(req, setup)) next = `/connect/${setup}`;
      else if (enrollment && /^[0-9a-f-]{36}$/.test(enrollment) && tenant) {
        try { tenantId(tenant); } catch { throw new Fault('INVALID_TENANT'); }
        next = `/pair/${tenant}?enrollment=${enrollment}`;
      }
      const state = token();
      const flow = { state, nonce: token(), verifier: token(), expires: Date.now() + 600_000, next };
      flows.set(state, flow);
      redirect(res, await oidc.start(flow), secureCookie(FLOW_COOKIE, state, 600));
      return;
    }
    if (path === '/oidc/callback' && method === 'GET') {
      const state = url.searchParams.get('state');
      const flow = flows.get(state);
      flows.delete(state);
      requireValue(flow && flow.expires > Date.now() && equal(cookies(req)[FLOW_COOKIE], state), 'OIDC_STATE_INVALID', 403);
      let identity;
      try { identity = await oidc.finish(url, flow); } catch { throw new Fault('OIDC_LOGIN_FAILED', 403); }
      requireValue(identity.issuer === config.issuer, 'OIDC_IDENTITY_INVALID', 403);
      const owner = store.admit(identity.issuer, identity.subject, identity.label);
      const session = store.createSession(owner.id);
      res.setHeader('Set-Cookie', [secureCookie(FLOW_COOKIE, '', 0), secureCookie(COOKIE, session.token, 28800)]);
      audit('owner_login', { owner_id: owner.id });
      redirect(res, flow.next);
      return;
    }
    const session = store.session(cookies(req)[COOKIE] || '');
    const requirePost = async () => {
      requireValue(session && sourceOrigin === config.origin, 'NOT_AUTHORIZED', 403);
      const data = await body(req, 16384);
      requireValue(data && equal(data.csrf, session.csrf), 'CSRF_INVALID', 403);
      return data;
    };
    const connect = /^\/connect\/([0-9a-f-]{36})(\/approve|\/deny)?$/.exec(path);
    if (connect) {
      const [, id, action] = connect;
      const flow = setupFlow(req, id);
      if (method === 'GET' && !action && !flow) {
        html(res, '<p id="status">Opening your connection request...</p><script src="/setup.js" defer></script>');
        return;
      }
      requireValue(flow, 'SETUP_UNAVAILABLE', 404);
      const request = store.setupWithToken(id, flow.token);
      requireValue(request?.state === 'pending', 'SETUP_UNAVAILABLE', 404);
      if (!session && method === 'GET') { redirect(res, `/login?setup=${id}`); return; }
      requireValue(session, 'NOT_AUTHORIZED', 401);
      if (method === 'GET' && !action) {
        html(res, `<h2>${escape(request.agent_name)} wants to connect to your browser</h2>
          <p>${escape(request.request_description)}</p><p>This name and explanation were supplied by the application.</p>
          <p>You're signed in as ${escape(session.label)} on ${escape(new URL(config.origin).host)}.</p>
          <p>Your assistant can ask you to share a tab. You decide each time. Setting up shares no tabs.</p>` +
          form(`/connect/${id}/approve`, session.csrf, {}, button('Set up connection')) +
          form(`/connect/${id}/deny`, session.csrf, {}, button('Not now')));
      } else {
        requireValue(method === 'POST' && action, 'METHOD_NOT_ALLOWED', 405);
        await requirePost();
        setupFlows.delete(cookies(req)[SETUP_COOKIE]);
        res.setHeader('Set-Cookie', secureCookie(SETUP_COOKIE, '', 0));
        if (action === '/deny') {
          store.denySetup(id, flow.token, session.owner_id);
          html(res, '<p>Connection request declined.</p>');
        } else {
          const created = store.approveSetup(id, flow.token, session.owner_id);
          html(res, `<h2>Connection ready</h2><p>Install the browser extension and paste this connection link:</p>
            ${connectionField(connectionUrl(config.origin, created.tenant.id))}
            <p><a href="${RELEASE}">Download the browser extension ZIP</a></p>
            <details><summary>Application connection settings</summary>
            <p>Configure your application using its own secure credential-management instructions. Do not paste credentials into chat.</p>
            <p>MCP endpoint: <code>${escape(`${config.origin}/mcp/${created.tenant.id}`)}</code></p>
            <p>Credential (shown once): <code>${escape(created.client.credential)}</code></p></details>
            <p><a href="/dashboard/tenants/${created.tenant.id}">Manage this connection</a></p>`);
        }
      }
      return;
    }
    const join = /^\/join\/(t_[A-Za-z0-9_-]{22})\/?$/.exec(path);
    if (join && method === 'GET') {
      html(res, `<h2>Connect your browser</h2><p>Download and extract your browser's ZIP.
        For Firefox, open about:debugging and load its manifest as a temporary add-on.
        For Chrome, use Load unpacked in chrome://extensions. Temporary Firefox installs are removed on restart.</p>
        <p><a href="${RELEASE}">Download extension</a></p><p>Paste this into the extension's Connection link field:</p>
        ${connectionField(connectionUrl(config.origin, join[1]))}`);
      return;
    }
    const pair = /^\/pair\/(t_[A-Za-z0-9_-]{22})(\/approve)?$/.exec(path);
    if (pair) {
      const [, tenant, action] = pair;
      const enrollment = action ? (await requirePost()).enrollment_id : url.searchParams.get('enrollment');
      if (!session && method === 'GET' && !action) {
        requireValue(enrollment && /^[0-9a-f-]{36}$/.test(enrollment), 'ENROLLMENT_UNAVAILABLE', 404);
        redirect(res, `/login?tenantId=${tenant}&enrollment=${enrollment}`); return;
      }
      requireValue(session && store.member(session.owner_id, tenant), 'TENANT_ACCESS_REQUIRED', 403);
      const e = store.enrollment(enrollment, tenant);
      requireValue(e && (!e.owner_id || e.owner_id === session.owner_id), 'ENROLLMENT_UNAVAILABLE', 404);
      if (method === 'GET' && !action) {
        html(res, `<h2>Connect this browser to ${escape(store.tenant(tenant).label)}?</h2>
          <p>You're signed in as ${escape(session.label)}.</p><p>You decide which tabs to share and when.</p>` +
          form(`/pair/${tenant}/approve`, session.csrf, { enrollment_id: e.id }, button('Connect browser')));
      } else {
        requireValue(method === 'POST' && action, 'METHOD_NOT_ALLOWED', 405);
        store.approveEnrollment(e.id, session.owner_id, tenant);
        html(res, '<h2>Approved</h2><p>Your extension will finish connecting automatically. No tabs are being shared.</p>');
      }
      return;
    }
    if (path === '/dashboard' && method === 'GET') {
      if (!session) { redirect(res, '/login'); return; }
      html(res, `<p>Signed in as ${escape(session.label)}.</p><h2>Your connections</h2>` +
        store.tenantsForOwner(session.owner_id).map(t =>
          `<p><a href="/dashboard/tenants/${t.id}">${escape(t.label)}</a></p>`).join('') +
        form('/dashboard/logout', session.csrf, {}, button('Sign out')));
      return;
    }
    if (path === '/dashboard/logout' && method === 'POST') {
      await requirePost(); store.logout(cookies(req)[COOKIE]); redirect(res, '/login', secureCookie(COOKIE, '', 0)); return;
    }
    const dashboard = /^\/dashboard\/tenants\/(t_[A-Za-z0-9_-]{22})(?:\/(rotate|revoke-client|revoke-device|add-member|remove-member|disable))?$/.exec(path);
    if (dashboard) {
      const [, tenant, action] = dashboard;
      requireValue(session && store.member(session.owner_id, tenant), 'TENANT_ACCESS_REQUIRED', 403);
      if (method === 'GET' && !action) {
        const owned = store.owns(session.owner_id, tenant);
        const client = owned && store.clientsForOwner(session.owner_id, tenant)[0];
        html(res, `<h2>${escape(store.tenant(tenant).label)}</h2><p>Connection link:</p>
          <input readonly value="${escape(connectionUrl(config.origin, tenant))}"><p>No tabs are shared without local approval.</p>` +
          (client ? form(`/dashboard/tenants/${tenant}/rotate`, session.csrf, { client_id: client.id }, button('Replace application credential')) +
            form(`/dashboard/tenants/${tenant}/revoke-client`, session.csrf, { client_id: client.id }, button('Revoke application access')) : '') +
          store.devicesForOwner(session.owner_id, tenant).map(d => `<p>${escape(d.label)}</p>` +
            form(`/dashboard/tenants/${tenant}/revoke-device`, session.csrf, { device_id: d.id }, button('Disconnect browser'))).join('') +
          (owned ? '<details><summary>Connection administration</summary>' +
            form(`/dashboard/tenants/${tenant}/add-member`, session.csrf, {},
              '<label>Account ID <input name="owner_id" required></label>' + button('Allow account to connect')) +
            form(`/dashboard/tenants/${tenant}/remove-member`, session.csrf, {},
              '<label>Account ID <input name="owner_id" required></label>' + button('Remove account access')) +
            form(`/dashboard/tenants/${tenant}/disable`, session.csrf, {}, button('Disable connection')) + '</details>' : '') +
          '<p><a href="/dashboard">All connections</a></p>');
      } else {
        requireValue(method === 'POST' && action, 'METHOD_NOT_ALLOWED', 405);
        const data = await requirePost();
        if (action === 'rotate') {
          const client = store.rotateClient(session.owner_id, data.client_id, tenant);
          for (const [id, grant] of bridge.grants) if (grant.client_id === client.id) bridge.endGrant(id, 'REVOKED');
          bridge.reconcile();
          html(res, `<h2>Credential shown once</h2><p>Use your application's secure configuration workflow.</p>
            <code>${escape(client.credential)}</code><p><a href="/dashboard/tenants/${tenant}">Back</a></p>`);
        } else {
          if (action === 'add-member') store.addMember(session.owner_id, tenant, data.owner_id);
          else if (action === 'remove-member') store.removeMember(session.owner_id, tenant, data.owner_id);
          else if (action === 'disable') store.disableTenant(session.owner_id, tenant);
          else store.revoke(session.owner_id, action === 'revoke-client' ? 'client' : 'device',
            action === 'revoke-client' ? data.client_id : data.device_id, tenant);
          bridge.reconcile();
          redirect(res, '/dashboard');
        }
      }
      return;
    }
    throw new Fault('NOT_FOUND', 404);
  }
  return {
    server, bridge,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.bind, () => { server.off('error', reject); resolve(server.address()); });
    }),
    close: async () => {
      bridge.close(); server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
