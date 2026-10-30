import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { validName } from '../shared/protocol.js';
import type { Agent, Config } from './config.js';
import { Fault, audit, failureCode } from './errors.js';
import { body, json, readBody } from './http.js';
import type { Hub } from './hub.js';
import { RateLimiter } from './rate.js';
import { hash, token, type Store } from './store.js';

const ACCESS_MS = 600_000;
const GRANT_MS = 30 * 24 * 60 * 60_000;
const PENDING_MS = 300_000;
const CODE_MS = 120_000;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
type AuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';
interface Client {
  id: string;
  name: string;
  url: string | null;
  redirect_uris: string;
  auth_method: AuthMethod;
  secret_hash: string | null;
}
interface Pending {
  client: Client;
  redirect: string;
  challenge: string;
  state: string | null;
  csrf: string;
  expires: number;
}
interface Code {
  agent_id: string;
  redirect_uri: string;
  challenge: string;
  expires_at: number;
  grant_id: string | null;
  client_id: string;
}
interface GrantToken {
  grant_id: string;
  client_id: string;
  agent_id: string;
  kind: string;
  used: number;
  expires_at: number;
  grant_expires: number;
}

class OAuthFault extends Fault {
  description: string;
  constructor(code: string, description: string, status = 400) {
    super(code, status);
    this.description = description;
  }
}
function check(value: unknown, code: string, description: string, status = 400): asserts value {
  if (!value) throw new OAuthFault(code, description, status);
}
function parseUrl(value: unknown): URL {
  check(typeof value === 'string' && value.length <= 2048, 'invalid_client_metadata', 'Invalid URL.');
  const url = URL.parse(value);
  check(
    url &&
      !/\s/.test(value) &&
      !url.username &&
      !url.password &&
      !value.includes('#') &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))),
    'invalid_client_metadata',
    'URLs must use HTTPS (HTTP is allowed only for loopback addresses), without credentials or fragments.',
  );
  return url;
}
function equalHash(value: string, digest: string): boolean {
  return timingSafeEqual(Buffer.from(hash(value), 'hex'), Buffer.from(digest, 'hex'));
}
function unique(params: URLSearchParams): void {
  check(new Set(params.keys()).size === [...params.keys()].length, 'invalid_request', 'Duplicate parameters.');
}
async function form(req: IncomingMessage): Promise<URLSearchParams> {
  check(
    req.headers['content-type']?.split(';')[0].toLowerCase() === 'application/x-www-form-urlencoded',
    'invalid_request',
    'Expected application/x-www-form-urlencoded.',
    415,
  );
  const params = new URLSearchParams(await readBody(req, 16_384));
  unique(params);
  return params;
}
const escape = (text: string): string =>
  text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export class OAuth {
  private readonly pending = new Map<string, Pending>();
  private readonly rates: RateLimiter;
  private readonly now: () => number;
  private lastSweep = 0;
  readonly resource: string;
  constructor(
    private readonly store: Store,
    private readonly config: Config,
    private readonly hub: Hub,
  ) {
    this.now = config.now || Date.now;
    this.rates = new RateLimiter(this.now);
    this.resource = `${config.origin}/mcp`;
  }

  private client(id: string | null): Client {
    const client = id && this.store.db.prepare('SELECT * FROM oauth_clients WHERE id=?').get(id);
    check(client, 'invalid_client', 'Unknown client.', 401);
    return client as unknown as Client;
  }
  private resourceMatches(params: URLSearchParams): void {
    check(!params.has('resource') || params.get('resource') === this.resource, 'invalid_target', 'Invalid resource.');
  }
  private sweep(): void {
    const now = this.now();
    for (const [id, row] of this.pending) if (row.expires <= now) this.pending.delete(id);
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    this.store.db.prepare('DELETE FROM oauth_codes WHERE expires_at<=?').run(now);
    this.store.db.prepare('DELETE FROM oauth_grants WHERE expires_at<=?').run(now);
    this.store.db.prepare("DELETE FROM oauth_tokens WHERE kind='access' AND expires_at<=?").run(now);
    this.store.db
      .prepare(
        `DELETE FROM oauth_clients WHERE created_at<=? AND NOT EXISTS
         (SELECT 1 FROM oauth_agents a WHERE a.client_id=oauth_clients.id)`,
      )
      .run(now - 24 * 60 * 60_000);
  }
  async route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    const metadata = [
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ].includes(path);
    if (!metadata && !['/oauth/register', '/oauth/authorize', '/oauth/token', '/oauth/revoke'].includes(path))
      return false;
    try {
      this.sweep();
      this.rates.take(`oauth:${req.socket.remoteAddress}`, 120);
      this.rates.take('oauth:global', 1000);
      if (path !== '/oauth/authorize') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Methods': metadata ? 'GET, OPTIONS' : 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          });
          res.end();
          return true;
        }
      }
      if (metadata) {
        check(req.method === 'GET', 'invalid_request', 'Method not allowed.', 405);
        json(
          res,
          200,
          path === '/.well-known/oauth-authorization-server'
            ? {
                issuer: this.config.origin,
                authorization_endpoint: `${this.config.origin}/oauth/authorize`,
                token_endpoint: `${this.config.origin}/oauth/token`,
                registration_endpoint: `${this.config.origin}/oauth/register`,
                revocation_endpoint: `${this.config.origin}/oauth/revoke`,
                response_types_supported: ['code'],
                grant_types_supported: ['authorization_code', 'refresh_token'],
                token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
                revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
                code_challenge_methods_supported: ['S256'],
                scopes_supported: ['mcp'],
                authorization_response_iss_parameter_supported: true,
              }
            : {
                resource: this.resource,
                authorization_servers: [this.config.origin],
                scopes_supported: ['mcp'],
                bearer_methods_supported: ['header'],
                resource_name: 'BananaBrowse',
              },
        );
      } else if (path === '/oauth/authorize') {
        check(['GET', 'POST'].includes(req.method!), 'invalid_request', 'Method not allowed.', 405);
        if (req.method === 'GET') this.authorizationPage(res, url.searchParams);
        else await this.authorize(req, res);
      } else {
        check(req.method === 'POST' && !url.search, 'invalid_request', 'Expected POST without query parameters.', 405);
        if (path === '/oauth/register') await this.register(req, res);
        else {
          const params = await form(req);
          const client = this.authenticateClient(req, params);
          if (path === '/oauth/token') this.exchange(res, client, params);
          else this.revoke(res, client, params);
        }
      }
      // eslint-disable-next-line no-catch-all/no-catch-all -- OAuth HTTP boundary: failures are audited and returned as OAuth errors
    } catch (error) {
      audit('oauth_failure', { code: failureCode(error) });
      if (res.destroyed) return true;
      const fault =
        error instanceof OAuthFault
          ? error
          : error instanceof Fault && error.code === 'RATE_LIMITED'
            ? new OAuthFault('temporarily_unavailable', 'Too many requests.', 429)
            : error instanceof Fault &&
                ['INVALID_JSON', 'CONTENT_TYPE_REQUIRED', 'PAYLOAD_TOO_LARGE'].includes(error.code)
              ? new OAuthFault('invalid_request', 'Invalid request body.', error.status)
              : new OAuthFault('server_error', 'Authorization server error.', 500);
      if (fault.code === 'invalid_client') res.setHeader('WWW-Authenticate', 'Basic realm="BananaBrowse OAuth"');
      json(res, fault.status, { error: fault.code, error_description: fault.description });
    }
    return true;
  }

  private async register(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.rates.take('register:global', 60);
    const data = await body(req, 16_384);
    check(
      Array.isArray(data.redirect_uris) && data.redirect_uris.length > 0 && data.redirect_uris.length <= 10,
      'invalid_client_metadata',
      'Provide 1 to 10 redirect URIs.',
    );
    for (const uri of data.redirect_uris) parseUrl(uri);
    check(
      data.client_name === undefined || validName(data.client_name),
      'invalid_client_metadata',
      'Invalid client name.',
    );
    if (data.client_uri !== undefined) parseUrl(data.client_uri);
    const method =
      data.token_endpoint_auth_method === undefined ? 'client_secret_basic' : data.token_endpoint_auth_method;
    check(
      ['none', 'client_secret_post', 'client_secret_basic'].includes(method),
      'invalid_client_metadata',
      'Unsupported client authentication method.',
    );
    check(
      data.grant_types === undefined ||
        (Array.isArray(data.grant_types) &&
          data.grant_types.includes('authorization_code') &&
          data.grant_types.every((value: unknown) => ['authorization_code', 'refresh_token'].includes(String(value)))),
      'invalid_client_metadata',
      'Unsupported grant types.',
    );
    check(
      data.response_types === undefined ||
        (Array.isArray(data.response_types) && data.response_types.length === 1 && data.response_types[0] === 'code'),
      'invalid_client_metadata',
      'Only the code response type is supported.',
    );
    check(data.scope === undefined || data.scope === 'mcp', 'invalid_client_metadata', 'Unsupported scope.');
    check(
      Number(this.store.db.prepare('SELECT count(*) AS n FROM oauth_clients').get()!.n) < 10_000,
      'temporarily_unavailable',
      'Client registration capacity reached.',
      429,
    );
    const id = token(),
      secret = method === 'none' ? null : token(),
      name = data.client_name?.trim() || 'MCP client',
      created = this.now();
    this.store.db
      .prepare(
        `INSERT INTO oauth_clients(id,name,url,redirect_uris,auth_method,secret_hash,created_at)
         VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        name,
        data.client_uri || null,
        JSON.stringify(data.redirect_uris),
        method,
        secret && hash(secret),
        created,
      );
    audit('oauth_client_registered');
    json(res, 201, {
      client_id: id,
      client_id_issued_at: Math.floor(created / 1000),
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_name: name,
      ...(data.client_uri ? { client_uri: data.client_uri } : {}),
      redirect_uris: data.redirect_uris,
      token_endpoint_auth_method: method,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'mcp',
    });
  }

  private authorizationPage(res: ServerResponse, params: URLSearchParams): void {
    unique(params);
    const client = this.client(params.get('client_id'));
    const redirect = params.get('redirect_uri');
    check(
      redirect && (JSON.parse(client.redirect_uris) as string[]).includes(redirect),
      'invalid_request',
      'The redirect URI is not registered for this client.',
    );
    check(params.get('response_type') === 'code', 'unsupported_response_type', 'Only code is supported.');
    check(
      params.get('code_challenge_method') === 'S256' && CHALLENGE.test(params.get('code_challenge') || ''),
      'invalid_request',
      'PKCE with an S256 challenge is required.',
    );
    this.resourceMatches(params);
    check(!params.has('scope') || params.get('scope') === 'mcp', 'invalid_scope', 'Unsupported scope.');
    check((params.get('state')?.length || 0) <= 2048, 'invalid_request', 'State is too long.');
    check(this.pending.size < 1000, 'temporarily_unavailable', 'Too many pending authorizations.', 429);
    const id = token(),
      csrf = token(),
      nonce = token();
    this.pending.set(id, {
      client,
      redirect,
      challenge: params.get('code_challenge')!,
      state: params.get('state'),
      csrf,
      expires: this.now() + PENDING_MS,
    });
    res.setHeader(
      'Set-Cookie',
      `__Host-bb-oauth-${id}=${csrf}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=300`,
    );
    // no-referrer makes browsers send Origin: null on native form POSTs.
    res.setHeader('Referrer-Policy', 'strict-origin');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self' ${new URL(redirect).origin}; frame-ancestors 'none'; base-uri 'none'`,
    );
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escape(client.name)} wants to use BananaBrowse</title><style nonce="${nonce}">body{font:18px system-ui;max-width:36em;margin:4em auto;padding:1em}input,button{font:inherit;margin:.5em 0;padding:.5em}code{overflow-wrap:anywhere}</style>
<h1>${escape(client.name)} wants to use BananaBrowse</h1>
<p>This client's name${client.url ? ` and website (${escape(client.url)})` : ''} are self-reported, not verified by the operator.</p>
<p>The authorization result will return to <code>${escape(redirect)}</code>. Continue only if you started connecting this client.</p>
<ol><li>Open your BananaBrowse extension window and click <strong>Pair an agent</strong>.</li>
<li>Enter the pairing code below and click Connect.</li><li>Return to the extension and <strong>Approve</strong> this client's request. You still approve each browser session separately.</li></ol>
<form method="post" action="/oauth/authorize"><input type="hidden" name="request_id" value="${id}">
<input type="hidden" name="csrf" value="${csrf}"><label>Pairing code <input name="code" autocomplete="off" maxlength="32" required autofocus></label>
<p><button name="decision" value="approve">Connect</button> <button name="decision" value="deny" formnovalidate>Cancel</button></p></form></html>`);
  }
  private redirect(res: ServerResponse, pending: Pending, values: Record<string, string>): void {
    const url = new URL(pending.redirect);
    for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
    if (pending.state !== null) url.searchParams.set('state', pending.state);
    url.searchParams.set('iss', this.config.origin);
    res.writeHead(303, { Location: url.href });
    res.end();
  }
  private async authorize(req: IncomingMessage, res: ServerResponse): Promise<void> {
    check(req.headers.origin === this.config.origin, 'invalid_request', 'Invalid authorization origin.', 403);
    const params = await form(req),
      id = params.get('request_id') || '',
      pending = this.pending.get(id);
    check(pending && pending.expires > this.now(), 'invalid_request', 'Authorization request expired.');
    const cookies = (req.headers.cookie || '').split(';').map((value) => value.trim());
    check(
      params.get('csrf') === pending.csrf && cookies.includes(`__Host-bb-oauth-${id}=${pending.csrf}`),
      'invalid_request',
      'Invalid authorization form.',
      403,
    );
    check(['approve', 'deny'].includes(params.get('decision') || ''), 'invalid_request', 'Invalid decision.');
    this.pending.delete(id);
    res.setHeader('Set-Cookie', `__Host-bb-oauth-${id}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
    if (params.get('decision') === 'deny') {
      this.redirect(res, pending, { error: 'access_denied' });
      return;
    }
    this.client(pending.client.id);
    const abort = new AbortController();
    const closed = () => abort.abort(new Fault('COMMAND_CANCELLED'));
    res.once('close', closed);
    try {
      const agent = await this.hub.authorizeOAuth(pending.client.id, params.get('code'), abort.signal);
      check(!abort.signal.aborted, 'access_denied', 'Authorization cancelled.');
      const code = token();
      this.store.db
        .prepare(`INSERT INTO oauth_codes(hash,agent_id,redirect_uri,challenge,expires_at) VALUES(?,?,?,?,?)`)
        .run(hash(code), agent.id, pending.redirect, pending.challenge, this.now() + CODE_MS);
      audit('oauth_authorized', { agent_id: agent.id });
      this.redirect(res, pending, { code });
    } catch (error) {
      if (
        error instanceof Fault &&
        ['ACTION_DECLINED', 'PAIRING_UNAVAILABLE', 'COMMAND_EXPIRED', 'COMMAND_CANCELLED', 'BROWSER_OFFLINE'].includes(
          error.code,
        )
      ) {
        audit('oauth_denied', { code: error.code });
        if (!res.destroyed) this.redirect(res, pending, { error: 'access_denied' });
      } else throw error;
    } finally {
      res.off('close', closed);
    }
  }

  private authenticateClient(req: IncomingMessage, params: URLSearchParams): Client {
    let id = params.get('client_id'),
      secret = params.get('client_secret');
    let method: AuthMethod = secret === null ? 'none' : 'client_secret_post';
    if (req.headers.authorization) {
      check(secret === null, 'invalid_request', 'Multiple client authentication methods.');
      const match = /^Basic ([A-Za-z0-9+/]+=*)$/i.exec(req.headers.authorization);
      check(match, 'invalid_client', 'Invalid client authentication.', 401);
      const decoded = Buffer.from(match[1], 'base64').toString('utf8'),
        colon = decoded.indexOf(':');
      check(colon >= 0, 'invalid_client', 'Invalid client authentication.', 401);
      let basicId: string;
      try {
        basicId = decodeURIComponent(decoded.slice(0, colon).replaceAll('+', ' '));
        secret = decodeURIComponent(decoded.slice(colon + 1).replaceAll('+', ' '));
      } catch {
        throw new OAuthFault('invalid_client', 'Invalid client authentication.', 401);
      }
      check(!id || id === basicId, 'invalid_client', 'Client ID mismatch.', 401);
      id = basicId;
      method = 'client_secret_basic';
    }
    const client = this.client(id);
    check(
      client.auth_method === method &&
        (method === 'none' || (secret && client.secret_hash && equalHash(secret, client.secret_hash))),
      'invalid_client',
      'Invalid client authentication.',
      401,
    );
    return client;
  }
  private findToken(value: string | null): GrantToken | undefined {
    if (!value || value.length > 512) return undefined;
    return this.store.db
      .prepare(
        `SELECT t.*,g.expires_at AS grant_expires,a.client_id,a.id AS agent_id
         FROM oauth_tokens t JOIN oauth_grants g ON g.id=t.grant_id
         JOIN oauth_agents a ON a.id=g.agent_id WHERE t.hash=?`,
      )
      .get(hash(value)) as unknown as GrantToken | undefined;
  }
  authenticate(value: string | undefined): Agent | undefined {
    const row = this.findToken(value || null);
    if (
      !row ||
      row.kind !== 'access' ||
      row.expires_at <= this.now() ||
      row.grant_expires <= this.now() ||
      !this.store.browsersForAgent(row.agent_id).length
    )
      return undefined;
    return this.hub.agents.get(row.agent_id);
  }
  private issueTokens(grantId: string, expires: number): Record<string, string | number> {
    const access = token(),
      refresh = token(),
      now = this.now(),
      accessExpires = Math.min(now + ACCESS_MS, expires);
    const insert = this.store.db.prepare('INSERT INTO oauth_tokens(hash,grant_id,kind,expires_at) VALUES(?,?,?,?)');
    insert.run(hash(access), grantId, 'access', accessExpires);
    insert.run(hash(refresh), grantId, 'refresh', expires);
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: Math.floor((accessExpires - now) / 1000),
      refresh_token: refresh,
      scope: 'mcp',
    };
  }
  private exchange(res: ServerResponse, client: Client, params: URLSearchParams): void {
    this.resourceMatches(params);
    check(!params.has('scope') || params.get('scope') === 'mcp', 'invalid_scope', 'Unsupported scope.');
    const type = params.get('grant_type');
    check(
      type === 'authorization_code' || type === 'refresh_token',
      'unsupported_grant_type',
      'Unsupported grant type.',
    );
    check(
      Number(this.store.db.prepare('SELECT count(*) AS n FROM oauth_tokens').get()!.n) < 100_000,
      'temporarily_unavailable',
      'Token capacity reached.',
      429,
    );
    if (type === 'authorization_code') {
      const code = params.get('code') || '',
        verifier = params.get('code_verifier') || '';
      const row = this.store.db
        .prepare(`SELECT c.*,a.client_id FROM oauth_codes c JOIN oauth_agents a ON a.id=c.agent_id WHERE c.hash=?`)
        .get(hash(code)) as unknown as Code | undefined;
      check(
        row &&
          row.client_id === client.id &&
          row.redirect_uri === params.get('redirect_uri') &&
          row.expires_at > this.now() &&
          VERIFIER.test(verifier) &&
          createHash('sha256').update(verifier).digest('base64url') === row.challenge,
        'invalid_grant',
        'Invalid authorization code, redirect URI or PKCE verifier.',
      );
      if (row.grant_id) {
        this.store.db.prepare('DELETE FROM oauth_grants WHERE id=?').run(row.grant_id);
        throw new OAuthFault('invalid_grant', 'Authorization code has already been used.');
      }
      check(this.store.browsersForAgent(row.agent_id).length, 'invalid_grant', 'Authorization was revoked.');
      const grantId = token(),
        expires = this.now() + GRANT_MS;
      const result = this.store.transaction(() => {
        this.store.db
          .prepare('INSERT INTO oauth_grants(id,agent_id,expires_at) VALUES(?,?,?)')
          .run(grantId, row.agent_id, expires);
        this.store.db.prepare('UPDATE oauth_codes SET grant_id=? WHERE hash=?').run(grantId, hash(code));
        return this.issueTokens(grantId, expires);
      });
      json(res, 200, result);
    } else {
      const refresh = params.get('refresh_token'),
        row = this.findToken(refresh);
      check(
        row &&
          row.client_id === client.id &&
          row.kind === 'refresh' &&
          row.expires_at > this.now() &&
          row.grant_expires > this.now(),
        'invalid_grant',
        'Invalid refresh token.',
      );
      if (row.used) {
        this.store.db.prepare('DELETE FROM oauth_grants WHERE id=?').run(row.grant_id);
        audit('oauth_refresh_reuse', { agent_id: row.agent_id });
        throw new OAuthFault('invalid_grant', 'Refresh token reuse revoked this authorization.');
      }
      const result = this.store.transaction(() => {
        this.store.db.prepare('UPDATE oauth_tokens SET used=1 WHERE hash=?').run(hash(refresh!));
        return this.issueTokens(row.grant_id, row.grant_expires);
      });
      json(res, 200, result);
    }
  }
  private revoke(res: ServerResponse, client: Client, params: URLSearchParams): void {
    check(params.has('token'), 'invalid_request', 'Token is required.');
    const row = this.findToken(params.get('token'));
    if (row?.client_id === client.id) {
      this.store.db.prepare('DELETE FROM oauth_grants WHERE id=?').run(row.grant_id);
      audit('oauth_revoked', { agent_id: row.agent_id });
    }
    res.writeHead(200);
    res.end();
  }
}
