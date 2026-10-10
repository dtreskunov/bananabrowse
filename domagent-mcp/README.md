# DomAgent standalone service

This private beta replaces the upstream unauthenticated stdio/local bridge with
an independently authorized HTTP MCP and WSS service. Node 22.13+ is required.

See the [root guide](../README.md) for build, testing, invitation, deployment,
browser enrollment, and per-group BananaClaw/OneCLI configuration.

Run `npm ci --ignore-scripts`, then `npm test` and `npm run build`.
Run `node index.js` only with the HTTPS origin and direct OIDC configuration.
The underlying listener is intended for a trusted TLS proxy, not public plaintext
access. Use `node admin.js` for issuer/subject invitations and owner disablement.

No package publication or live BananaClaw configuration is performed by this
branch. Existing upstream stdio clients require migration to authenticated HTTP
MCP with explicit `target_id` parameters.
