/**
 * A JSON object from the wire, the browser or a caller that has not been validated as a whole.
 * Code reading it checks each field at runtime before use, so fields are deliberately untyped.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Wire = Record<string, any>;
/** An Error carrying a stable DomAgent error code plus value-free details. */
export interface CodedError extends Error { code: string; [detail: string]: unknown }
export interface FieldSchema {
  type: string; description?: string; default?: unknown; minimum?: number; maximum?: number;
  minLength?: number; maxLength?: number; pattern?: string; format?: string; enum?: readonly unknown[];
  unit?: 'unicode_code_points' | 'utf16_code_units'; trimMinimum?: boolean;
}
export interface OperationSpec {
  properties: Record<string, FieldSchema>; required: readonly string[];
  anyOf?: readonly { required: readonly string[] }[];
}
export interface ArgumentError { field: string; reason: string; [detail: string]: unknown }

export const VERSION = 6;
export const SESSION_TAB_LIMIT = 8;
export const SESSION_CONCURRENCY = 2;
export const HEARTBEAT_MS = 30_000;
export const LIVENESS_MS = 90_000;
export const ACCESS_TOKEN_MS = 600_000;
export const PAIRING_CODE_MS = 300_000;
export const UNPAIRED_BROWSER_MS = 86_400_000;
export const PAIRED_BROWSER_MS = 30 * 86_400_000;
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
// One WebSocket frame carries the whole result; artifacts are bounded by it, minus envelope room.
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
export const MAX_ARTIFACT_BYTES = MAX_MESSAGE_BYTES - 64 * 1024;
export const ARTIFACT_TTL_MS = 86_400_000;
export const ARTIFACT_QUOTA_BYTES = 64 * 1024 * 1024;
export const ARTIFACT_QUOTA_COUNT = 100;
export const DEFAULT_ARTIFACT_READ_BYTES = 16 * 1024;
export const MAX_ARTIFACT_READ_BYTES = 48 * 1024;
export const ARTIFACT_MIME_TYPES = Object.freeze([
  'application/json', 'application/x-ndjson', 'text/plain', 'text/csv', 'text/html', 'text/markdown',
  'application/octet-stream', 'application/gzip', 'application/zip', 'application/pdf', 'image/png', 'image/jpeg',
]);
/** Artifact MIME types served and paged as UTF-8 text. */
export const ARTIFACT_TEXT_MIME = /^(?:text\/|application\/(?:json|x-ndjson)$)/;
export const ARTIFACT_ID_PATTERN = /^a[0-9A-Za-z_-]{22}$/;
/** Lowest extension version that understands each optional capability. */
export const EXTENSION_FEATURES = Object.freeze({ artifacts: '6.1.0', close_tabs: '6.1.3' });
export function versionAtLeast(version: unknown, minimum: string): boolean {
  const parts = (value: unknown) => String(value || '0').split('.').map(part => Number.parseInt(part, 10) || 0);
  const [a, b] = [parts(version), parts(minimum)];
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0);
  }
  return true;
}
export const GROUP_COLORS = Object.freeze(['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']);

const shortId = (prefix: string) => Object.freeze({ type: 'string', pattern: `^${prefix}[0-9a-z]{1,12}(?![\\s\\S])` });
export const BROWSER_ID_SCHEMA = shortId('b');
export const SESSION_ID_SCHEMA = shortId('s');
export const GROUP_ID_SCHEMA = shortId('g');
export const TAB_ID_SCHEMA = Object.freeze({ ...shortId('t'),
  description: 'Tab ID from list_tabs, request_session or create_tab. IDs are scoped to your sessions; shape alone grants nothing.' });
export const AGENT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export const validShortId = (prefix: string, value: unknown): value is string =>
  typeof value === 'string' && new RegExp(`^${prefix}[0-9a-z]{1,12}$`).test(value);
export const validTabId = (value: unknown): value is string => validShortId('t', value);

