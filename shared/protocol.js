export const VERSION = 6;
export const SESSION_TAB_LIMIT = 8;
export const SESSION_CONCURRENCY = 2;
export const HEARTBEAT_MS = 30_000;
export const LIVENESS_MS = 90_000;
export const ACCESS_TOKEN_MS = 600_000;
export const PAIRING_CODE_MS = 300_000;
export const UNPAIRED_BROWSER_MS = 86_400_000;
export const SESSION_RETENTION_MS = 7 * 86_400_000;
export const HUMAN_WAIT_MS = 600_000;
export const DEFAULT_HUMAN_WAIT_MS = 300_000;
export const EXECUTION_MS = 25_000;
export const PAGE_WAIT_MS = 10_000;
export const DEFAULT_OUTPUT_BYTES = 16 * 1024;
export const MAX_OUTPUT_BYTES = 64 * 1024;
export const DEFAULT_TEXT_CHARS = 4000;
export const MAX_TEXT_CHARS = 16_000;
export const DEFAULT_ELEMENTS = 50;
export const MAX_ELEMENTS = 100;
export const GROUP_COLORS = Object.freeze(['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']);

const shortId = prefix => Object.freeze({ type: 'string', pattern: `^${prefix}[0-9a-z]{1,12}(?![\\s\\S])` });
export const BROWSER_ID_SCHEMA = shortId('b');
export const SESSION_ID_SCHEMA = shortId('s');
export const GROUP_ID_SCHEMA = shortId('g');
export const TAB_ID_SCHEMA = Object.freeze({ ...shortId('t'),
  description: 'Tab ID from list_tabs, request_session or create_tab. IDs are scoped to your sessions; shape alone grants nothing.' });
export const AGENT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export const validShortId = (prefix, value) =>
  typeof value === 'string' && new RegExp(`^${prefix}[0-9a-z]{1,12}$`).test(value);
export const validTabId = value => validShortId('t', value);

/** Stable per-agent native group color; grey is reserved for the attention flash. */
export function agentColor(agentId) {
  let hash = 0;
  for (const char of String(agentId)) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return GROUP_COLORS[hash % GROUP_COLORS.length];
}

export const READINESS_ERRORS = Object.freeze([
  'ELEMENT_NOT_FOUND', 'ELEMENT_DISABLED', 'ELEMENT_READONLY',
  'ELEMENT_NOT_VISIBLE', 'ELEMENT_OBSCURED', 'OPTION_NOT_FOUND',
]);
export const MIN_DESCRIPTION_LENGTH = 40;
export function validDescription(value) {
  return typeof value === 'string' && [...value].length <= 500 &&
    [...value.trim()].length >= MIN_DESCRIPTION_LENGTH;
}
export function validBrowserInfo(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => ['extension_version', 'browser_name', 'browser_version'].includes(key)) &&
    typeof value.extension_version === 'string' && value.extension_version.length <= 32 &&
    /^[0-9]+(?:\.[0-9]+){0,3}$/.test(value.extension_version) &&
    ['chrome', 'firefox'].includes(value.browser_name) &&
    (value.browser_version === null || (
      typeof value.browser_version === 'string' && /^[0-9][0-9A-Za-z.+_-]{0,63}$/.test(value.browser_version)
    ));
}
export function inspectionErrorDetails(error) {
  if (!['PAGE_UNAVAILABLE', 'DOCUMENT_NOT_CONTROLLABLE', 'TARGET_STALE', 'WAIT_TIMEOUT'].includes(error?.code) ||
      !['tab_status', 'document_injection', 'document_state', 'document_changed', 'content_readiness'].includes(error.inspection_stage)) return {};
  const result = { inspection_stage: error.inspection_stage };
  if (['permission_denied', 'browser_restricted', 'frame_unavailable', 'helper_execution_failed',
    'empty_result', 'unknown'].includes(error.injection_reason)) result.injection_reason = error.injection_reason;
  if (['PAGE_UNAVAILABLE', 'TARGET_STALE', ...(error.inspection_stage === 'content_readiness' ? READINESS_ERRORS : [])].includes(error.last_error) &&
      Number.isSafeInteger(error.timeout_ms) && error.timeout_ms >= 0 && error.timeout_ms <= PAGE_WAIT_MS) {
    result.last_error = error.last_error;
    result.timeout_ms = error.timeout_ms;
  }
  return result;
}
export function waitErrorDetails(error) {
  const contentReadiness = error?.readiness_stage === 'content_readiness';
  const causes = contentReadiness ? [...READINESS_ERRORS, 'PAGE_UNAVAILABLE', 'TARGET_STALE'] : READINESS_ERRORS;
  const codes = contentReadiness ? ['WAIT_TIMEOUT', ...causes] : ['WAIT_TIMEOUT'];
  if (!codes.includes(error?.code) || !causes.includes(error.last_error) ||
      !Number.isSafeInteger(error.timeout_ms) || error.timeout_ms < (contentReadiness ? 0 : 1) ||
      error.timeout_ms > PAGE_WAIT_MS) return {};
  return { last_error: error.last_error, timeout_ms: error.timeout_ms,
    ...(contentReadiness ? { readiness_stage: 'content_readiness' } : {}) };
}
const output = { max_output_bytes: { type: 'integer', minimum: 1024, maximum: MAX_OUTPUT_BYTES,
  default: DEFAULT_OUTPUT_BYTES, description: 'Maximum UTF-8 bytes for the serialized MCP result, including its text-content wrapper. Default 16 KiB; hard maximum 64 KiB. Narrow the request before increasing.' } };
