import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { start, FakeExtension, AGENT_KEY, ORIGIN } from './helpers.js';
import { hash, Store, initializeSchema } from '../store.js';
import { loadConfig } from '../config.js';
import { publicArtifact } from '../mcp.js';

const REDIRECT = 'https://client.test/callback';
const RESOURCE = `${ORIGIN}/mcp`;
const auth = (value) => ({ Authorization: ['Bearer', value].join(' ') });
const postForm = (fixture, path, values, headers = {}) =>
  fetch(`${fixture.base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(values),
    redirect: 'manual',
  });
async function register(fixture, extra = {}) {
  const response = await fetch(`${fixture.base}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Test MCP client',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      ...extra,
    }),
  });
  assert.equal(response.status, 201);
  return response.json();
}
async function authorizationPage(fixture, client, extra = {}) {
  const verifier = randomBytes(32).toString('base64url');
  const params = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    response_type: 'code',
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    resource: RESOURCE,
    scope: 'mcp',
    state: 'test-state',
    ...extra,
  });
  const response = await fetch(`${fixture.base}/oauth/authorize?${params}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('referrer-policy'), 'strict-origin');
  assert.match(response.headers.get('content-security-policy'), /form-action 'self' https:\/\/client.test;/);
  const html = await response.text();
  return {
    verifier,
    html,
    cookie: response.headers.get('set-cookie').split(';')[0],
    values: {
      request_id: /name="request_id" value="([^"]+)"/.exec(html)[1],
      csrf: /name="csrf" value="([^"]+)"/.exec(html)[1],
      decision: 'approve',
    },
  };
}
async function extensionFor(fixture, name = 'First browser') {
  const extension = new FakeExtension(fixture.base, { name });
  await extension.register();
  await extension.connect();
  await extension.sync();
  return extension;
}
async function authorize(fixture, client, extension, { approved = true, code = 'K7MP-4QTX' } = {}) {
  const page = await authorizationPage(fixture, client);
  await extension.pairingCode(code);
  const pending = postForm(
    fixture,
    '/oauth/authorize',
    { ...page.values, code },
    { Cookie: page.cookie, Origin: ORIGIN },
  );
  const proposal = await extension.next('pairing.proposal');
  assert.equal(proposal.agent.oauth_client, true);
  extension.send({ type: 'pairing.decision', request_id: proposal.request_id, approved });
  const response = await pending;
  assert.equal(response.status, 303);
  const redirect = new URL(response.headers.get('location'));
  assert.equal(redirect.searchParams.get('state'), 'test-state');
  assert.equal(redirect.searchParams.get('iss'), ORIGIN);
  return { code: redirect.searchParams.get('code'), verifier: page.verifier, redirect, proposal };
}
function clientAuthentication(client) {
  return {
    client_id: client.client_id,
    ...(client.token_endpoint_auth_method === 'client_secret_post' ? { client_secret: client.client_secret } : {}),
  };
}
function exchange(fixture, client, authorization, extra = {}, headers = {}) {
  return postForm(
    fixture,
    '/oauth/token',
    {
      ...clientAuthentication(client),
      grant_type: 'authorization_code',
      code: authorization.code,
      code_verifier: authorization.verifier,
      redirect_uri: REDIRECT,
      resource: RESOURCE,
      ...extra,
    },
    headers,
  );
}
async function tokensFor(fixture, client, extension) {
  const authorization = await authorize(fixture, client, extension);
  const response = await exchange(fixture, client, authorization);
  assert.equal(response.status, 200);
  return { ...(await response.json()), agentId: authorization.proposal.agent.id };
}
const mcpRequest = (fixture, key) =>
  fetch(`${fixture.base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...auth(key) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });

