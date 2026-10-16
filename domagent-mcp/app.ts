import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import {
  ARTIFACT_ID_PATTERN,
  ARTIFACT_TEXT_MIME,
  VERSION,
  extensionOrigin,
  keyId,
  verify,
  registerPayload,
  tokenPayload,
  validName,
  type Wire,
} from '../shared/protocol.js';
import { token, hash, type Store } from './store.js';
import { Hub } from './hub.js';
import { handleMcp } from './mcp.js';
import type { Agent, Config } from './config.js';
import { Fault, requireValue, failureCode, audit } from './errors.js';
import { RateLimiter } from './rate.js';
import { SERVICE_VERSION } from './version.js';

export { SERVICE_VERSION } from './version.js';
const CHALLENGE_MS = 300_000;

async function body(req: IncomingMessage, limit = 262144): Promise<Wire> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    requireValue(size <= limit, 'PAYLOAD_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  requireValue(req.headers['content-type']?.split(';')[0] === 'application/json', 'CONTENT_TYPE_REQUIRED', 415);
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Fault('INVALID_JSON');
  }
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_JSON');
  return value as Wire;
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}
const allowedFields = (data: Wire, required: string[], optional: string[] = []): void => {
  requireValue(
    required.every((k) => Object.hasOwn(data, k)) &&
      Object.keys(data).every((k) => required.includes(k) || optional.includes(k)),
    'INVALID_ARGUMENTS',
  );
};
function extension(value: unknown): string {
  try {
    return extensionOrigin(value as string);
  } catch {
    throw new Fault('NOT_AUTHORIZED', 403);
  }
}
async function proof(publicKey: Wire, payload: Uint8Array<ArrayBuffer>, signature: unknown): Promise<void> {
  let verified = false;
  try {
    verified = await verify(publicKey, payload, signature);
  } catch {
    throw new Fault('NOT_AUTHORIZED', 401);
  }
  requireValue(verified, 'NOT_AUTHORIZED', 401);
}
function sendArtifact(res: ServerResponse, hub: Hub, agent: Agent, id: string, method: string | undefined): void {
  if (method === 'DELETE') {
    hub.artifacts.remove(agent.id, id);
    audit('artifact_deleted', { agent_id: agent.id });
    res.writeHead(204);
    res.end();
    return;
  }
  const { meta, data } = hub.artifacts.read(agent.id, id);
  const filename = (meta.name || id).replace(/[^A-Za-z0-9._-]/g, '_');
  res.writeHead(200, {
    'Content-Type': ARTIFACT_TEXT_MIME.test(meta.mime) ? `${meta.mime}; charset=utf-8` : meta.mime,
    'Content-Length': data.length,
    'Content-Disposition': `attachment; filename="${filename}"`,
    'X-Content-SHA256': meta.sha256,
    ETag: `"${meta.sha256}"`,
  });
  res.end(method === 'HEAD' ? undefined : data);
}
export function agentKeyMatches(agent: Agent | undefined, presented: unknown): boolean {
  if (!agent || typeof presented !== 'string' || presented.length < 16 || presented.length > 512) return false;
  return timingSafeEqual(Buffer.from(hash(presented), 'hex'), Buffer.from(agent.key_hash, 'hex'));
}