/** Stable per-agent native group color; grey is reserved for the attention flash. */
export function agentColor(agentId: string): string {
  let hash = 0;
  for (const char of String(agentId)) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return GROUP_COLORS[hash % GROUP_COLORS.length]!;
}

export const READINESS_ERRORS: readonly string[] = Object.freeze([
  'ELEMENT_NOT_FOUND', 'ELEMENT_DISABLED', 'ELEMENT_READONLY',
  'ELEMENT_NOT_VISIBLE', 'ELEMENT_OBSCURED', 'OPTION_NOT_FOUND',
]);
export const MIN_DESCRIPTION_LENGTH = 40;
export function validDescription(value: unknown): value is string {
  return typeof value === 'string' && [...value].length <= 500 &&
    [...value.trim()].length >= MIN_DESCRIPTION_LENGTH;
}
export function validBrowserInfo(value: Wire | null | undefined): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => ['extension_version', 'browser_name', 'browser_version'].includes(key)) &&
    typeof value.extension_version === 'string' && value.extension_version.length <= 32 &&
    /^[0-9]+(?:\.[0-9]+){0,3}$/.test(value.extension_version) &&
    ['chrome', 'firefox'].includes(value.browser_name) &&
    (value.browser_version === null || (
      typeof value.browser_version === 'string' && /^[0-9][0-9A-Za-z.+_-]{0,63}$/.test(value.browser_version)
    ));
}
export function inspectionErrorDetails(error: Wire | null | undefined): Wire {
  if (!error || !['PAGE_UNAVAILABLE', 'DOCUMENT_NOT_CONTROLLABLE', 'TARGET_STALE', 'WAIT_TIMEOUT'].includes(error.code) ||
      !['tab_status', 'document_injection', 'document_state', 'document_changed', 'content_readiness'].includes(error.inspection_stage)) return {};
  const result: Wire = { inspection_stage: error.inspection_stage };
  if (['permission_denied', 'browser_restricted', 'frame_unavailable', 'helper_execution_failed',
    'empty_result', 'unknown'].includes(error.injection_reason)) result.injection_reason = error.injection_reason;
  if (['PAGE_UNAVAILABLE', 'TARGET_STALE', ...(error.inspection_stage === 'content_readiness' ? READINESS_ERRORS : [])].includes(error.last_error) &&
      Number.isSafeInteger(error.timeout_ms) && error.timeout_ms >= 0 && error.timeout_ms <= PAGE_WAIT_MS) {
    result.last_error = error.last_error;
    result.timeout_ms = error.timeout_ms;
  }
  return result;
}
const STALE_REASONS = ['document_changed', 'ref_from_other_document', 'ref_superseded', 'element_detached'];
const DOCUMENT_NONCE = /^[0-9a-f]{8,128}$/;
const boundedInteger = (value: unknown, maximum: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
/** Whitelisted, value-free error details that help an agent recover without leaking page data. */
export function errorDetails(error: unknown): Wire {
  if (!error || typeof error !== 'object') return {};
  const e = error as Wire, result: Wire = {};
  if (['ELEMENT_STALE', 'TARGET_STALE'].includes(e.code) && STALE_REASONS.includes(e.stale_reason)) {
    result.stale_reason = e.stale_reason;
    for (const key of ['snapshot_document', 'current_document']) {
      if (typeof e[key] === 'string' && DOCUMENT_NONCE.test(e[key])) result[key] = e[key];
    }
  }
  if (['RESULT_TOO_LARGE', 'INVALID_RESULT'].includes(e.code) &&
      boundedInteger(e.actual_bytes, 2 ** 40) && boundedInteger(e.limit_bytes, 2 ** 40)) {
    result.actual_bytes = e.actual_bytes;
    result.limit_bytes = e.limit_bytes;
  }
  if (['SCRIPT_SYNTAX_ERROR', 'SCRIPT_RUNTIME_ERROR'].includes(e.code)) {
    if (boundedInteger(e.line, 10_000_000) && e.line > 0) result.line = e.line;
    if (boundedInteger(e.column, 10_000_000) && e.column > 0) result.column = e.column;
    if (typeof e.snippet === 'string' && e.snippet.length <= 300) result.snippet = e.snippet;
  }
  if (e.code === 'CAPABILITY_UNAVAILABLE' && typeof e.required_extension_version === 'string' &&
      /^[0-9]+(?:\.[0-9]+){0,3}$/.test(e.required_extension_version)) {
    result.required_extension_version = e.required_extension_version;
  }
  return result;
}
export function waitErrorDetails(error: Wire | null | undefined): Wire {
  const contentReadiness = error?.readiness_stage === 'content_readiness';
  const causes = contentReadiness ? [...READINESS_ERRORS, 'PAGE_UNAVAILABLE', 'TARGET_STALE'] : READINESS_ERRORS;
  const codes = contentReadiness ? ['WAIT_TIMEOUT', ...causes] : ['WAIT_TIMEOUT'];
  if (!error || !codes.includes(error.code) || !causes.includes(error.last_error) ||
      !Number.isSafeInteger(error.timeout_ms) || error.timeout_ms < (contentReadiness ? 0 : 1) ||
      error.timeout_ms > PAGE_WAIT_MS) return {};
  return { last_error: error.last_error, timeout_ms: error.timeout_ms,
    ...(contentReadiness ? { readiness_stage: 'content_readiness' } : {}) };
}
const output: Record<string, FieldSchema> = { max_output_bytes: { type: 'integer', minimum: 1024, maximum: MAX_OUTPUT_BYTES,
  default: DEFAULT_OUTPUT_BYTES, description: 'Maximum UTF-8 bytes for the serialized MCP result, including its text-content wrapper. Default 16 KiB; hard maximum 64 KiB. Narrow the request before increasing.' } };
const readText: Record<string, FieldSchema> = { max_text_chars: { type: 'integer', minimum: 0, maximum: MAX_TEXT_CHARS,
  default: DEFAULT_TEXT_CHARS, description: 'Maximum returned text characters; default 4000. Truncation is explicit. Prefer a focused selector.' } };
const readElements: Record<string, FieldSchema> = { max_elements: { type: 'integer', minimum: 1, maximum: MAX_ELEMENTS,
  default: DEFAULT_ELEMENTS, description: 'Maximum returned elements; default 50. Truncation is explicit.' } };
const target: Record<'selector' | 'ref' | 'document', FieldSchema> = {
  selector: { type: 'string', minLength: 1, maxLength: 4096 },
  ref: { type: 'string', pattern: '^e[1-9][0-9]{0,8}(?![\\s\\S])' },
  document: { type: 'string', minLength: 8, maxLength: 128 },
};
const timeout: Record<string, FieldSchema> = { timeout_ms: { type: 'integer', minimum: 0, maximum: PAGE_WAIT_MS,
  description: 'Page/element readiness wait, not a human wait. Element actions default to 3000 ms; wait_for_page defaults to 10000 ms. Use 0 for immediate selector probes. An exhausted positive wait returns WAIT_TIMEOUT; last_error identifies the last element-readiness cause.' } };
const targeted = { ...target, ...timeout };
const text: FieldSchema = { type: 'string', maxLength: 65_536 };
const operation = (properties: Record<string, FieldSchema>, required: string[] = [], needsTarget = false): OperationSpec => ({
  properties, required, ...(needsTarget ? {
    anyOf: [{ required: ['selector'] }, { required: ['ref', 'document'] }],
  } : {}),
});
export const OPERATION_SCHEMAS: Readonly<Record<string, OperationSpec>> = Object.freeze({
  navigate: operation({ url: { type: 'string', minLength: 1, maxLength: 8192 } }, ['url']),
  click: operation(targeted, [], true),
  inspect_element: operation({ ...target,
    max_output_bytes: { ...output.max_output_bytes!, default: 4096, maximum: 4096,
      description: 'Inspector JSON result budget; default and hard maximum 4096 UTF-8 bytes.' },
  }, [], true),
  type_text: operation({ ...targeted, text }, ['text'], true),
  get_text: operation({ ...targeted, ...readText, ...output }),
  evaluate_script: operation({ script: { ...text, minLength: 1,
    description: 'JavaScript evaluated in the page. The value of the final expression statement is returned (promises are awaited). Top-level await and top-level return are supported. Maximum 65536 UTF-16 code units. Page CSP may refuse evaluation.' },
    world: { type: 'string', enum: ['MAIN', 'USER_SCRIPT'], default: 'MAIN',
      description: 'Execution world. MAIN (default) sees page globals such as framework state; USER_SCRIPT requires native browser support and local enablement, never an isolated-world fallback.' },
    return_as: { type: 'string', enum: ['value', 'artifact'], default: 'value',
      description: 'value: return the JSON result inline (16 KiB default, 64 KiB hard cap). artifact: store the full result (up to ~8 MiB) on the DomAgent service and return only a handle with bytes, sha256, a preview and a download_url. Use artifact for bulk data; never transcribe large results through the conversation.' },
    artifact_name: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?![\\s\\S])',
      description: 'Optional file name for return_as:"artifact", e.g. activities.json.' },
    artifact_mime: { type: 'string', enum: ARTIFACT_MIME_TYPES,
      description: 'Optional media type for return_as:"artifact". Defaults to application/json for non-string results and text/plain for strings.' },
    artifact_encoding: { type: 'string', enum: ['utf8', 'base64'], default: 'utf8',
      description: 'For string results with return_as:"artifact": base64 stores the decoded bytes (for binary data such as gzip or images).' },
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
export const OPERATIONS: readonly string[] = Object.freeze(Object.keys(OPERATION_SCHEMAS));
export const HANDOFF_SCHEMA = operation({
  instructions: { type: 'string', minLength: 1, maxLength: 2000, unit: 'unicode_code_points',
    description: 'What the person should do in this tab. Plain text, maximum 2000 Unicode code points.' },
}, ['instructions']);
export const DESCRIPTION_SCHEMA: Readonly<FieldSchema> = Object.freeze({ type: 'string', minLength: MIN_DESCRIPTION_LENGTH,
  maxLength: 500, unit: 'unicode_code_points', trimMinimum: true });
const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![\\s\\S])';

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length]!;
}
function closestKey(key: string, allowed: string[]): string | null {
  let best: string | null = null, distance = Infinity;
  for (const candidate of allowed) {
    const score = editDistance(key.toLowerCase(), candidate.toLowerCase());
    if (score < distance) { best = candidate; distance = score; }
  }
  return distance <= Math.max(2, Math.floor(key.length / 3)) ? best : null;
}

