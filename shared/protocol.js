export const VERSION = 2;
export const POLICY_ID = 'page-control-v1';
export const HEARTBEAT_MS = 5_000;
export const LIVENESS_MS = 15_000;
export const OPERATIONS = Object.freeze([
  'navigate', 'click', 'type_text', 'get_text', 'evaluate_script',
  'get_screenshot', 'get_interactive_elements', 'clear_overlays',
]);

export function tenantId(value) {
  if (typeof value !== 'string' || !/^t_[A-Za-z0-9_-]{22}$/.test(value)) {
    throw new Error('INVALID_TENANT');
  }
  return value;
}

export function connectionUrl(origin, tenant) {
  return `${serviceOrigin(origin)}/join/${tenantId(tenant)}`;
}

export function parseConnectionUrl(value) {
  const url = new URL(value.trim());
  const match = /^\/join\/(t_[A-Za-z0-9_-]{22})\/?$/.exec(url.pathname);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !match) {
    throw new Error('INVALID_CONNECTION_LINK');
  }
  const tenant_id = tenantId(match[1]);
  return { origin: url.origin, tenant_id, connection_url: connectionUrl(url.origin, tenant_id) };
}

export function serviceOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search ||
      url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('INVALID_SERVICE_ORIGIN');
  }
  return url.origin;
}

export function extensionOrigin(value) {
  if (!/^(chrome-extension:\/\/[a-p]{32}|moz-extension:\/\/[a-f0-9-]{36})$/i.test(value)) {
    throw new Error('INVALID_EXTENSION_ORIGIN');
  }
  return value;
}

export function encode(value) {
  return new TextEncoder().encode(JSON.stringify(value));
}

export function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function unbase64url(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(value) || value.length > 1024) {
    throw new Error('INVALID_SIGNATURE');
  }
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
}

export async function keyId(jwk) {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || Object.hasOwn(jwk, 'd') ||
      typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new Error('INVALID_PUBLIC_KEY');
  }
  return base64url(await crypto.subtle.digest('SHA-256', encode([jwk.kty, jwk.crv, jwk.x, jwk.y])));
}

export function authPayload(c) {
  return encode(['domagent.v2', 'auth', c.origin, tenantId(c.tenant_id), c.epoch, c.connection_id, c.nonce, c.key_id]);
}

export function startPayload(c) {
  return encode(['domagent.v2', 'enroll-start', c.origin, tenantId(c.tenant_id), c.nonce, c.key_id, c.extension_origin, c.label]);
}

export function statusPayload(c) {
  return encode(['domagent.v2', 'enroll-status', c.origin, tenantId(c.tenant_id), c.enrollment_id]);
}

export function enrollmentPayload(c) {
  return encode(['domagent.v2', 'enroll-confirm', c.origin, tenantId(c.tenant_id), c.enrollment_id, c.owner_id,
    c.key_id, c.nonce, c.extension_origin]);
}

export function grantPayload(c) {
  return encode(['domagent.v2', 'grant', c.origin, tenantId(c.tenant_id), c.epoch, c.connection_id, c.request_id,
    c.client_id, c.target_id, c.policy_id, c.nonce, [...c.capabilities].sort()]);
}

export async function sign(key, payload) {
  return base64url(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, payload));
}

export async function verify(jwk, payload, signature) {
  const publicKey = await crypto.subtle.importKey('jwk',
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' },
    publicKey, unbase64url(signature), payload);
}

export function navigationUrl(value, protectedOrigins) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      protectedOrigins.includes(url.origin)) {
    throw new Error('HANDOFF_REQUIRED');
  }
  return url.href;
}
