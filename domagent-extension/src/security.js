import { EXECUTION_MS, HUMAN_WAIT_MS, OPERATIONS, navigationUrl, serviceOrigin, validOperationArgs } from '../../shared/protocol.js';

export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
export const MAX_RESULT_BYTES = MAX_MESSAGE_BYTES - 4096;
export const MAX_QUEUE = 16;
export const COMMAND_TIMEOUT_MS = EXECUTION_MS;

export function fail(code) {
  throw Object.assign(new Error(code), { code });
}

export function text(value, max = 256) {
  if (typeof value !== 'string' || !value.length || value.length > max) fail('INVALID_MESSAGE');
  return value;
}

export function id(value) {
  text(value, 128);
  if (!/^[a-zA-Z0-9_.:-]+$/.test(value)) fail('INVALID_MESSAGE');
  return value;
}

export function originList(values) {
  if (!Array.isArray(values) || values.length > 128) fail('INVALID_MESSAGE');
  return [...new Set(values.map(value => {
    const url = new URL(text(value, 2048));
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
        url.search || url.hash || url.pathname !== '/') fail('INVALID_ORIGIN');
    return url.origin;
  }))];
}

export function protectedUnion(origin, ...lists) {
  return [...new Set([serviceOrigin(origin), ...lists.flatMap(originList)])];
}

export function isUiSender(sender, runtime) {
  if (sender?.id !== runtime.id || (sender.frameId !== undefined && sender.frameId !== 0)) return false;
  try {
    const url = new URL(sender.url);
    url.search = '';
    url.hash = '';
    return ['options.html', 'popup.html', 'request.html', 'panel.html'].some(page => url.href === runtime.getURL(page));
  } catch { return false; }
}

export function needsSetup(reason, identity) {
  return reason === 'install' && !identity;
}

export function localDeadline(message, field, limit, now) {
  if (!Number.isSafeInteger(message.expires_at) || message.expires_at <= 0) fail('INVALID_MESSAGE');
  const duration = message[field];
  if (duration === undefined) return message.expires_at;
  if (!Number.isSafeInteger(duration) || duration <= 0 || duration > limit) fail('INVALID_MESSAGE');
  return now + duration;
}

export function checkBinding(message, connection) {
  if (!connection || message.epoch !== connection.epoch ||
      !connection.tenant_id || message.tenant_id !== connection.tenant_id ||
      message.connection_id !== connection.connection_id) fail('NOT_AUTHORIZED');
}

export function validateCommand(message, grant, connection, protectedOrigins, now = Date.now()) {
  id(message.request_id);
  id(message.target_id);
  id(message.client_id);
  checkBinding(message, connection);
  if (!grant || grant.state !== 'active' || grant.target_id !== message.target_id ||
      grant.client_id !== message.client_id || grant.epoch !== message.epoch ||
      grant.tenant_id !== message.tenant_id ||
      grant.connection_id !== message.connection_id) fail('APPROVAL_REQUIRED');
  if (!Number.isSafeInteger(message.expires_at) || message.expires_at <= 0) fail('INVALID_ARGUMENT');
  if (message.expires_at <= now) fail('COMMAND_EXPIRED');
  if (message.expires_at > now + HUMAN_WAIT_MS) fail('INVALID_ARGUMENT');
  text(message.description, 4096);
  if (message.operation !== 'request_handoff' && (!OPERATIONS.includes(message.operation) ||
      !grant.capabilities.includes(message.operation))) fail('CAPABILITY_UNAVAILABLE');
  const args = message.args;
  if (!validOperationArgs(message.operation, args)) fail('INVALID_ARGUMENT');
  if (message.operation === 'navigate') navigationUrl(text(args.url, 8192), protectedOrigins);
  return args;
}

export function errorCode(error) {
  const known = [
    'INVALID_MESSAGE', 'INVALID_ARGUMENT', 'INVALID_ORIGIN', 'INVALID_SERVICE_ORIGIN',
    'NOT_AUTHORIZED', 'APPROVAL_REQUIRED', 'BROWSER_OFFLINE', 'TARGET_STALE',
    'CAPABILITY_UNAVAILABLE', 'HANDOFF_REQUIRED', 'OUTCOME_UNKNOWN', 'QUEUE_FULL',
    'ELEMENT_NOT_FOUND', 'INVALID_SELECTOR', 'PAGE_UNAVAILABLE',
    'RESULT_TOO_LARGE', 'ENROLLMENT_EXPIRED', 'COMMAND_EXPIRED',
    'PERMISSION_REQUIRED', 'PROTECTION_UNAVAILABLE', 'INVALID_TENANT', 'INVALID_CONNECTION_LINK',
    'INDICATOR_UNAVAILABLE', 'ACTION_DECLINED', 'COMMAND_CANCELLED',
    'ELEMENT_AMBIGUOUS', 'ELEMENT_STALE', 'ELEMENT_DISABLED', 'ELEMENT_READONLY',
    'ELEMENT_NOT_VISIBLE', 'ELEMENT_OBSCURED', 'ELEMENT_NOT_EDITABLE', 'OPTION_NOT_FOUND', 'WAIT_TIMEOUT',
    'OPERATION_FAILED',
    'SCRIPT_POLICY_BLOCKED', 'SCRIPT_SYNTAX_ERROR', 'SCRIPT_RUNTIME_ERROR',
    'SCRIPT_SERIALIZATION_ERROR', 'SCRIPT_EXECUTION_UNAVAILABLE', 'INVALID_RESULT',
    'WORKSPACE_CHANGED', 'PANEL_OPEN_REQUIRED',
    'HISTORY_UNAVAILABLE',
  ];
  return known.includes(error?.code || error?.message) ? error.code || error.message : 'OUTCOME_UNKNOWN';
}

export function boundedResult(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || new TextEncoder().encode(serialized).length > MAX_RESULT_BYTES) {
    fail('RESULT_TOO_LARGE');
  }
  return JSON.parse(serialized);
}

// Anchor the complete origin, not a hostname substring or a suffix.
export function protectedRegex(value) {
  const url = new URL(value);
  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const defaultPort = url.protocol === 'https:' ? '443' : '80';
  return `^${escape(url.protocol)}//(?:[^/@]*@)?${escape(url.hostname)}${url.port ? `:${url.port}` : `(?::${defaultPort})?`}(?:/|$)`;
}
