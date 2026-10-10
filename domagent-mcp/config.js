import { readFileSync } from 'node:fs';
import { serviceOrigin } from '../shared/protocol.js';
import { Fault, requireValue } from './errors.js';

export function loadConfig(env = process.env) {
  requireValue(Boolean(env.DOMAGENT_ORIGIN), 'SERVICE_ORIGIN_REQUIRED');
  requireValue(Boolean(env.DOMAGENT_OIDC_ISSUER), 'OIDC_ISSUER_REQUIRED');
  let origin;
  let issuer;
  try { origin = serviceOrigin(env.DOMAGENT_ORIGIN); }
  catch { throw new Fault('INVALID_SERVICE_ORIGIN'); }
  try { issuer = new URL(env.DOMAGENT_OIDC_ISSUER); }
  catch { throw new Fault('INVALID_OIDC_ISSUER'); }
  requireValue(issuer.protocol === 'https:' && !issuer.username && !issuer.password &&
    !issuer.search && !issuer.hash, 'INVALID_OIDC_ISSUER');
  requireValue(Boolean(env.DOMAGENT_OIDC_CLIENT_ID), 'OIDC_CLIENT_ID_REQUIRED');
  const port = Number(env.DOMAGENT_PORT || 18792);
  requireValue(Number.isInteger(port) && port > 0 && port <= 65535, 'INVALID_PORT');
  const protectedOrigins = [...new Set([
    origin, issuer.origin,
    ...(env.DOMAGENT_PROTECTED_ORIGINS || '').split(',').filter(Boolean).map(serviceOrigin),
  ])];
  let oidcSecret;
  if (env.DOMAGENT_OIDC_CLIENT_SECRET_FILE) {
    oidcSecret = readFileSync(env.DOMAGENT_OIDC_CLIENT_SECRET_FILE, 'utf8').trim();
    if (!oidcSecret) throw new Fault('EMPTY_OIDC_SECRET');
  }
  return {
    origin, issuer: env.DOMAGENT_OIDC_ISSUER,
    clientId: env.DOMAGENT_OIDC_CLIENT_ID, oidcSecret,
    bind: env.DOMAGENT_BIND || '127.0.0.1', port,
    db: env.DOMAGENT_DB || './data/domagent.db',
    protectedOrigins,
  };
}
