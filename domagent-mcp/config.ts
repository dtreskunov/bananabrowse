import { readFileSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AGENT_ID_PATTERN, serviceOrigin, validName } from '../shared/protocol.js';
import { Fault, requireValue } from './errors.js';

type Env = Record<string, string | undefined>;
export interface Agent { id: string; name: string; url: string | null; key_hash: string }
export interface Config {
  origin: string; bind: string; port: number; db: string; artifacts?: string | null;
  protectedOrigins: string[]; agents: Map<string, Agent>; pairingSecret: string | null;
  now?: () => number;
}

function secret(env: Env, name: string): string | null {
  requireValue(!(env[name] && env[`${name}_FILE`]), 'SECRET_CONFIG_AMBIGUOUS');
  if (env[`${name}_FILE`]) {
    const stat = lstatSync(env[`${name}_FILE`]!);
    requireValue(stat.isFile() && (stat.mode & 0o077) === 0, 'SECRET_FILE_PERMISSIONS');
    const value = readFileSync(env[`${name}_FILE`]!, 'utf8').trim();
    requireValue(value.length >= 32 && value.length <= 4096, 'WEAK_SECRET');
    return value;
  }
  const value = env[name] || undefined;
  requireValue(value === undefined || (value.length >= 32 && value.length <= 4096), 'WEAK_SECRET');
  return value || null;
}

export function agentIdFromVariable(name: string): string {
  return name.slice('DOMAGENT_AGENT_'.length).toLowerCase().replaceAll('_', '-');
}

/** Parses `DOMAGENT_AGENT_<ID>="Name|https://homepage|sha256:<hex>"` entries. */
export function parseAgents(env: Env): Map<string, Agent> {
  const agents = new Map<string, Agent>();
  for (const [variable, raw] of Object.entries(env)) {
    if (!variable.startsWith('DOMAGENT_AGENT_')) continue;
    const id = agentIdFromVariable(variable);
    requireValue(AGENT_ID_PATTERN.test(id), 'INVALID_AGENT_ID');
    const parts = String(raw).split('|');
    requireValue(parts.length === 3, 'INVALID_AGENT_CONFIG');
    const [name, homepage, digest] = parts.map(part => part.trim());
    requireValue(validName(name), 'INVALID_AGENT_CONFIG');
    let url: string | null = null;
    if (homepage) {
      try {
        const parsed = new URL(homepage);
        requireValue(['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password, 'INVALID_AGENT_CONFIG');
        url = parsed.href;
      } catch (error) {
        if (error instanceof Fault) throw error;
        throw new Fault('INVALID_AGENT_CONFIG');
      }
    }
    const match = /^sha256:([0-9a-f]{64})$/.exec(digest!);
    requireValue(match, 'INVALID_AGENT_CONFIG');
    requireValue(!agents.has(id), 'DUPLICATE_AGENT_ID');
    agents.set(id, { id, name, url, key_hash: match[1]! });
  }
  return agents;
}

export function loadConfig(env: Env = process.env): Config {
  requireValue(Boolean(env.DOMAGENT_ORIGIN), 'SERVICE_ORIGIN_REQUIRED');
  let origin: string;
  try { origin = serviceOrigin(env.DOMAGENT_ORIGIN!); }
  catch { throw new Fault('INVALID_SERVICE_ORIGIN'); }
  const port = Number(env.DOMAGENT_PORT || 18792);
  requireValue(Number.isInteger(port) && port > 0 && port <= 65535, 'INVALID_PORT');
  const protectedOrigins = [origin];
  try {
    protectedOrigins.push(...(env.DOMAGENT_PROTECTED_ORIGINS || '').split(',').map(value => value.trim())
      .filter(Boolean).map(value => new URL(value).origin));
  } catch { throw new Fault('INVALID_PROTECTED_ORIGIN'); }
  const db = env.DOMAGENT_DB || './data/domagent.db';
  const artifacts = env.DOMAGENT_ARTIFACTS_DIR || (db === ':memory:' ? null : join(dirname(db), 'artifacts'));
  return { origin, bind: env.DOMAGENT_BIND || '127.0.0.1', port,
    db, artifacts, protectedOrigins: [...new Set(protectedOrigins)],
    agents: parseAgents(env), pairingSecret: secret(env, 'DOMAGENT_PAIRING_SECRET') };
}
