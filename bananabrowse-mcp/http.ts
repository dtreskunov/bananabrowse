import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Wire } from '../shared/protocol.js';
import { Fault, requireValue } from './errors.js';

export async function readBody(req: IncomingMessage, limit = 262144): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    requireValue(size <= limit, 'PAYLOAD_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function body(req: IncomingMessage, limit = 262144): Promise<Wire> {
  const text = await readBody(req, limit);
  requireValue(req.headers['content-type']?.split(';')[0] === 'application/json', 'CONTENT_TYPE_REQUIRED', 415);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Fault('INVALID_JSON');
  }
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_JSON');
  return value as Wire;
}

export function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}
