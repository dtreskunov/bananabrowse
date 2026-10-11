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

export function failureCode(error) {
  return error instanceof Fault ? error.code : 'INTERNAL_ERROR';
}

const FIELDS = new Set([
  'tenant_id', 'owner_id', 'device_id', 'client_id', 'target_id', 'request_id',
  'operation', 'code', 'duration_ms', 'close_code',
]);

export function audit(event, fields = {}) {
  const metadata = Object.fromEntries(Object.entries(fields).filter(([key]) => FIELDS.has(key)));
  process.stdout.write(`${JSON.stringify({ event, ...metadata })}\n`);
}
