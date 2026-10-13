import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import {
  VERSION, POLICY_ID, extensionOrigin, keyId, verify, pairingStartPayload,
  pairingStatusPayload, pairingConfirmPayload, pairingCancelPayload,
} from '../shared/protocol.js';
import { token, hash, validLabel, PAIRING_TTL_MS } from './store.js';
import { BridgeServer, UUID } from './server.js';
import { handleMcp } from './mcp.js';
import { Fault, requireValue, failureCode, audit } from './errors.js';
import { RateLimiter } from './rate.js';
import { SERVICE_VERSION } from './version.js';

export { SERVICE_VERSION } from './version.js';
const COOKIE = '__Host-domagent_session';
const secureCookie = (value, age) => `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${age}`;
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  timingSafeEqual(Buffer.from(hash(a), 'hex'), Buffer.from(hash(b), 'hex'));
const escape = value => String(value).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const page = content => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>DomAgent operator</title><main><h1>DomAgent operator</h1>${content}</main></html>`;
const receiptShape = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) &&
  Buffer.from(value, 'base64url').toString('base64url') === value;
function cookies(req) {
  const values = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const index = part.indexOf('='); if (index > 0) values[part.slice(0, index).trim()] = part.slice(index + 1);
  }
  return values;
}
async function body(req, limit = 262144, form = false) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length; requireValue(size <= limit, 'PAYLOAD_TOO_LARGE', 413); chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (form && req.headers['content-type']?.split(';')[0] === 'application/x-www-form-urlencoded') {
    return Object.fromEntries(new URLSearchParams(text));
  }
  requireValue(req.headers['content-type']?.split(';')[0] === 'application/json', 'CONTENT_TYPE_REQUIRED', 415);
  let value;
  try { value = JSON.parse(text); } catch { throw new Fault('INVALID_JSON'); }
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_JSON'); return value;
}
function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); }
function html(res, value) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(page(value)); }
function redirect(res, path) { res.writeHead(303, { Location: path }); res.end(); }
const allowedFields = (data, required, optional = []) => {
  requireValue(required.every(k => Object.hasOwn(data, k)) &&
    Object.keys(data).every(k => required.includes(k) || optional.includes(k)), 'INVALID_ARGUMENTS');
};
function extension(value) {
  try { return extensionOrigin(value); } catch { throw new Fault('NOT_AUTHORIZED', 403); }
}
async function proof(publicKey, payload, signature) {
  let verified = false;
  try { verified = await verify(publicKey, payload, signature); } catch { throw new Fault('NOT_AUTHORIZED', 403); }
  requireValue(verified, 'NOT_AUTHORIZED', 403);
}

export function createApp(store, config) {
  const bridge = new BridgeServer(store, config), now = config.now || Date.now;
  const challenges = new Map(), rates = new RateLimiter(now);
  let activeMcp = 0;
  const operatorSecret = () => typeof config.operatorSecret === 'function' ? config.operatorSecret() : config.operatorSecret;
  const rateLimit = req => {
    // Forwarded addresses are deliberately ignored; deployers must not treat caller headers as identity.
    rates.take(`http:${req.socket.remoteAddress}`, 600);
    for (const [id, row] of challenges) if (row.expires_at <= now()) challenges.delete(id);
  };
  const server = createServer((req, res) => {
    route(req, res).catch(error => {
      audit('http_failure', { code: failureCode(error) });
      if (res.headersSent) { res.destroy(); return; }
      json(res, error instanceof Fault ? error.status : 500, { error: failureCode(error) });
    });
  });
  server.requestTimeout = 30_000; server.headersTimeout = 10_000;
  server.on('upgrade', (req, socket, head) => {
    try { rateLimit(req); bridge.upgrade(req, socket, head); }
    catch (error) {
      audit('ws_rejected', { code: failureCode(error) });
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
    }
  });
  async function route(req, res) {
    rateLimit(req);
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    const url = new URL(req.url, config.origin), path = url.pathname, method = req.method, origin = req.headers.origin;
    requireValue(!url.search, 'INVALID_ARGUMENTS');
    if (path === '/health' && method === 'GET') {
      json(res, 200, { service: 'domagent', status: 'ok', version: SERVICE_VERSION, protocol_version: VERSION });
      return;
    }
    if (path === '/.well-known/domagent' && method === 'GET') {
      if (origin) {
        extension(origin);
        res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
      }
      json(res, 200, { service: 'domagent', version: SERVICE_VERSION, service_version: SERVICE_VERSION,
        protocol_version: VERSION, policy_id: POLICY_ID, origin: config.origin, pairing: '/api/pairing' }); return;
    }
    if (/^\/api\/pairing\/(challenge|start|status|confirm|cancel)$/.test(path)) {
      const extensionOrigin = origin || req.headers['x-domagent-extension-origin'];
      extension(extensionOrigin);
      if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      if (method === 'OPTIONS') {
        requireValue(req.headers['access-control-request-method'] === (path.endsWith('/challenge') ? 'GET' : 'POST'),
          'METHOD_NOT_ALLOWED', 405);
        const headers = (req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(v => v.trim()).filter(Boolean);
        requireValue(headers.every(h => ['content-type', 'x-domagent-extension-origin'].includes(h)), 'NOT_AUTHORIZED', 403);
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST',
          'Access-Control-Allow-Headers': 'Content-Type, X-DomAgent-Extension-Origin' }); res.end(); return;
      }
      const action = path.split('/').pop();
      if (action === 'challenge') {
        requireValue(method === 'GET', 'METHOD_NOT_ALLOWED', 405);
        rates.take(`challenge:${req.socket.remoteAddress}`, 30); rates.take('challenge:global', 300);
        requireValue(challenges.size < 1000, 'RATE_LIMITED', 429);
        const nonce = token(), expires_at = now() + PAIRING_TTL_MS;
        challenges.set(nonce, { origin: extensionOrigin, expires_at });
        json(res, 200, { origin: config.origin, nonce, expires_at }); return;
      }
      requireValue(method === 'POST', 'METHOD_NOT_ALLOWED', 405);
      const data = await body(req, 8192);
      requireValue(UUID.test(data.request_id || '') && typeof data.key_id === 'string' && receiptShape(data.receipt) &&
        typeof data.signature === 'string', 'INVALID_ARGUMENTS');
      if (action === 'start') {
        rates.take(`pairing-start:${req.socket.remoteAddress}`, 20); rates.take('pairing-start:global', 200);
        allowedFields(data, ['request_id','key_id','public_key','extension_origin','pairing_code','receipt','nonce','label','signature']);
        requireValue(data.extension_origin === extensionOrigin && validLabel(data.label) && typeof data.pairing_code === 'string', 'INVALID_ARGUMENTS');
        const challenge = challenges.get(data.nonce);
        requireValue(challenge && challenge.origin === extensionOrigin && challenge.expires_at > now(), 'CHALLENGE_EXPIRED', 403);
        let id;
        try { id = await keyId(data.public_key); } catch { throw new Fault('INVALID_PUBLIC_KEY'); }
        requireValue(id === data.key_id, 'NOT_AUTHORIZED', 403);
        await proof(data.public_key, pairingStartPayload({ ...data, origin: config.origin }), data.signature);
        // Recheck after asynchronous crypto: concurrent submissions cannot reuse one challenge.
        requireValue(challenges.get(data.nonce) === challenge && challenge.expires_at > now(), 'CHALLENGE_EXPIRED', 403);
        challenges.delete(data.nonce);
        json(res, 201, store.pairingStart(data)); return;
      }
      rates.take(`pairing-status:${req.socket.remoteAddress}`, 300); rates.take('pairing-status:global', 2000);
      const common = ['request_id','key_id','receipt','signature'];
      allowedFields(data, action === 'confirm' ? [...common,'proposal_id','tenant_id','client_id','nonce'] : common);
      const row = store.pairing(data.request_id, data.key_id, data.receipt);
      requireValue(row && row.extension_origin === extensionOrigin, 'PAIRING_UNAVAILABLE', 404);
      const payload = action === 'confirm' ? pairingConfirmPayload : action === 'cancel' ? pairingCancelPayload : pairingStatusPayload;
      let signed;
      try { signed = payload({ ...data, origin: config.origin }); } catch { throw new Fault('INVALID_ARGUMENTS'); }
      await proof(JSON.parse(row.public_key), signed, data.signature);
      // Re-read revocation/proposal/expiry after proof verification.
      const current = store.pairing(data.request_id, data.key_id, data.receipt);
      requireValue(current, 'PAIRING_UNAVAILABLE', 404);
      let result = action === 'confirm' ? store.pairingConfirm(data) :
        action === 'cancel' ? store.pairingCancel(data) : store.pairingPublic(current);
      if (result.state === 'confirmed') result = { ...result, protected_origins: config.protectedOrigins };
      json(res, 200, result); return;
    }
    const mcp = /^\/mcp\/(t_[A-Za-z0-9_-]{22})$/.exec(path);
    if (mcp) {
      requireValue(method === 'POST', 'METHOD_NOT_ALLOWED', 405);
      requireValue(!origin || origin === config.origin, 'NOT_AUTHORIZED', 403);
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '');
      const client = match && store.authenticateClient(match[1], mcp[1]);
      requireValue(client, 'NOT_AUTHORIZED', 401);
      requireValue(activeMcp < 256, 'RATE_LIMITED', 429);
      rates.take(`mcp:${client.id}`, 300); activeMcp++;
      try { await handleMcp(req, res, await body(req), client, bridge); } finally { activeMcp--; }
      return;
    }
    if (path === '/login' || path === '/dashboard' || path.startsWith('/api/operator/')) {
      const secret = operatorSecret();
      requireValue(typeof secret === 'string' && secret.length >= 32, 'NOT_FOUND', 404);
      if ((path === '/login' && method === 'POST') || path === '/api/operator/login') {
        requireValue(method === 'POST', 'METHOD_NOT_ALLOWED', 405);
        requireValue(origin === config.origin, 'NOT_AUTHORIZED', 403);
        rates.take(`login:${req.socket.remoteAddress}`, 5); rates.take('login:global', 100);
        const data = await body(req, 8192, true);
        allowedFields(data, ['secret']); requireValue(equal(data.secret, secret), 'NOT_AUTHORIZED', 401);
        const session = store.createSession(hash(secret));
        res.setHeader('Set-Cookie', secureCookie(session.token, 3600));
        if (path === '/login') redirect(res, '/dashboard');
        else json(res, 200, { csrf: session.csrf, expires_at: session.expires });
        return;
      }
      if (path === '/login' && method === 'GET') {
        html(res, '<form action="/login" method="post"><label>Operator secret <input type="password" name="secret" required autocomplete="current-password"></label><button>Sign in</button></form>'); return;
      }
      if (path === '/api/operator/workspaces' && method === 'GET' && equal(req.headers.authorization, `Bearer ${secret}`)) {
        json(res, 200, store.listClients().filter(c => store.client(c.id)).map(c =>
          ({ client_id: c.id, tenant_id: c.tenant_id, devices: bridge.listWorkspaces(c.id, c.tenant_id) }))); return;
      }
      const credential = cookies(req)[COOKIE], session = store.session(credential, hash(secret));
      requireValue(session, 'NOT_AUTHORIZED', 401);
      if (path === '/dashboard' && method === 'GET') {
        const rows = (kind, list) => list.map(row => `<li>${escape(row.label)} — ${escape(row.id)} (${row.revoked ? 'revoked' : 'registered'})
          <form action="/api/operator/${kind}/${escape(row.id)}/revoke" method="post">
          <input type="hidden" name="csrf" value="${escape(session.csrf)}"><button>Revoke</button></form></li>`).join('');
        html(res, `<p>Provision and rotate MCP credentials using the local CLI; they are never shown here.</p><h2>Clients</h2><ul>${rows('client', store.listClients())}</ul>
          <h2>Devices (including offline entries)</h2><ul>${rows('device', store.listDevices())}</ul>
          <form action="/api/operator/logout" method="post"><input type="hidden" name="csrf" value="${escape(session.csrf)}"><button>Sign out</button></form>`); return;
      }
      if (method === 'GET') {
        if (path === '/api/operator/clients') { json(res, 200, store.listClients()); return; }
        if (path === '/api/operator/devices') { json(res, 200, store.listDevices()); return; }
        if (path === '/api/operator/workspaces') {
          json(res, 200, store.listClients().filter(c => store.client(c.id)).map(c =>
            ({ client_id: c.id, devices: bridge.listWorkspaces(c.id, c.tenant_id) }))); return;
        }
        throw new Fault('NOT_FOUND', 404);
      }
      requireValue(method === 'POST' && origin === config.origin, 'NOT_AUTHORIZED', 403);
      rates.take(`operator:${hash(credential)}`, 60);
      const data = await body(req, 4096, true);
      requireValue(equal(data.csrf, session.csrf), 'CSRF_INVALID', 403);
      if (path === '/api/operator/logout') {
        allowedFields(data, ['csrf']); store.logout(credential); res.setHeader('Set-Cookie', secureCookie('', 0));
        json(res, 200, { logged_out: true }); return;
      }
      const mutation = /^\/api\/operator\/(client|device)\/([0-9a-f-]{36})\/(rename|revoke)$/.exec(path);
      requireValue(mutation, 'NOT_FOUND', 404);
      const [, kind, id, action] = mutation;
      allowedFields(data, action === 'rename' ? ['csrf','label'] : ['csrf']);
      if (action === 'rename') store.rename(kind, id, data.label); else store.revoke(kind, id);
      bridge.reconcile();
      if (req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) redirect(res, '/dashboard');
      else json(res, 200, { id, [action === 'rename' ? 'renamed' : 'revoked']: true });
      return;
    }
    throw new Fault('NOT_FOUND', 404);
  }
  return { server, bridge,
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