export function createApp(store: Store, config: Config) {
  const hub = new Hub(store, config),
    now = config.now || Date.now;
  const challenges = new Map<string, { origin: string; expires_at: number }>(),
    rates = new RateLimiter(now);
  let activeMcp = 0;
  const rateLimit = (req: IncomingMessage): void => {
    // Forwarded addresses are deliberately ignored; the proxy shares one conservative budget.
    rates.take(`http:${req.socket.remoteAddress}`, 600);
    for (const [id, row] of challenges) if (row.expires_at <= now()) challenges.delete(id);
  };
  const takeChallenge = (nonce: unknown, origin: string): void => {
    const challenge = typeof nonce === 'string' && challenges.get(nonce);
    requireValue(challenge && challenge.origin === origin && challenge.expires_at > now(), 'CHALLENGE_EXPIRED', 403);
    challenges.delete(nonce as string);
  };
  const server = createServer((req, res) => {
    route(req, res).catch((error) => {
      audit('http_failure', { code: failureCode(error) });
      if (res.headersSent) {
        res.destroy();
        return;
      }
      json(res, error instanceof Fault ? error.status : 500, { error: failureCode(error) });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.on('upgrade', (req, socket, head) => {
    try {
      rateLimit(req);
      hub.upgrade(req, socket, head);
      // eslint-disable-next-line no-catch-all/no-catch-all -- upgrade boundary: every rejection closes the socket instead of crashing the server
    } catch (error) {
      audit('ws_rejected', { code: failureCode(error) });
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
    }
  });
  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    rateLimit(req);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    const url = new URL(req.url!, config.origin),
      path = url.pathname,
      method = req.method,
      origin = req.headers.origin;
    // Artifacts live at /mcp/<agent>?artifact=<id> so that credential proxies scoped to the exact MCP path also cover them.
    const query = [...url.searchParams],
      artifactId = query.length === 1 && query[0][0] === 'artifact' ? query[0][1] : null;
    requireValue(
      !url.search || (/^\/mcp\//.test(path) && ARTIFACT_ID_PATTERN.test(artifactId || '')),
      'INVALID_ARGUMENTS',
    );
    if (path === '/health' && method === 'GET') {
      json(res, 200, { service: 'domagent', status: 'ok', version: SERVICE_VERSION, protocol_version: VERSION });
      return;
    }
    if (path === '/.well-known/domagent' && method === 'GET') {
      if (origin) {
        extension(origin);
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      json(res, 200, {
        service: 'domagent',
        version: SERVICE_VERSION,
        protocol_version: VERSION,
        origin: config.origin,
      });
      return;
    }
    if (['/api/challenge', '/api/browsers', '/api/token'].includes(path)) {
      // Extension GETs can omit Origin; a present foreign Origin is never overridden by the header.
      const extensionOrigin = extension(origin || req.headers['x-domagent-extension-origin']);
      if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      if (method === 'OPTIONS') {
        requireValue(
          req.headers['access-control-request-method'] === (path === '/api/challenge' ? 'GET' : 'POST'),
          'METHOD_NOT_ALLOWED',
          405,
        );
        const headers = (req.headers['access-control-request-headers'] || '')
          .toLowerCase()
          .split(',')
          .map((v: string) => v.trim())
          .filter(Boolean);
        requireValue(
          headers.every((h: string) => ['content-type', 'x-domagent-extension-origin'].includes(h)),
          'NOT_AUTHORIZED',
          403,
        );
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET, POST',
          'Access-Control-Allow-Headers': 'Content-Type, X-DomAgent-Extension-Origin',
        });
        res.end();
        return;
      }
      if (path === '/api/challenge') {
        requireValue(method === 'GET', 'METHOD_NOT_ALLOWED', 405);
        rates.take(`challenge:${req.socket.remoteAddress}`, 60);
        rates.take('challenge:global', 600);
        requireValue(challenges.size < 2000, 'RATE_LIMITED', 429);
        const nonce = token(),
          expires_at = now() + CHALLENGE_MS;
        challenges.set(nonce, { origin: extensionOrigin, expires_at });
        json(res, 200, { origin: config.origin, nonce, expires_at });
        return;
      }
      requireValue(method === 'POST', 'METHOD_NOT_ALLOWED', 405);
      const data = await body(req, 8192);
      if (path === '/api/browsers') {
        rates.take(`register:${req.socket.remoteAddress}`, 10);
        rates.take('register:global', 100);
        allowedFields(data, ['name', 'key_id', 'public_key', 'nonce', 'signature']);
        requireValue(validName(data.name) && typeof data.signature === 'string', 'INVALID_ARGUMENTS');
        let id: string;
        try {
          id = await keyId(data.public_key);
        } catch {
          throw new Fault('INVALID_PUBLIC_KEY');
        }
        requireValue(id === data.key_id, 'NOT_AUTHORIZED', 401);
        await proof(
          data.public_key,
          registerPayload({ ...data, origin: config.origin, extension_origin: extensionOrigin }),
          data.signature,
        );
        takeChallenge(data.nonce, extensionOrigin);
        const browser = store.registerBrowser({
          name: data.name,
          key_id: id,
          public_key: { kty: 'EC', crv: 'P-256', x: data.public_key.x, y: data.public_key.y },
          extension_origin: extensionOrigin,
        });
        audit('browser_registered', { browser_id: browser.id });
        json(res, 201, {
          browser_id: browser.id,
          name: data.name.trim(),
          refresh_token: browser.refresh_token,
          ...hub.issueAccessToken(browser.id),
        });
        return;
      }
      rates.take(`token:${req.socket.remoteAddress}`, 120);
      rates.take('token:global', 2000);
      allowedFields(data, ['browser_id', 'refresh_token', 'nonce', 'signature']);
      const browser = typeof data.browser_id === 'string' && store.browser(data.browser_id);
      requireValue(
        browser && browser.extension_origin === extensionOrigin && typeof data.signature === 'string',
        'NOT_AUTHORIZED',
        401,
      );
      await proof(
        JSON.parse(browser.public_key),
        tokenPayload({ ...data, origin: config.origin, key_id: browser.key_id }),
        data.signature,
      );
      takeChallenge(data.nonce, extensionOrigin);
      const refresh = store.rotateRefresh(browser.id, data.refresh_token);
      json(res, 200, { browser_id: browser.id, refresh_token: refresh, ...hub.issueAccessToken(browser.id) });
      return;
    }
    const mcp = /^\/mcp\/([a-z0-9-]{1,32})$/.exec(path);
    if (mcp) {
      requireValue(
        artifactId ? ['GET', 'HEAD', 'DELETE'].includes(method!) : method === 'POST',
        'METHOD_NOT_ALLOWED',
        405,
      );
      requireValue(!origin || origin === config.origin, 'NOT_AUTHORIZED', 403);
      const agent = hub.agents.get(mcp[1]);
      const presented = /^Bearer ([^\s]+)$/.exec(req.headers.authorization || '')?.[1];
      requireValue(agentKeyMatches(agent, presented), 'NOT_AUTHORIZED', 401);
      requireValue(activeMcp < 256, 'RATE_LIMITED', 429);
      rates.take(`mcp:${agent!.id}`, 600);
      if (artifactId) {
        sendArtifact(res, hub, agent!, artifactId, method);
        return;
      }
      activeMcp++;
      try {
        await handleMcp(req, res, await body(req), agent!, hub);
      } finally {
        activeMcp--;
      }
      return;
    }
    throw new Fault('NOT_FOUND', 404);
  }
  return {
    server,
    hub,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.bind, () => {
          server.off('error', reject);
          resolve(server.address());
        });
      }),
    close: async () => {
      hub.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
export type App = ReturnType<typeof createApp>;
