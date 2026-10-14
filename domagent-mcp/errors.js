import { inspectionErrorDetails } from '../shared/protocol.js';

export class Fault extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function requireValue(condition, code, status = 400) {
  if (!condition) throw new Fault(code, status);
}

export function requireArguments(argumentErrors) {
  if (argumentErrors.length) throw Object.assign(new Fault('INVALID_ARGUMENTS'), {
    phase: 'validation', dispatch_status: 'not_dispatched', argument_errors: argumentErrors,
  });
}

export function validationDetails(error) {
  if (error?.code !== 'INVALID_ARGUMENTS' || error.phase !== 'validation' ||
      error.dispatch_status !== 'not_dispatched' || !Array.isArray(error.argument_errors)) return {};
  return { phase: 'validation', dispatch_status: 'not_dispatched', argument_errors: error.argument_errors };
}

export function dispatchDetails(error) {
  return error?.dispatch_status === 'not_dispatched' ? { dispatch_status: 'not_dispatched' } : {};
}

export function failureCode(error) {
  return error instanceof Fault ? error.code : 'INTERNAL_ERROR';
}

const FIELDS = new Set([
  'browser_id', 'agent_id', 'session_id', 'tab_id', 'request_id',
  'operation', 'code', 'duration_ms', 'close_code',
]);

export function audit(event, fields = {}) {
  const metadata = Object.fromEntries(Object.entries(fields).filter(([key]) => FIELDS.has(key)));
  Object.assign(metadata, inspectionErrorDetails(fields));
  process.stdout.write(`${JSON.stringify({ event, ...metadata })}\n`);
}
