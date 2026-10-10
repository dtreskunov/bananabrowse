# DomAgent service

Node 22.13+ service for generic authenticated tenant-scoped Streamable HTTP MCP
and signed browser WSS. No stdio or unscoped authorization fallback.

```sh
npm ci --ignore-scripts
npm start
```

Configuration and OIDC owner invitations are described in
[the deployment guide](../docs/SECURE-PAIRING.md).
Upgrade existing beta.2 databases through [explicit tenant migration](../docs/TENANT-MIGRATION.md)
before restarting. Browsers must use matching protocol-v2 extensions.

Public metadata: `GET /.well-known/domagent`.
Create a pending request: `POST /api/setup-requests` with `agent_name` and
`request_description`. Invited-user approval creates one tenant/client.
Poll `POST /api/setup-requests/<request>/status` using the separate status receipt;
it returns public URLs, never a credential.

The signed-in operator configures its own application using the once-shown
credential. MCP endpoint: `/mcp/<tenant>`. Device WSS: `/extension/<tenant>`.
Public extension input: `/join/<tenant>`. Browser pairing completes automatically
after server approval; local approval remains required before sharing.

Run `npm test`, `npm run build`, and `npm run check`. See
[browser tests](../domagent-extension/test/README.md) for real-browser validation
and unsupported capability/physical-prompt qualification limits.