test('OAuth is opt-in; discovery challenges and API-key endpoints remain compatible', async (t) => {
  assert.equal(loadConfig({ BANANABROWSE_ORIGIN: ORIGIN }).oauthEnabled, false);
  assert.equal(loadConfig({ BANANABROWSE_ORIGIN: ORIGIN, BANANABROWSE_OAUTH_ENABLED: 'true' }).oauthEnabled, true);
  assert.throws(
    () => loadConfig({ BANANABROWSE_ORIGIN: ORIGIN, BANANABROWSE_OAUTH_ENABLED: 'yes' }),
    /INVALID_OAUTH_CONFIG/,
  );
  const disabled = await start();
  t.after(() => disabled.close());
  assert.equal((await mcpRequest(disabled, AGENT_KEY)).status, 404);
  assert.equal((await fetch(`${disabled.base}/.well-known/oauth-authorization-server`)).status, 404);
  const fixture = await start({ oauthEnabled: true });
  t.after(() => fixture.close());
  const missing = await mcpRequest(fixture, '');
  assert.equal(missing.status, 401);
  assert.match(missing.headers.get('www-authenticate'), /resource_metadata=.*oauth-protected-resource\/mcp/);
  const anonymousGet = await fetch(`${fixture.base}/mcp`);
  assert.equal(anonymousGet.status, 401);
  assert.match(anonymousGet.headers.get('www-authenticate'), /oauth-protected-resource\/mcp/);
  const resource = await (await fetch(`${fixture.base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(resource.resource, RESOURCE);
  assert.deepEqual(resource.authorization_servers, [ORIGIN]);
  const metadata = await (await fetch(`${fixture.base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(metadata.registration_endpoint, `${ORIGIN}/oauth/register`);
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
  const legacy = await fixture.mcp();
  assert.equal((await legacy.client.listTools()).tools.length, 31);
  assert.equal((await mcpRequest(fixture, AGENT_KEY)).status, 401);
});

test('DCR validates metadata, defaults to Basic auth and stores only secret hashes', async (t) => {
  const fixture = await start({ oauthEnabled: true });
  t.after(() => fixture.close());
  const client = await register(fixture, { token_endpoint_auth_method: undefined });
  assert.equal(client.token_endpoint_auth_method, 'client_secret_basic');
  assert.equal(client.client_secret_expires_at, 0);
  const row = fixture.store.db.prepare('SELECT * FROM oauth_clients WHERE id=?').get(client.client_id);
  assert.equal(row.secret_hash, hash(client.client_secret));
  assert(!JSON.stringify(row).includes(client.client_secret));
  assert.equal(fixture.hub.agents.size, 3);
  for (const extra of [
    { redirect_uris: [] },
    { redirect_uris: ['https://client.test/#fragment'] },
    { redirect_uris: ['https://client.test/#'] },
    { redirect_uris: ['https://client.test/callback with spaces'] },
    { redirect_uris: ['https://user:password@client.test/callback'] },
    { redirect_uris: ['http://client.test/callback'] },
    { redirect_uris: ['javascript:alert(1)'] },
    { token_endpoint_auth_method: 'private_key_jwt' },
    { token_endpoint_auth_method: null },
    { grant_types: ['client_credentials'] },
    { client_name: '<script>bad</script>\n' },
    { scope: 'admin' },
  ]) {
    const response = await fetch(`${fixture.base}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT], ...extra }),
    });
    assert.equal(response.status, 400, JSON.stringify(extra));
    assert.equal((await response.json()).error, 'invalid_client_metadata');
  }
  await register(fixture, { redirect_uris: ['http://127.0.0.1:12345/callback', 'http://[::1]:23456/callback'] });
});

test('authorization presents the friendly registered client name without claiming it is verified', async (t) => {
  const fixture = await start({ oauthEnabled: true });
  t.after(() => fixture.close());
  const client = await register(fixture, { client_name: 'BananaClaw (Denis Treskunov)' });
  const page = await authorizationPage(fixture, client);
  assert.match(page.html, /<h1>BananaClaw \(Denis Treskunov\) wants to use BananaBrowse<\/h1>/);
  assert.match(page.html, /<title>BananaClaw \(Denis Treskunov\) wants to use BananaBrowse<\/title>/);
  assert.match(page.html, /self-reported, not verified/);
});

test('authorization requires registered redirect, PKCE, resource, CSRF and explicit extension consent', async (t) => {
  const fixture = await start({ oauthEnabled: true });
  t.after(() => fixture.close());
  const client = await register(fixture, { client_name: 'Client <script>alert(1)</script>' });
  const page = await authorizationPage(fixture, client);
  assert(!page.html.includes('<script>'));
  assert.match(page.html, /&lt;script&gt;/);
  const missingCookie = await postForm(fixture, '/oauth/authorize', page.values, { Origin: ORIGIN });
  assert.equal(missingCookie.status, 403);
  const foreignOrigin = await postForm(fixture, '/oauth/authorize', page.values, {
    Cookie: page.cookie,
    Origin: 'https://evil.test',
  });
  assert.equal(foreignOrigin.status, 403);
  const params = {
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    response_type: 'code',
    code_challenge_method: 'S256',
    code_challenge: 'A'.repeat(43),
    resource: RESOURCE,
  };
  for (const extra of [
    { redirect_uri: 'https://evil.test/callback' },
    { code_challenge_method: 'plain' },
    { code_challenge: '' },
    { resource: 'https://other.test/mcp' },
    { scope: 'admin' },
    { response_type: 'token' },
  ]) {
    const response = await fetch(`${fixture.base}/oauth/authorize?${new URLSearchParams({ ...params, ...extra })}`);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('location'), null);
  }
  const cancelled = await postForm(
    fixture,
    '/oauth/authorize',
    { ...page.values, decision: 'deny' },
    { Origin: ORIGIN, Cookie: page.cookie },
  );
  assert.equal(new URL(cancelled.headers.get('location')).searchParams.get('error'), 'access_denied');
  const extension = await extensionFor(fixture);
  const declined = await authorize(fixture, client, extension, { approved: false });
  assert.equal(declined.code, null);
  assert.equal(declined.redirect.searchParams.get('error'), 'access_denied');
  assert.equal(fixture.store.listPairings().length, 0);
  assert.equal(fixture.store.db.prepare('SELECT count(*) AS n FROM oauth_agents').get().n, 0);
});

test('one OAuth identity drives two browser registrations; unpairing one preserves the other', async (t) => {
  const fixture = await start({ oauthEnabled: true });
  t.after(() => fixture.close());
  const client = await register(fixture);
  const first = await extensionFor(fixture);
  const tokens = await tokensFor(fixture, client, first);
  assert.equal(tokens.expires_in, 600);
  assert.equal((await fetch(`${fixture.base}/mcp`, { headers: auth(tokens.access_token) })).status, 405);
  const agent = await fixture.mcp(null, tokens.access_token);
  const second = await extensionFor(fixture, 'Second browser');
  const code = await second.pairingCode('AB12-CD34');
  const pairing = agent.call('pair_browser', { code });
  const proposal = await second.next('pairing.proposal');
  assert.equal(proposal.agent.id, tokens.agentId);
  assert.equal(fixture.store.paired(tokens.agentId, second.browser_id), false);
  second.send({ type: 'pairing.decision', request_id: proposal.request_id, approved: true });
  await pairing;
  assert.deepEqual(
    new Set((await agent.call('list_browsers')).map((browser) => browser.browser_id)),
    new Set([first.browser_id, second.browser_id]),
  );
  for (const extension of [first, second]) {
    const request = agent.call('request_session', { browser_id: extension.browser_id, purpose: 'Use this browser' });
    await extension.approveNext();
    assert.equal((await request).browser_id, extension.browser_id);
  }
  const reauthorized = await authorize(fixture, client, second, { code: 'EF12-GH34' });
  assert.equal(reauthorized.proposal.agent.id, tokens.agentId);
  assert.equal((await exchange(fixture, client, reauthorized)).status, 200);
  await agent.call('unpair_browser', { browser_id: first.browser_id });
  assert.deepEqual(
    (await agent.call('list_browsers')).map((browser) => browser.browser_id),
    [second.browser_id],
  );
  const refreshed = await postForm(fixture, '/oauth/token', {
    client_id: client.client_id,
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    resource: RESOURCE,
  });
  assert.equal(refreshed.status, 200);
  const next = await refreshed.json();
  assert.equal((await mcpRequest(fixture, next.access_token)).status, 200);
  fixture.store.deleteBrowser(second.browser_id);
  assert.equal((await mcpRequest(fixture, next.access_token)).status, 401);
  const revoked = await postForm(fixture, '/oauth/token', {
    client_id: client.client_id,
    grant_type: 'refresh_token',
    refresh_token: next.refresh_token,
  });
  assert.equal((await revoked.json()).error, 'invalid_grant');
});

test('a shared DCR registration does not merge unrelated OAuth identities or their artifacts', async (t) => {
  const fixture = await start({ oauthEnabled: true });
  t.after(() => fixture.close());
  const client = await register(fixture);
  const first = await extensionFor(fixture);
  const second = await extensionFor(fixture, 'Other owner');
  const a = await tokensFor(fixture, client, first);
  const b = await tokensFor(fixture, client, second);
  assert.notEqual(a.agentId, b.agentId);
  const agent = await fixture.mcp(null, a.access_token);
  assert.deepEqual(
    (await agent.call('list_browsers')).map((row) => row.browser_id),
    [first.browser_id],
  );
  await assert.rejects(
    agent.call('request_session', { browser_id: second.browser_id, purpose: 'Try another owner' }),
    /NOT_FOUND/,
  );
  const meta = fixture.hub.artifacts.put(a.agentId, Buffer.from('private export'), { mime: 'text/plain' });
  const artifact = publicArtifact(fixture.hub, meta);
  assert.equal(artifact.download_url, `${RESOURCE}?artifact=${meta.id}`);
  const url = `${fixture.base}/mcp?artifact=${meta.id}`;
  assert.equal(await (await fetch(url, { headers: auth(a.access_token) })).text(), 'private export');
  assert.equal((await fetch(url, { headers: auth(b.access_token) })).status, 404);
  assert.equal((await fetch(url, { headers: auth(a.refresh_token) })).status, 401);
  assert.equal((await fetch(url, { method: 'HEAD', headers: auth(a.access_token) })).status, 200);
  assert.equal((await fetch(url, { method: 'DELETE', headers: auth(a.access_token) })).status, 204);
});

test('codes bind client, redirect, PKCE and resource; replay revokes the issued grant', async (t) => {
  const fixture = await start({ oauthEnabled: true });
  t.after(() => fixture.close());
  const client = await register(fixture);
  const other = await register(fixture);
  const extension = await extensionFor(fixture);
  const authorization = await authorize(fixture, client, extension);
  for (const [identity, extra] of [
    [other, {}],
    [client, { redirect_uri: 'https://evil.test/' }],
    [client, { code_verifier: 'X'.repeat(43) }],
    [client, { resource: 'https://other.test/mcp' }],
  ]) {
    const response = await exchange(fixture, identity, authorization, extra);
    assert.equal(response.status, 400);
  }
  const response = await exchange(fixture, client, authorization);
  assert.equal(response.status, 200);
  const tokens = await response.json();
  const codeRow = fixture.store.db.prepare('SELECT * FROM oauth_codes').get();
  assert.equal(codeRow.hash, hash(authorization.code));
  assert(!JSON.stringify(fixture.store.db.prepare('SELECT * FROM oauth_tokens').all()).includes(tokens.access_token));
  assert.equal((await exchange(fixture, client, authorization)).status, 400);
  assert.equal((await mcpRequest(fixture, tokens.access_token)).status, 401);
});

test('consent expires at five minutes, codes at two minutes, and grants at thirty days', async (t) => {
  let now = Date.now();
  const fixture = await start({ oauthEnabled: true, now: () => now });
  t.after(() => fixture.close());
  const client = await register(fixture);
  const page = await authorizationPage(fixture, client);
  now += 300_000;
  const expiredPage = await postForm(
    fixture,
    '/oauth/authorize',
    { ...page.values, decision: 'deny' },
    { Cookie: page.cookie, Origin: ORIGIN },
  );
  assert.equal(expiredPage.status, 400);
  assert.equal((await expiredPage.json()).error, 'invalid_request');
  const extension = await extensionFor(fixture);
  const authorization = await authorize(fixture, client, extension);
  now += 120_000;
  assert.equal((await exchange(fixture, client, authorization)).status, 400);
  // Keep the fake browser live when advancing the OAuth clock.
  fixture.hub.connections.get(extension.browser_id).lastSeen = now;
  const tokens = await tokensFor(fixture, client, extension);
  now += 30 * 24 * 60 * 60_000;
  const expiredGrant = await postForm(fixture, '/oauth/token', {
    client_id: client.client_id,
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
  });
  assert.equal(expiredGrant.status, 400);
  assert.equal((await expiredGrant.json()).error, 'invalid_grant');
  assert.equal((await mcpRequest(fixture, tokens.access_token)).status, 401);
});

test('OAuth rejects malformed, duplicate and oversized requests with protocol errors', async (t) => {
  const fixture = await start({ oauthEnabled: true });
  t.after(() => fixture.close());
  const malformed = await fetch(`${fixture.base}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  assert.equal((await malformed.json()).error, 'invalid_request');
  const oversized = await fetch(`${fixture.base}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ padding: 'x'.repeat(16_384) }),
  });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error, 'invalid_request');
  const client = await register(fixture);
  const duplicate = await fetch(`${fixture.base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `client_id=${client.client_id}&client_id=${client.client_id}&grant_type=refresh_token`,
  });
  assert.equal((await duplicate.json()).error, 'invalid_request');
  const options = await fetch(`${fixture.base}/oauth/token`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://client.test', 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('access-control-allow-origin'), '*');
  const unknownToken = await postForm(fixture, '/oauth/revoke', {
    client_id: client.client_id,
    token: 'unknown',
  });
  assert.equal(unknownToken.status, 200);
});

test('confidential clients authenticate with Basic or POST, and cannot use another method', async (t) => {
  const fixture = await start({ oauthEnabled: true });
  t.after(() => fixture.close());
  const extension = await extensionFor(fixture);
  for (const method of ['client_secret_basic', 'client_secret_post']) {
    const client = await register(fixture, { token_endpoint_auth_method: method });
    const authorization = await authorize(fixture, client, extension);
    const basic = {
      Authorization: `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')}`,
    };
    const incorrect = await exchange(fixture, client, authorization, { client_secret: 'wrong' });
    assert.equal(incorrect.status, 401);
    const response = await exchange(fixture, client, authorization, {}, method === 'client_secret_basic' ? basic : {});
    assert.equal(response.status, 200);
    const tokens = await response.json();
    const refreshed = await postForm(
      fixture,
      '/oauth/token',
      { ...clientAuthentication(client), grant_type: 'refresh_token', refresh_token: tokens.refresh_token },
      method === 'client_secret_basic' ? basic : {},
    );
    assert.equal(refreshed.status, 200);
  }
});

test('access tokens expire; refresh rotation detects replay and revocation is client-bound', async (t) => {
  let now = Date.now();
  const fixture = await start({ oauthEnabled: true, now: () => now });
  t.after(() => fixture.close());
  const client = await register(fixture);
  const extension = await extensionFor(fixture);
  const original = await tokensFor(fixture, client, extension);
  now += 600_000;
  assert.equal((await mcpRequest(fixture, original.access_token)).status, 401);
  const refresh = (value) =>
    postForm(fixture, '/oauth/token', {
      client_id: client.client_id,
      grant_type: 'refresh_token',
      refresh_token: value,
    });
  const rotated = await (await refresh(original.refresh_token)).json();
  assert.notEqual(rotated.refresh_token, original.refresh_token);
  assert.equal((await mcpRequest(fixture, rotated.access_token)).status, 200);
  assert.equal((await refresh(original.refresh_token)).status, 400);
  assert.equal((await mcpRequest(fixture, rotated.access_token)).status, 401);
  assert.equal((await refresh(rotated.refresh_token)).status, 400);
  const another = await tokensFor(fixture, client, extension);
  const otherClient = await register(fixture);
  assert.equal(
    (await postForm(fixture, '/oauth/revoke', { client_id: otherClient.client_id, token: another.refresh_token }))
      .status,
    200,
  );
  assert.equal((await mcpRequest(fixture, another.access_token)).status, 200);
  await postForm(fixture, '/oauth/revoke', { client_id: client.client_id, token: another.refresh_token });
  assert.equal((await mcpRequest(fixture, another.access_token)).status, 401);
});

test('OAuth state survives service restart and existing schema-6 databases are extended in place', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bananabrowse-oauth-'));
  const db = join(directory, 'service.db');
  let fixture;
  try {
    const legacy = new DatabaseSync(db);
    initializeSchema(legacy);
    legacy.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('legacy', 'preserved');
    legacy.close();
    fixture = await start({ oauthEnabled: true, db });
    assert.equal(fixture.store.db.prepare("SELECT value FROM metadata WHERE key='legacy'").get().value, 'preserved');
    const client = await register(fixture);
    const extension = await extensionFor(fixture);
    const tokens = await tokensFor(fixture, client, extension);
    await fixture.close();
    fixture = await start({ oauthEnabled: true, db });
    const agent = await fixture.mcp(null, tokens.access_token);
    assert.equal((await agent.call('list_browsers'))[0].browser_id, extension.browser_id);
    const refreshed = await postForm(fixture, '/oauth/token', {
      client_id: client.client_id,
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    });
    assert.equal(refreshed.status, 200);
    await fixture.close();
    fixture = null;
    const store = new Store(db);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 6);
    store.close();
  } finally {
    if (fixture) await fixture.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SDK performs discovery, DCR, PKCE authorization, token exchange and MCP initialization', async (t) => {
  const fixture = await start({ oauthEnabled: true });
  t.after(() => fixture.close());
  let information, tokens, verifier, authorizationUrl;
  const provider = {
    redirectUrl: REDIRECT,
    clientMetadata: {
      client_name: 'SDK client',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    },
    clientInformation: () => information,
    saveClientInformation: (value) => {
      information = value;
    },
    tokens: () => tokens,
    saveTokens: (value) => {
      tokens = value;
    },
    codeVerifier: () => verifier,
    saveCodeVerifier: (value) => {
      verifier = value;
    },
    redirectToAuthorization: (url) => {
      authorizationUrl = url;
    },
  };
  const options = {
    authProvider: provider,
    fetch: (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      assert.equal(url.origin, ORIGIN);
      return fetch(`${fixture.base}${url.pathname}${url.search}`, init);
    },
  };
  const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), options);
  const client = new Client({ name: 'sdk-test', version: '1' });
  t.after(() => client.close());
  await assert.rejects(client.connect(transport), UnauthorizedError);
  assert(information.client_id);
  const response = await fetch(`${fixture.base}${authorizationUrl.pathname}${authorizationUrl.search}`);
  assert.equal(response.status, 200);
  const html = await response.text();
  const extension = await extensionFor(fixture);
  const code = await extension.pairingCode();
  const pending = postForm(
    fixture,
    '/oauth/authorize',
    {
      request_id: /name="request_id" value="([^"]+)"/.exec(html)[1],
      csrf: /name="csrf" value="([^"]+)"/.exec(html)[1],
      decision: 'approve',
      code,
    },
    { Origin: ORIGIN, Cookie: response.headers.get('set-cookie').split(';')[0] },
  );
  const proposal = await extension.next('pairing.proposal');
  extension.send({ type: 'pairing.decision', request_id: proposal.request_id, approved: true });
  const callback = new URL((await pending).headers.get('location'));
  await transport.finishAuth(callback.searchParams.get('code'));
  assert(tokens.access_token);
  await client.close();
  await client.connect(new StreamableHTTPClientTransport(new URL(RESOURCE), options));
  assert.equal((await client.listTools()).tools.length, 31);
});
