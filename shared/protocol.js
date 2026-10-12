export const VERSION = 4;
export const POLICY_ID = 'single-tab-workspace-v1';
export const HEARTBEAT_MS = 5_000;
export const LIVENESS_MS = 15_000;
export const HUMAN_WAIT_MS = 600_000;
export const EXECUTION_MS = 25_000;
export const PAGE_WAIT_MS = 10_000;
export const DEFAULT_OUTPUT_BYTES = 16 * 1024;
export const MAX_OUTPUT_BYTES = 64 * 1024;
export const DEFAULT_TEXT_CHARS = 4000;
export const MAX_TEXT_CHARS = 16_000;
export const DEFAULT_ELEMENTS = 50;
export const MAX_ELEMENTS = 100;
export const TARGET_ID_SCHEMA = Object.freeze({
  type: 'string',
  pattern: '^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[A-Za-z0-9_-]{43})(?![\\s\\S])',
  description: 'Opaque shared-tab handle returned by request_browser_access; pass it unchanged. UUID handles and legacy 43-character tokens are accepted. Shape alone does not authorize access.',
});
export function validTargetId(value) {
  return typeof value === 'string' && new RegExp(TARGET_ID_SCHEMA.pattern).test(value);
}

export const READINESS_ERRORS = Object.freeze([
  'ELEMENT_NOT_FOUND', 'ELEMENT_DISABLED', 'ELEMENT_READONLY',
  'ELEMENT_NOT_VISIBLE', 'ELEMENT_OBSCURED', 'OPTION_NOT_FOUND',
]);
export const MIN_DESCRIPTION_LENGTH = 40;
export function validDescription(value) {
  return typeof value === 'string' && value.length <= 500 &&
    [...value.trim()].length >= MIN_DESCRIPTION_LENGTH;
}
export function inspectionErrorDetails(error) {
  if (!['PAGE_UNAVAILABLE', 'TARGET_STALE', 'WAIT_TIMEOUT'].includes(error?.code) ||
      !['tab_status', 'document_injection', 'document_state', 'document_changed'].includes(error.inspection_stage)) return {};
  const result = { inspection_stage: error.inspection_stage };
  if (['PAGE_UNAVAILABLE', 'TARGET_STALE'].includes(error.last_error) &&
      Number.isSafeInteger(error.timeout_ms) && error.timeout_ms >= 0 && error.timeout_ms <= PAGE_WAIT_MS) {
    result.last_error = error.last_error;
    result.timeout_ms = error.timeout_ms;
  }
  return result;
}
export function waitErrorDetails(error) {
  if (error?.code !== 'WAIT_TIMEOUT' || !READINESS_ERRORS.includes(error.last_error) ||
      !Number.isSafeInteger(error.timeout_ms) || error.timeout_ms <= 0 || error.timeout_ms > PAGE_WAIT_MS) return {};
  return { last_error: error.last_error, timeout_ms: error.timeout_ms };
}
const output = { max_output_bytes: { type: 'integer', minimum: 1024, maximum: MAX_OUTPUT_BYTES,
  default: DEFAULT_OUTPUT_BYTES, description: 'Maximum UTF-8 bytes for the serialized MCP result, including its text-content wrapper. Default 16 KiB; hard maximum 64 KiB. Narrow the request before increasing.' } };
const readText = { max_text_chars: { type: 'integer', minimum: 0, maximum: MAX_TEXT_CHARS,
  default: DEFAULT_TEXT_CHARS, description: 'Maximum returned text characters; default 4000. Truncation is explicit. Prefer a focused selector.' } };
const readElements = { max_elements: { type: 'integer', minimum: 1, maximum: MAX_ELEMENTS,
  default: DEFAULT_ELEMENTS, description: 'Maximum returned elements; default 50. Truncation is explicit.' } };
const target = {
  selector: { type: 'string', minLength: 1, maxLength: 4096 },
  ref: { type: 'string', pattern: '^e[1-9][0-9]{0,8}$' },
  document: { type: 'string', minLength: 8, maxLength: 128 },
};
const timeout = { timeout_ms: { type: 'integer', minimum: 0, maximum: PAGE_WAIT_MS,
  description: 'Page/element readiness wait after approval, not the human wait. Element actions default to 3000 ms; wait_for_page defaults to 10000 ms. Use 0 for immediate selector probes. An exhausted positive wait returns WAIT_TIMEOUT; last_error identifies the last element-readiness cause.' } };