export function schemaArgumentErrors(spec: OperationSpec | undefined, args: unknown): ArgumentError[] {
  if (!spec || !args || typeof args !== 'object' || Array.isArray(args)) {
    return [{ field: 'arguments', reason: 'expected_object' }];
  }
  const input = args as Wire;
  const errors: ArgumentError[] = [];
  const allowed = Object.keys(spec.properties);
  for (const key of Object.keys(args).filter(key => !Object.hasOwn(spec.properties, key)).slice(0, 8)) {
    // Field names are caller-supplied; bound them, but never echo values.
    const field = key.slice(0, 64);
    const suggestion = closestKey(field, allowed);
    errors.push({ field, reason: 'unexpected_field', allowed, ...(suggestion ? { did_you_mean: suggestion } : {}) });
  }
  for (const key of spec.required || []) {
    if (!Object.hasOwn(args, key)) errors.push({ field: key, reason: 'required' });
  }
  for (const [key, field] of Object.entries(spec.properties)) {
    if (!Object.hasOwn(args, key)) continue;
    const value = input[key];
    if (field.type === 'integer') {
      if (!Number.isSafeInteger(value)) errors.push({ field: key, reason: 'expected_integer' });
      else if (value < field.minimum! || value > field.maximum!) errors.push({
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
    if (input.ref !== undefined && input.document === undefined) errors.push({ field: 'document', reason: 'required_with_ref' });
    if (input.ref !== undefined && input.selector !== undefined) errors.push({ field: 'selector', reason: 'conflicts_with_ref' });
    if (input.document !== undefined && input.ref === undefined && input.selector === undefined) {
      errors.push({ field: 'document', reason: 'requires_ref_or_selector' });
    }
  }
  if (spec.anyOf && !spec.anyOf.some(choice => choice.required.every(key => Object.hasOwn(args, key)))) {
    errors.push({ field: 'selector', reason: 'required_selector_or_ref_document' });
  }
  return errors;
}
export function operationArgumentErrors(name: string, args: unknown): ArgumentError[] {
  return schemaArgumentErrors(name === 'request_handoff' ? HANDOFF_SCHEMA : OPERATION_SCHEMAS[name], args);
}
export function validOperationArgs(name: string, args: unknown): boolean {
  return operationArgumentErrors(name, args).length === 0;
}

export function validName(value: unknown, max = 80): value is string {
  // eslint-disable-next-line no-control-regex -- rejects control characters on purpose
  return typeof value === 'string' && value.trim().length > 0 && [...value].length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

export function serviceOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search ||
      url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('INVALID_SERVICE_ORIGIN');
  }
  return url.origin;
}

export function extensionOrigin(value: string): string {
  if (!/^(chrome-extension:\/\/[a-p]{32}|moz-extension:\/\/[a-f0-9-]{36})$/i.test(value)) {
    throw new Error('INVALID_EXTENSION_ORIGIN');
  }
  return value;
}

export function encode(value: unknown): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(value));
}

