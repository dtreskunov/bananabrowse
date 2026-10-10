import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  extensionOrigin, keyId, startPayload, statusPayload, enrollmentPayload, verify,
} from '../shared/protocol.js';
import { token } from './store.js';
import { BridgeServer } from './server.js';
import { handleMcp } from './mcp.js';
import { Fault, requireValue, failureCode, audit } from './errors.js';

const COOKIE = '__Host-domagent_session';
const FLOW_COOKIE = '__Host-domagent_flow';
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
const page = body => `<!doctype html><html lang="en"><meta charset="utf-8">
  <meta name="viewport" content="width=device-width"><title>DomAgent</title>
  <link rel="stylesheet" href="/style.css"><main><h1>DomAgent</h1>${body}</main></html>`;

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
  try { return JSON.parse(text); }
  catch { throw new Fault('INVALID_JSON'); }
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

export function createApp(store, config, oidc) {
  const bridge = new BridgeServer(store, config);
  const challenges = new Map();
  const flows = new Map();
  const rates = new Map();
  const rateLimit = req => {
    const now = Date.now();
    const key = req.socket.remoteAddress;
    const value = rates.get(key);
    if (!value || now - value.since > 60_000) rates.set(key, { since: now, count: 1 });
    else requireValue(++value.count <= 600, 'RATE_LIMITED', 429);
    for (const [id, entry] of rates) if (now - entry.since > 60_000) rates.delete(id);
    for (const [id, entry] of challenges) if (entry.expires < now) challenges.delete(id);
    for (const [id, entry] of flows) if (entry.expires < now) flows.delete(id);
  };
  const publicEnrollment = e => ({
    state: e.owner_id ? 'approved' : 'pending', enrollment_id: e.id, key_id: e.key_id,
    nonce: e.nonce, owner_id: e.owner_id,
    owner_label: e.owner_id ? store.owner(e.owner_id)?.label : undefined,
    extension_origin: e.extension_origin, protected_origins: config.protectedOrigins,
    expires_at: e.expires,
  });
  const server = createServer((req, res) => {
    route(req, res).catch(error => {
      audit('http_failure', { code: failureCode(error) });
      if (!res.headersSent) json(res, error instanceof Fault ? error.status : 500, { error: failureCode(error) });
      else res.destroy();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.on('upgrade', (req, socket, head) => {
    try {
      rateLimit(req);
      bridge.upgrade(req, socket, head);
    } catch (error) {
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
      "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    const url = new URL(req.url, config.origin);
    const path = url.pathname;
    const method = req.method;
    const sourceOrigin = req.headers.origin;
    if (path.startsWith('/api/enrollment')) {
      if (sourceOrigin) {
        try { extensionOrigin(sourceOrigin); }
        catch { throw new Fault('NOT_AUTHORIZED', 403); }
        res.setHeader('Access-Control-Allow-Origin', sourceOrigin);
        res.setHeader('Vary', 'Origin');
      }
      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET, POST',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
      }
      if (path === '/api/enrollment/challenge' && method === 'GET') {
        requireValue(challenges.size < 1000, 'RATE_LIMITED', 429);
        const nonce = token();
        challenges.set(nonce, { expires: Date.now() + 60_000, origin: sourceOrigin });
        json(res, 200, { nonce, origin: config.origin });
        return;
      }
      requireValue(method === 'POST', 'METHOD_NOT_ALLOWED', 405);
      const data = await body(req, 8192);
      requireValue(data && typeof data === 'object' && !Array.isArray(data), 'INVALID_ARGUMENTS');
      if (path === '/api/enrollment/start') {
        const challenge = challenges.get(data.nonce);
        challenges.delete(data.nonce);
        requireValue(challenge && challenge.expires > Date.now() &&
          (!challenge.origin || challenge.origin === sourceOrigin), 'CHALLENGE_UNAVAILABLE');
        const origin = extensionOrigin(data.extension_origin);
        requireValue(!sourceOrigin || origin === sourceOrigin, 'NOT_AUTHORIZED', 403);
        requireValue(typeof data.label === 'string' && data.label.trim() &&
          data.label.length <= 80 && await keyId(data.public_key) === data.key_id, 'INVALID_PUBLIC_KEY');
        requireValue(await verify(data.public_key, startPayload({ ...data, origin: config.origin }), data.signature),
          'NOT_AUTHORIZED', 403);
        const { kty, crv, x, y } = data.public_key;
        const e = {
          ...data, public_key: { kty, crv, x, y },
          id: randomUUID(), nonce: token(), expires: Date.now() + 300_000,
        };
        store.enrollmentStart(e);
        json(res, 201, {
          enrollment_id: e.id, verification_url: `${config.origin}/dashboard?enrollment=${e.id}`,
          expires_at: e.expires,
        });
        return;
      }
      const e = store.enrollment(data.enrollment_id);
      requireValue(e && (!sourceOrigin || e.extension_origin === sourceOrigin),
        'ENROLLMENT_UNAVAILABLE', 404);
      if (path === '/api/enrollment/status') {
        requireValue(await verify(JSON.parse(e.public_key), statusPayload({
          origin: config.origin, enrollment_id: e.id,
        }), data.signature), 'NOT_AUTHORIZED', 403);
        json(res, 200, publicEnrollment(e));
        return;
      }
      requireValue(path === '/api/enrollment/confirm' && e.owner_id && store.owner(e.owner_id),
        'ENROLLMENT_UNAVAILABLE', 404);
      requireValue(await verify(JSON.parse(e.public_key), enrollmentPayload({
        ...publicEnrollment(e), origin: config.origin,
      }), data.signature), 'NOT_AUTHORIZED', 403);
      const d = store.confirmEnrollment(e.id);
      audit('device_enrolled', { owner_id: d.owner_id, device_id: d.id });
      json(res, 201, {
        device_id: d.id, key_id: d.key_id, owner_id: d.owner_id,
        owner_label: store.owner(d.owner_id).label, protected_origins: config.protectedOrigins,
      });
      return;
    }
    if (path === '/mcp') {
      requireValue(!sourceOrigin, 'NOT_AUTHORIZED', 403);
      const authorization = req.headers.authorization || '';
      const credential = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization)?.[1];
      const client = credential && store.authenticateClient(credential);
      requireValue(client, 'NOT_AUTHORIZED', 401);
      requireValue(method === 'POST', 'METHOD_NOT_ALLOWED', 405);
      const data = await body(req);
      await handleMcp(req, res, data, client, bridge);
      return;
    }
    if ((path === '/' || path === '/health') && (method === 'GET' || method === 'HEAD')) {
      json(res, 200, { service: 'domagent', status: 'ok' });
      return;
    }
    if (path === '/style.css' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end('body{font:16px system-ui;line-height:1.5;background:#f6f7f9;color:#20232a}main{max-width:850px;margin:3rem auto;padding:1rem}input,button,select{font:inherit;padding:.5rem;margin:.3rem}form{margin:1rem 0}code{overflow-wrap:anywhere}section{border-top:1px solid #ccc;padding:1rem 0}');
      return;
    }
    if (path === '/login' && method === 'GET') {
      requireValue(flows.size < 1000, 'RATE_LIMITED', 429);
      const state = token();
      const enrollment = url.searchParams.get('enrollment');
      const next = enrollment && /^[0-9a-f-]{36}$/.test(enrollment)
        ? `/dashboard?enrollment=${enrollment}` : '/dashboard';
      const flow = { state, nonce: token(), verifier: token(), expires: Date.now() + 600_000, next };
      flows.set(state, flow);
      redirect(res, await oidc.start(flow), secureCookie(FLOW_COOKIE, state, 600));
      return;
    }
    if (path === '/oidc/callback' && method === 'GET') {
      const state = url.searchParams.get('state');
      const flow = flows.get(state);
      flows.delete(state);
      requireValue(flow && flow.expires > Date.now() && equal(cookies(req)[FLOW_COOKIE], state),
        'OIDC_STATE_INVALID', 403);
      let identity;
      try { identity = await oidc.finish(url, flow); }
      catch { throw new Fault('OIDC_LOGIN_FAILED', 403); }
      const owner = store.admit(identity.issuer, identity.subject);
      const session = store.createSession(owner.id);
      res.setHeader('Set-Cookie', [
        secureCookie(FLOW_COOKIE, '', 0), secureCookie(COOKIE, session.token, 28800),
      ]);
      audit('owner_login', { owner_id: owner.id });
      redirect(res, flow.next);
      return;
    }
    const cookie = cookies(req)[COOKIE] || '';
    const session = store.session(cookie);
    if (path === '/dashboard' && method === 'GET') {
      if (!session) {
        const enrollment = url.searchParams.get('enrollment');
        redirect(res, enrollment ? `/login?enrollment=${encodeURIComponent(enrollment)}` : '/login');
        return;
      }
      const devices = store.devicesForOwner(session.owner_id);
      const clients = store.clientsForOwner(session.owner_id);
      let content = `<p>Signed in as <strong>${escape(session.label)}</strong>.
        Device linking only permits requests. Control always requires local extension approval.</p>`;
      const enrollment = url.searchParams.get('enrollment');
      if (enrollment) {
        const e = store.enrollment(enrollment);
        requireValue(e && (!e.owner_id || e.owner_id === session.owner_id), 'ENROLLMENT_UNAVAILABLE', 404);
        content += `<section><h2>Enroll device</h2><p>Device: ${escape(e.label)}</p>
          <p>Reference: <code>${escape(e.id)}</code></p>
          <p>Key: <code>${escape(e.key_id)}</code></p>
          <p>Confirm only if this matches the enrollment you started in your extension.
          Final confirmation happens locally in that extension.</p>` +
          form('/dashboard/approve-enrollment', session.csrf, { enrollment_id: e.id }, button('Approve this enrollment')) +
          '</section>';
      }
      content += `<section><h2>Register an MCP client</h2>` +
        form('/dashboard/create-client', session.csrf, {},
          '<label>Client label <input name="label" required maxlength="80"></label>' + button('Create client credential')) +
        '</section><section><h2>Clients</h2>';
      for (const c of clients) {
        content += `<p>${escape(c.label)} <code>${escape(c.id)}</code></p>` +
          form('/dashboard/revoke-client', session.csrf, { client_id: c.id }, button('Revoke client')) +
          form('/dashboard/rotate-client', session.csrf, { client_id: c.id }, button('Rotate credential and end grants'));
      }
      content += '</section><section><h2>Devices</h2>';
      for (const d of devices) {
        content += `<p>${escape(d.label)} <code>${escape(d.id)}</code></p>` +
          form('/dashboard/revoke-device', session.csrf, { device_id: d.id }, button('Revoke device'));
      }
      content += '</section><section><h2>Link a client and device</h2>';
      if (devices.length && clients.length) {
        const select = (name, entries) => `<select name="${name}">` + entries.map(e =>
          `<option value="${escape(e.id)}">${escape(e.label)} (${escape(e.id)})</option>`).join('') + '</select>';
        content += form('/dashboard/link', session.csrf, {},
          select('client_id', clients) + select('device_id', devices) + button('Allow requests'));
      } else content += '<p>Enroll a device and create a client first.</p>';
      if (devices.length) {
        content += '<h3>Approve another owner\'s known MCP client</h3>' +
          form('/dashboard/review-link', session.csrf, {},
            '<label>Exact client ID <input name="client_id" required maxlength="128"></label>' +
            '<select name="device_id">' + devices.map(d =>
              `<option value="${escape(d.id)}">${escape(d.label)}</option>`).join('') +
            '</select>' + button('Review client identity'));
      }
      for (const link of store.linksForOwner(session.owner_id)) {
        content += `<p>${escape(link.client_label)} <code>${escape(link.client_id)}</code>
          / ${escape(link.device_label)}</p>` +
          form('/dashboard/unlink', session.csrf,
            { client_id: link.client_id, device_id: link.device_id }, button('Unlink and end control'));
      }
      content += '</section>' + form('/dashboard/logout', session.csrf, {}, button('Sign out'));
      html(res, content);
      return;
    }
    if (path.startsWith('/dashboard/') && method === 'POST') {
      requireValue(session, 'NOT_AUTHORIZED', 401);
      requireValue(sourceOrigin === config.origin, 'CSRF_INVALID', 403);
      const data = await body(req, 16384);
      requireValue(data && typeof data === 'object' && !Array.isArray(data), 'INVALID_ARGUMENTS');
      requireValue(equal(data.csrf, session.csrf), 'CSRF_INVALID', 403);
      const ownerId = session.owner_id;
      if (path === '/dashboard/approve-enrollment') {
        store.approveEnrollment(data.enrollment_id, ownerId);
        audit('enrollment_approved', { owner_id: ownerId });
        html(res, '<p>Approved. Return to the extension and confirm the owner and reference locally.</p><a href="/dashboard">Dashboard</a>');
        return;
      }
      if (path === '/dashboard/create-client' || path === '/dashboard/rotate-client') {
        const client = path.endsWith('create-client')
          ? store.createClient(ownerId, data.label) : store.rotateClient(ownerId, data.client_id);
        bridge.reconcile();
        if (path.endsWith('rotate-client')) {
          for (const [id, grant] of bridge.grants) if (grant.client_id === client.id) bridge.endGrant(id, 'REVOKED');
        }
        audit('client_credential_issued', { owner_id: ownerId, client_id: client.id });
        html(res, `<h2>Credential shown once</h2><p>Client ID: <code>${escape(client.id)}</code></p>
          <p>Import directly into your credential vault. Do not paste into chat or agent configuration.</p>
          <code>${escape(client.credential)}</code><p><a href="/dashboard">Dashboard</a></p>`);
        return;
      }
      if (path === '/dashboard/review-link') {
        const client = store.client(data.client_id);
        const device = store.device(data.device_id);
        requireValue(client && device?.owner_id === ownerId, 'NOT_AUTHORIZED', 403);
        html(res, `<h2>Review client/device link</h2>
          <p>Client: ${escape(client.label)} <code>${escape(client.id)}</code></p>
          <p>Your device: ${escape(device.label)} <code>${escape(device.id)}</code></p>
          <p>Labels are descriptive, not verified claims about an agent group.
          Check the exact client ID with its operator. This permits requests only;
          control still requires confirmation in your extension.</p>` +
          form('/dashboard/link', session.csrf,
            { client_id: client.id, device_id: device.id }, button('Allow this client to request access')) +
          '<a href="/dashboard">Cancel</a>');
        return;
      }
      if (path === '/dashboard/link') store.link(ownerId, data.client_id, data.device_id);
      else if (path === '/dashboard/unlink') store.unlink(ownerId, data.client_id, data.device_id);
      else if (path === '/dashboard/revoke-client') store.revoke(ownerId, 'client', data.client_id);
      else if (path === '/dashboard/revoke-device') store.revoke(ownerId, 'device', data.device_id);
      else if (path === '/dashboard/logout') {
        store.logout(cookie);
        redirect(res, '/', secureCookie(COOKIE, '', 0));
        return;
      } else throw new Fault('NOT_FOUND', 404);
      bridge.reconcile();
      audit(path.slice('/dashboard/').replaceAll('-', '_'), {
        owner_id: ownerId, client_id: data.client_id, device_id: data.device_id,
      });
      redirect(res, '/dashboard');
      return;
    }
    throw new Fault('NOT_FOUND', 404);
  }
  return {
    server, bridge, config,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.bind, () => { server.removeListener('error', reject); resolve(); });
      });
      return server.address();
    },
    async close() {
      bridge.close();
      server.closeIdleConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