const targeted = { ...target, ...timeout };
const text = { type: 'string', maxLength: 65_536 };
const operation = (properties, required = [], needsTarget = false) => ({
  properties, required, ...(needsTarget ? {
    anyOf: [{ required: ['selector'] }, { required: ['ref', 'document'] }],
  } : {}),
});
export const OPERATION_SCHEMAS = Object.freeze({
  navigate: operation({ url: { type: 'string', minLength: 1, maxLength: 8192 } }, ['url']),
  click: operation(targeted, [], true),
  inspect_element: operation({ ...target,
    max_output_bytes: { ...output.max_output_bytes, default: 4096, maximum: 4096,
      description: 'Inspector JSON result budget; default and hard maximum 4096 UTF-8 bytes.' },
  }, [], true),
  type_text: operation({ ...targeted, text }, ['text'], true),
  get_text: operation({ ...targeted, ...readText, ...output }),
  evaluate_script: operation({ script: { ...text, minLength: 1,
    description: 'JavaScript source/expression evaluated in the page, not a function body. Use document.title or (() => document.title)(); top-level return is invalid. Return only focused JSON data; page CSP may refuse evaluation.' }, ...output }, ['script']),
  get_screenshot: operation({}),
  get_interactive_elements: operation({ ...readElements, ...output }),
  get_page_snapshot: operation({ selector: target.selector, ...readText, ...readElements, ...output }),
  select_option: operation({ ...targeted, value: text }, ['value'], true),
  set_checked: operation({ ...targeted, checked: { type: 'boolean' } }, ['checked'], true),
  press_key: operation({ ...targeted, key: { type: 'string', enum: [
    'Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Home', 'End', 'Backspace', 'Delete', ' ',
  ] } }, ['key'], true),
  scroll: operation({ ...targeted,
    delta_x: { type: 'integer', minimum: -10_000, maximum: 10_000 },
    delta_y: { type: 'integer', minimum: -10_000, maximum: 10_000 },
  }, ['delta_y']),
  wait_for_page: operation(timeout),
  clear_overlays: operation({}),
});
export const OPERATIONS = Object.freeze(Object.keys(OPERATION_SCHEMAS));

export function validOperationArgs(name, args) {
  const spec = name === 'request_handoff' ? operation({}) : OPERATION_SCHEMAS[name];
  if (!spec || !args || typeof args !== 'object' || Array.isArray(args)) return false;
  if (Object.keys(args).some(key => !Object.hasOwn(spec.properties, key)) ||
      spec.required.some(key => !Object.hasOwn(args, key))) return false;
  if (args.ref !== undefined && (args.document === undefined || args.selector !== undefined)) return false;
  if (args.document !== undefined && args.ref === undefined && args.selector === undefined) return false;
  if (spec.anyOf && !spec.anyOf.some(choice => choice.required.every(key => Object.hasOwn(args, key)))) return false;
  return Object.entries(args).every(([key, value]) => {
    const field = spec.properties[key];
    if (field.type === 'integer') return Number.isSafeInteger(value) && value >= field.minimum && value <= field.maximum;
    if (typeof value !== field.type) return false;
    if (typeof value === 'string' && (
      value.length < (field.minLength || 0) || value.length > (field.maxLength || 4096) ||
      (field.pattern && !new RegExp(field.pattern).test(value)))) return false;
    return !field.enum || field.enum.includes(value);
  });
}

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
  return encode(['domagent.v4', 'auth', c.origin, tenantId(c.tenant_id), c.epoch, c.connection_id, c.nonce, c.key_id]);
}

export function startPayload(c) {
  return encode(['domagent.v4', 'enroll-start', c.origin, tenantId(c.tenant_id), c.nonce, c.key_id, c.extension_origin, c.label]);
}

export function statusPayload(c) {
  return encode(['domagent.v4', 'enroll-status', c.origin, tenantId(c.tenant_id), c.enrollment_id]);
}

export function enrollmentPayload(c) {
  return encode(['domagent.v4', 'enroll-confirm', c.origin, tenantId(c.tenant_id), c.enrollment_id, c.owner_id,
    c.key_id, c.nonce, c.extension_origin]);
}

export function grantPayload(c) {
  if (!Number.isSafeInteger(c.tab_id) || c.tab_id < 0) throw new Error('INVALID_TAB');
  if (!Number.isSafeInteger(c.window_id) || c.window_id < 0) throw new Error('INVALID_WINDOW');
  return encode(['domagent.v4', 'grant', c.origin, tenantId(c.tenant_id), c.epoch, c.connection_id, c.request_id,
    c.client_id, c.target_id, c.tab_id, c.window_id, c.policy_id, c.nonce, [...c.capabilities].sort()]);
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
