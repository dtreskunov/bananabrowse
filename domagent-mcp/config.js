import { readFileSync, lstatSync } from 'node:fs';
import { serviceOrigin } from '../shared/protocol.js';
import { Fault, requireValue } from './errors.js';

function secret(env, name) {
  requireValue(!(env[name] && env[`${name}_FILE`]), 'SECRET_CONFIG_AMBIGUOUS');
  if (env[`${name}_FILE`]) {
    const stat = lstatSync(env[`${name}_FILE`]);
    requireValue(stat.isFile() && (stat.mode & 0o077) === 0, 'SECRET_FILE_PERMISSIONS');
    const value = readFileSync(env[`${name}_FILE`], 'utf8').trim();
    requireValue(value.length >= 32 && value.length <= 4096, 'WEAK_SECRET');
    return value;
  }
  const value = env[name] || undefined;
  requireValue(value === undefined || (value.length >= 32 && value.length <= 4096), 'WEAK_SECRET');
  return value || null;
}
export function loadConfig(env = process.env) {
  requireValue(Boolean(env.DOMAGENT_ORIGIN), 'SERVICE_ORIGIN_REQUIRED');
  let origin;
  try { origin = serviceOrigin(env.DOMAGENT_ORIGIN); }
  catch { throw new Fault('INVALID_SERVICE_ORIGIN'); }
  const port = Number(env.DOMAGENT_PORT || 18792);
  requireValue(Number.isInteger(port) && port > 0 && port <= 65535, 'INVALID_PORT');
  const protectedOrigins = [origin];
  // Preserve former control-plane origins even though OIDC is no longer an auth system.
  try {
    if (env.DOMAGENT_OIDC_ISSUER) protectedOrigins.push(new URL(env.DOMAGENT_OIDC_ISSUER).origin);
    protectedOrigins.push(...(env.DOMAGENT_PROTECTED_ORIGINS || '').split(',').filter(Boolean).map(serviceOrigin));
  } catch { throw new Fault('INVALID_PROTECTED_ORIGIN'); }
  secret(env, 'DOMAGENT_OPERATOR_SECRET');
  const pairingSecret = secret(env, 'DOMAGENT_PAIRING_SECRET');
  return { origin, bind: env.DOMAGENT_BIND || '127.0.0.1', port,
    db: env.DOMAGENT_DB || './data/domagent.db', protectedOrigins: [...new Set(protectedOrigins)],
    operatorSecret: () => secret(env, 'DOMAGENT_OPERATOR_SECRET'), pairingSecret };
}