const readText = { max_text_chars: { type: 'integer', minimum: 0, maximum: MAX_TEXT_CHARS,
  default: DEFAULT_TEXT_CHARS, description: 'Maximum returned text characters; default 4000. Truncation is explicit. Prefer a focused selector.' } };
const readElements = { max_elements: { type: 'integer', minimum: 1, maximum: MAX_ELEMENTS,
  default: DEFAULT_ELEMENTS, description: 'Maximum returned elements; default 50. Truncation is explicit.' } };
const target = {
  selector: { type: 'string', minLength: 1, maxLength: 4096 },
  ref: { type: 'string', pattern: '^e[1-9][0-9]{0,8}(?![\\s\\S])' },
  document: { type: 'string', minLength: 8, maxLength: 128 },
};
const timeout = { timeout_ms: { type: 'integer', minimum: 0, maximum: PAGE_WAIT_MS,
  description: 'Page/element readiness wait, not a human wait. Element actions default to 3000 ms; wait_for_page defaults to 10000 ms. Use 0 for immediate selector probes. An exhausted positive wait returns WAIT_TIMEOUT; last_error identifies the last element-readiness cause.' } };
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
    description: 'JavaScript source/expression evaluated in the page, not a function body. Maximum 65536 UTF-16 code units, not lines. Use document.title or (() => document.title)(); top-level return is invalid. Return only focused JSON data; page CSP may refuse evaluation.' },
    world: { type: 'string', enum: ['MAIN', 'USER_SCRIPT'], default: 'MAIN',
      description: 'Execution world. MAIN is the default; USER_SCRIPT requires native browser support and local enablement, never an isolated-world fallback.' },
    ...output }, ['script']),
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
  wait_for_page: operation({ ...timeout, content_selector: { ...target.selector,
    description: 'Optional content readiness selector: wait for at least one visible match after the document settles. Maximum 4096 UTF-16 code units.' } }),
  clear_overlays: operation({}),
});
export const OPERATIONS = Object.freeze(Object.keys(OPERATION_SCHEMAS));
export const HANDOFF_SCHEMA = operation({
  instructions: { type: 'string', minLength: 1, maxLength: 2000, unit: 'unicode_code_points',
    description: 'What the person should do in this tab. Plain text, maximum 2000 Unicode code points.' },
  suggested_text: { type: 'string', maxLength: 8000,
    description: 'Optional text for the user to copy manually. Maximum 8000 UTF-16 code units; never inserted or submitted automatically.' },
}, ['instructions']);
export const DESCRIPTION_SCHEMA = Object.freeze({ type: 'string', minLength: MIN_DESCRIPTION_LENGTH,
  maxLength: 500, unit: 'unicode_code_points', trimMinimum: true });
const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![\\s\\S])';

