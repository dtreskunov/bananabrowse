import { EXECUTION_MS, serviceOrigin } from '../../shared/protocol.js';

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
    'PLATFORM_UNSUPPORTED', 'WORKSPACE_PAUSED', 'WORKSPACE_INACTIVE', 'TAB_NOT_IN_WORKSPACE',
    'DOCUMENT_NOT_CONTROLLABLE', 'TAB_LIMIT_REACHED', 'NOTIFICATION_UNAVAILABLE',
    'PAIRING_UNAVAILABLE', 'PAIRING_CODE_COLLISION', 'RATE_LIMITED',
    'UPGRADE_REQUIRED', 'WORKSPACE_LIMIT',
    'GROUP_UNAVAILABLE', 'SESSION_DETACHED', 'SESSION_ENDED', 'TAB_NOT_IN_SESSION', 'BROWSER_REVOKED',
    'INVALID_SERVICE', 'SERVICE_UNREACHABLE', 'ALREADY_OPEN', 'CLIPBOARD_UNAVAILABLE', 'ACTION_EXPIRED',
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
