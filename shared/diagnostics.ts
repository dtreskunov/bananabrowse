import type { Wire } from './protocol.js';

const LIMITS = Object.freeze({ depth: 6, entries: 128, array: 32, string: 4096, stack: 16384, total: 24576 });
const REDACTED = '[redacted]';
const PRIVATE_KEY = /(?:authorization|authentication|proxyauthorization|cookie|credential|password|passwd|secret|token|apikey|sessionid|clientkey|privatekey)/i;
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const nativeStackGetter = Object.getOwnPropertyDescriptor(new Error(), 'stack')?.get ||
  Object.getOwnPropertyDescriptor(Error.prototype, 'stack')?.get;

function redact(value: string): string {
  return value
    .replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/gi, raw => {
      try {
        const url = new URL(raw);
        if (url.username || url.password) { url.username = 'redacted'; url.password = ''; }
        // Query values and fragments can contain credentials under arbitrary names.
        for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, REDACTED);
        if (url.hash) url.hash = REDACTED;
        url.pathname = url.pathname.replace(/\/(token|secret|password|apikey|api-key)\/[^/]+/gi, '/$1/redacted');
        return url.href;
      } catch { return '[redacted URL]'; }
    })
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '$1 [redacted]')
    .replace(/\b((?:proxy-)?authorization|(?:set-)?cookie)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\r\n]+)/gi, '$1: [redacted]')
    .replace(/(["']?(?:password|passwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|credential)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
      '$1[redacted]');
}

function dataProperty(input: unknown, key: string): unknown {
  let current = input;
  for (let depth = 0; current && depth < 4; depth++, current = Object.getPrototypeOf(current)) {
    const property = Object.getOwnPropertyDescriptor(current, key);
    if (property) {
      if (Object.hasOwn(property, 'value')) return property.value;
      // V8 exposes lazy Error stacks as a native accessor; arbitrary getters stay uncalled.
      if (key === 'stack' && input instanceof Error && nativeStackGetter && property.get === nativeStackGetter) {
        return nativeStackGetter.call(input);
      }
      return undefined;
    }
  }
  return undefined;
}

/** Sanitize untrusted browser/native diagnostics without evaluating getters or retaining references. */
export function sanitizeDiagnostics(input: unknown): Wire | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const ancestors = new WeakSet<object>(), reasons = new Set<string>();
  let entries = 0, remaining = LIMITS.total;
  const truncated = (reason: string) => { reasons.add(reason); return `[truncated:${reason}]`; };
  const string = (value: string, key: string) => {
    // Redact before clipping, so clipping cannot expose part of a credential.
    const safe = redact(value), limit = Math.min(key === 'stack' ? LIMITS.stack : LIMITS.string, remaining);
    remaining -= Math.min(safe.length, limit);
    if (safe.length <= limit) return safe;
    reasons.add(remaining === 0 ? 'total' : 'string');
    return `${safe.slice(0, limit)}[truncated]`;
  };
  const visit = (value: unknown, depth: number, key = ''): unknown => {
    if (PRIVATE_KEY.test(key.replace(/[^a-z0-9]/gi, ''))) return REDACTED;
    if (typeof value === 'string') return string(value, key);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
    if (typeof value !== 'object') return undefined;
    if (ancestors.has(value)) { reasons.add('cycle'); return '[circular]'; }
    if (depth > LIMITS.depth) return truncated('depth');
    if (remaining <= 0) return truncated('total');
    ancestors.add(value);
    const result: unknown[] | Wire = Array.isArray(value) ? [] : {};
    const headerName = dataProperty(value, 'name') || dataProperty(value, 'header');
    const privateHeader = typeof headerName === 'string' && PRIVATE_KEY.test(headerName.replace(/[^a-z0-9]/gi, ''));
    const keys = value instanceof Error
      ? [...new Set(['name', 'message', 'stack', 'cause', ...Object.keys(value)])] : Object.keys(value);
    let count = 0;
    for (const childKey of keys) {
      if (UNSAFE_KEYS.has(childKey)) continue;
      if (entries >= LIMITS.entries || (Array.isArray(value) && count >= LIMITS.array)) {
        reasons.add('entries'); break;
      }
      if (remaining <= 0) { reasons.add('total'); break; }
      if (childKey.length > 128) { reasons.add('key'); continue; }
      entries++; count++;
      const child = privateHeader && childKey === 'value' ? REDACTED : visit(dataProperty(value, childKey), depth + 1, childKey);
      if (child === undefined) continue;
      if (Array.isArray(result)) result.push(child);
      else result[childKey] = child;
    }
    ancestors.delete(value);
    return result;
  };
  try {
    const result = visit(input, 0) as Wire;
    if (reasons.size) { result.truncated = true; result.truncation_reasons = [...reasons]; }
    return Object.keys(result).length ? result : undefined;
  } catch {
    // Host objects/proxies are not allowed to turn diagnostic projection into a failure.
    return { truncated: true, truncation_reasons: ['unreadable'] };
  }
}

/** Return a result-error spread, preferring diagnostics already supplied by the browser. */
export function diagnosticDetails(error: unknown, context: Wire = {}): { diagnostics: Wire } {
  let source: Wire;
  try {
    source = dataProperty(error, 'diagnostics') as Wire;
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      source = { name: dataProperty(error, 'name') || 'Error',
        message: dataProperty(error, 'message') || dataProperty(error, 'code') || 'Browser execution failed',
        stack: dataProperty(error, 'stack') };
      for (const key of ['cause', 'exception', 'details', 'native', 'browser', 'fileName', 'lineNumber', 'columnNumber']) {
        const value = dataProperty(error, key);
        if (value !== undefined) source[key] = value;
      }
      for (const key of Object.keys(error ?? {}).slice(0, LIMITS.entries)) {
        if (key === 'diagnostics' || UNSAFE_KEYS.has(key)) continue;
        const value = dataProperty(error, key);
        if (value !== undefined) source[key] = value;
      }
    }
  } catch { source = { name: 'Error', message: 'Browser execution failed' }; }
  const diagnostics = sanitizeDiagnostics(source) || {};
  const safeContext = sanitizeDiagnostics(context) || {};
  return { diagnostics: sanitizeDiagnostics({ ...safeContext, ...diagnostics }) || {} };
}

const AGENT_FIELDS = Object.freeze(['name', 'message', 'layer', 'phase', 'execution_world']);
/**
 * Compact projection for MCP callers: error name and message only. Stack traces, native
 * exception objects and causes cost thousands of tokens and rarely help an agent recover;
 * actionable locations are reported separately as line/column/snippet.
 */
export function agentDiagnostics(input: unknown): Wire | undefined {
  const safe = sanitizeDiagnostics(input);
  if (!safe) return undefined;
  const result: Wire = {};
  for (const key of AGENT_FIELDS) {
    if (typeof safe[key] !== 'string' || !safe[key]) continue;
    result[key] = safe[key].length > 500 ? `${safe[key].slice(0, 500)}[truncated]` : safe[key];
  }
  return Object.keys(result).length ? result : undefined;
}
