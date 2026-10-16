import { inspectionErrorDetails, type ArgumentError, type Wire } from '../shared/protocol.js';

export class Fault extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function requireValue(condition: unknown, code: string, status = 400): asserts condition {
  if (!condition) throw new Fault(code, status);
}

export function requireArguments(argumentErrors: ArgumentError[]): void {
  if (argumentErrors.length)
    throw Object.assign(new Fault('INVALID_ARGUMENTS'), {
      phase: 'validation',
      dispatch_status: 'not_dispatched',
      argument_errors: argumentErrors,
    });
}

export function validationDetails(error: unknown): Wire {
  const e = error as Wire | null | undefined;
  if (
    e?.code !== 'INVALID_ARGUMENTS' ||
    e.phase !== 'validation' ||
    e.dispatch_status !== 'not_dispatched' ||
    !Array.isArray(e.argument_errors)
  )
    return {};
  return { phase: 'validation', dispatch_status: 'not_dispatched', argument_errors: e.argument_errors };
}

export function dispatchDetails(error: unknown): Wire {
  return (error as Wire | null | undefined)?.dispatch_status === 'not_dispatched'
    ? { dispatch_status: 'not_dispatched' }
    : {};
}

export function failureCode(error: unknown): string {
  return error instanceof Fault ? error.code : 'INTERNAL_ERROR';
}

const FIELDS = new Set([
  'browser_id',
  'agent_id',
  'session_id',
  'tab_id',
  'request_id',
  'operation',
  'code',
  'duration_ms',
  'close_code',
]);

export function audit(event: string, fields: Wire = {}): void {
  const metadata = Object.fromEntries(Object.entries(fields).filter(([key]) => FIELDS.has(key)));
  Object.assign(metadata, inspectionErrorDetails(fields));
  process.stdout.write(`${JSON.stringify({ event, ...metadata })}\n`);
}
