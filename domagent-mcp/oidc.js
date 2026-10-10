import * as oidc from 'openid-client';
import { requireValue } from './errors.js';

export async function createOidc(config) {
  const provider = await oidc.discovery(new URL(config.issuer), config.clientId, config.oidcSecret);
  const metadata = provider.serverMetadata();
  requireValue(metadata.issuer === config.issuer, 'OIDC_ISSUER_MISMATCH');
  const authorizationOrigin = new URL(metadata.authorization_endpoint).origin;
  requireValue(authorizationOrigin.startsWith('https://'), 'INVALID_AUTHORIZATION_ORIGIN');
  config.protectedOrigins = [...new Set([...config.protectedOrigins, authorizationOrigin])];
  return {
    async start(flow) {
      return oidc.buildAuthorizationUrl(provider, {
        redirect_uri: `${config.origin}/oidc/callback`,
        scope: 'openid profile', state: flow.state, nonce: flow.nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(flow.verifier),
        code_challenge_method: 'S256',
      }).href;
    },
    async finish(url, flow) {
      const tokens = await oidc.authorizationCodeGrant(provider, url, {
        expectedState: flow.state, expectedNonce: flow.nonce,
        pkceCodeVerifier: flow.verifier, idTokenExpected: true,
      });
      const claims = tokens.claims();
      requireValue(claims && claims.iss === config.issuer && typeof claims.sub === 'string',
        'OIDC_IDENTITY_INVALID');
      return { issuer: claims.iss, subject: claims.sub };
    },
  };
}