export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function unbase64url(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(value) || value.length > 1024) {
    throw new Error('INVALID_SIGNATURE');
  }
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
}

export async function keyId(jwk: Wire | null | undefined): Promise<string> {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || Object.hasOwn(jwk, 'd') ||
      typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new Error('INVALID_PUBLIC_KEY');
  }
  return base64url(await crypto.subtle.digest('SHA-256', encode([jwk.kty, jwk.crv, jwk.x, jwk.y])));
}

// Domain-separated proof transcripts. Each binds the service origin and a fresh server nonce.
export function registerPayload(c: Wire): Uint8Array<ArrayBuffer> {
  return encode(['domagent.v6', 'register', c.origin, c.nonce, c.key_id, c.extension_origin, c.name]);
}

export function tokenPayload(c: Wire): Uint8Array<ArrayBuffer> {
  return encode(['domagent.v6', 'token', c.origin, c.nonce, c.browser_id, c.key_id]);
}

export function connectPayload(c: Wire): Uint8Array<ArrayBuffer> {
  return encode(['domagent.v6', 'connect', c.origin, c.nonce, c.browser_id, c.connection_id]);
}

export function normalizePairingCode(value: unknown): string {
  if (typeof value !== 'string' || value.length > 16) throw new Error('PAIRING_UNAVAILABLE');
  const code = value.toUpperCase().replaceAll('-', '').replaceAll(' ', '');
  if (!/^[0-9A-HJKMNP-TV-Z]{8}$/.test(code)) throw new Error('PAIRING_UNAVAILABLE');
  return code;
}

export function pairingCode(random: (n: number) => Iterable<number> = n => crypto.getRandomValues(new Uint8Array(n))): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const code = [...random(8)].map(value => alphabet[value % 32]).join('');
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export async function sign(key: Parameters<typeof crypto.subtle.sign>[1], payload: Uint8Array<ArrayBuffer>): Promise<string> {
  return base64url(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, payload));
}

export async function verify(jwk: Wire, payload: Uint8Array<ArrayBuffer>, signature: unknown): Promise<boolean> {
  const publicKey = await crypto.subtle.importKey('jwk',
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' },
    publicKey, unbase64url(signature), payload);
}

export function navigationUrl(value: string, protectedOrigins: readonly string[]): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      protectedOrigins.includes(url.origin)) {
    throw new Error('HANDOFF_REQUIRED');
  }
  return url.href;
}
