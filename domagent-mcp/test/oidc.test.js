import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createOidc } from '../oidc.js';

const ISSUER = 'https://identity.test/tenant/';
const AUTHORIZATION = 'https://login.identity.test/authorize';
const ORIGIN = 'https://domagent.test';
const CLIENT = 'domagent-test';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

function idToken(claims) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}`;
  return `${payload}.${sign('RSA-SHA256', Buffer.from(payload), privateKey).toString('base64url')}`;
}

test('OIDC library binds discovery, PKCE, state, nonce, issuer, audience and expiry', async t => {
  const flow = { state: 'expected-state', nonce: 'expected-nonce', verifier: 'v'.repeat(64) };
  const claims = {
    iss: ISSUER, sub: 'immutable-owner-subject', aud: CLIENT,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
    nonce: flow.nonce,
  };
  let returnedClaims = claims;
  let discoveryIssuer = ISSUER;
  let exchanges = 0;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/.well-known/openid-configuration')) {
      return Response.json({
        issuer: discoveryIssuer, authorization_endpoint: AUTHORIZATION,
        token_endpoint: `${ISSUER}token`, jwks_uri: `${ISSUER}jwks`,
        response_types_supported: ['code'], subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
      });
    }
    assert.equal(url.href, `${ISSUER}token`);
    assert.equal(options.method, 'POST');
    const body = new URLSearchParams(options.body);
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('code'), 'test-code');
    assert.equal(body.get('redirect_uri'), `${ORIGIN}/oidc/callback`);
    assert.equal(body.get('code_verifier'), flow.verifier);
    assert.equal(body.get('client_id'), CLIENT);
    exchanges++;
    return Response.json({
      access_token: 'fixture-access-token', token_type: 'Bearer', expires_in: 300,
      id_token: idToken(returnedClaims),
    });
  });
  const config = { origin: ORIGIN, issuer: ISSUER, clientId: CLIENT, protectedOrigins: [ORIGIN] };
  const provider = await createOidc(config);
  assert(config.protectedOrigins.includes(new URL(AUTHORIZATION).origin));
  const authorization = new URL(await provider.start(flow));
  assert.equal(authorization.origin, new URL(AUTHORIZATION).origin);
  assert.equal(authorization.searchParams.get('state'), flow.state);
  assert.equal(authorization.searchParams.get('nonce'), flow.nonce);
  assert.equal(authorization.searchParams.get('redirect_uri'), `${ORIGIN}/oidc/callback`);
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(flow.verifier));
  assert.equal(authorization.searchParams.get('code_challenge'), Buffer.from(digest).toString('base64url'));

  const callback = new URL(`${ORIGIN}/oidc/callback?code=test-code&state=${flow.state}`);
  assert.deepEqual(await provider.finish(callback, flow), {
    issuer: ISSUER, subject: 'immutable-owner-subject',
  });
  const priorExchanges = exchanges;
  await assert.rejects(provider.finish(new URL(`${ORIGIN}/oidc/callback?code=test-code&state=wrong`), flow));
  assert.equal(exchanges, priorExchanges);

  for (const invalid of [
    { nonce: 'wrong-nonce' }, { iss: 'https://other.test/' }, { aud: 'another-client' },
    { exp: claims.iat - 120 }, { sub: undefined },
  ]) {
    returnedClaims = { ...claims, ...invalid };
    await assert.rejects(provider.finish(callback, flow));
  }
  discoveryIssuer = ISSUER.slice(0, -1);
  await assert.rejects(createOidc({ ...config }));
});