export function schemaArgumentErrors(spec, args) {
  if (!spec || !args || typeof args !== 'object' || Array.isArray(args)) {
    return [{ field: 'arguments', reason: 'expected_object' }];
  }
  const errors = [];
  if (Object.keys(args).some(key => !Object.hasOwn(spec.properties, key))) {
    errors.push({ field: 'arguments', reason: 'unexpected_field' });
  }
  for (const key of spec.required || []) {
    if (!Object.hasOwn(args, key)) errors.push({ field: key, reason: 'required' });
  }
  for (const [key, field] of Object.entries(spec.properties)) {
    if (!Object.hasOwn(args, key)) continue;
    const value = args[key];
    if (field.type === 'integer') {
      if (!Number.isSafeInteger(value)) errors.push({ field: key, reason: 'expected_integer' });
      else if (value < field.minimum || value > field.maximum) errors.push({
        field: key, reason: 'out_of_range', limits: { minimum: field.minimum, maximum: field.maximum },
      });
      continue;
    }
    if (typeof value !== field.type) { errors.push({ field: key, reason: `expected_${field.type}` }); continue; }
    if (field.type === 'string') {
      const unit = field.unit || 'utf16_code_units';
      const length = field.unit === 'unicode_code_points' ? [...value].length : value.length;
      const minimumLength = field.trimMinimum ? [...value.trim()].length : length;
      if (field.minLength !== undefined && minimumLength < field.minLength) errors.push({
        field: key, reason: 'too_short', limits: { minimum: field.minLength },
        actual_length: minimumLength, unit, ...(field.trimMinimum ? { measured_after_trim: true } : {}),
      });
      if (field.maxLength !== undefined && length > field.maxLength) errors.push({
        field: key, reason: 'too_long', limits: { maximum: field.maxLength }, actual_length: length, unit,
      });
      if ((field.pattern && !new RegExp(field.pattern).test(value)) ||
          (field.format === 'uuid' && !new RegExp(UUID_PATTERN).test(value))) {
        errors.push({ field: key, reason: 'invalid_format' });
      }
    }
    if (field.enum && !field.enum.includes(value)) errors.push({
      field: key, reason: 'invalid_enum', limits: { allowed: [...field.enum] },
    });
  }
  if (Object.hasOwn(spec.properties, 'ref')) {
    if (args.ref !== undefined && args.document === undefined) errors.push({ field: 'document', reason: 'required_with_ref' });
    if (args.ref !== undefined && args.selector !== undefined) errors.push({ field: 'selector', reason: 'conflicts_with_ref' });
    if (args.document !== undefined && args.ref === undefined && args.selector === undefined) {
      errors.push({ field: 'document', reason: 'requires_ref_or_selector' });
    }
  }
  if (spec.anyOf && !spec.anyOf.some(choice => choice.required.every(key => Object.hasOwn(args, key)))) {
    errors.push({ field: 'selector', reason: 'required_selector_or_ref_document' });
  }
  return errors;
}
export function operationArgumentErrors(name, args) {
  return schemaArgumentErrors(name === 'request_handoff' ? HANDOFF_SCHEMA : OPERATION_SCHEMAS[name], args);
}
export function validOperationArgs(name, args) {
  return operationArgumentErrors(name, args).length === 0;
}

export function validName(value, max = 80) {
  return typeof value === 'string' && value.trim().length > 0 && [...value].length <= max && !/[\u0000-\u001f\u007f]/.test(value);
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

// Domain-separated proof transcripts. Each binds the service origin and a fresh server nonce.
export function registerPayload(c) {
  return encode(['domagent.v6', 'register', c.origin, c.nonce, c.key_id, c.extension_origin, c.name]);
}

export function tokenPayload(c) {
  return encode(['domagent.v6', 'token', c.origin, c.nonce, c.browser_id, c.key_id]);
}

export function connectPayload(c) {
  return encode(['domagent.v6', 'connect', c.origin, c.nonce, c.browser_id, c.connection_id]);
}

export function normalizePairingCode(value) {
  if (typeof value !== 'string' || value.length > 16) throw new Error('PAIRING_UNAVAILABLE');
  const code = value.toUpperCase().replaceAll('-', '').replaceAll(' ', '');
  if (!/^[0-9A-HJKMNP-TV-Z]{8}$/.test(code)) throw new Error('PAIRING_UNAVAILABLE');
  return code;
}

export function pairingCode(random = n => crypto.getRandomValues(new Uint8Array(n))) {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const code = [...random(8)].map(value => alphabet[value % 32]).join('');
  return `${code.slice(0, 4)}-${code.slice(4)}`;
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
