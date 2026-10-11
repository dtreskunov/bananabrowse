# DomAgent service

Node 22.13+ service for generic authenticated tenant-scoped Streamable HTTP MCP
and signed browser WSS. No stdio or unscoped authorization fallback.

```sh
npm ci --ignore-scripts
npm start
```

Configuration and OIDC sign-in are described in
[the deployment guide](../docs/SECURE-PAIRING.md).
Upgrade existing beta.2 databases through [explicit tenant migration](../docs/TENANT-MIGRATION.md)
before restarting. Browsers must use matching protocol-v3 extensions; 3.x
tenant credentials and pairing identities need no reset.

Public metadata: `GET /.well-known/domagent`.
Create a pending request: `POST /api/setup-requests` with `agent_name` and
`request_description`. Signed-in user approval creates one tenant/client.
Validated users of the configured OIDC provider register automatically; no
DomAgent invitation is required. Disabled accounts remain blocked, and registration
does not grant access to another user's tenant.
Poll `POST /api/setup-requests/<request>/status` using the separate status receipt;
it returns public URLs, never a credential.

The signed-in operator configures its own application using the once-shown
credential. MCP endpoint: `/mcp/<tenant>`. Device WSS: `/extension/<tenant>`.
Public extension input: `/join/<tenant>`. Browser pairing completes automatically
after server approval; local approval remains required before sharing.

Protocol v3 supports user-selected existing tabs, multiple handles, supervised
actions with `description`, and **Allow all while sharing**. `request_browser_access`
waits for tab selection; `request_handoff` waits for human Done without revoking
the shared session. Human waits default to five minutes (max ten), followed by a
25-second execution budget. Configure client/proxy timeouts with headroom.
See [collaborative protocol](../docs/COLLABORATIVE-BROWSING.md).

Version 4.1.0-beta.1 adds document-bound snapshots, strict selector/reference targets,
actionability waits, select/check/key/scroll operations, and explicit navigation
completion. Install extension 4.1.0 to use these tools; older extensions do not
advertise the new operations. DOM input, approval and tenant
boundaries are unchanged.

Version 4.1.0-beta.2 advertises compact-output guidance through MCP initialization
instructions and tool schemas. Text results default to 16 KiB and never exceed
64 KiB, including the serialized MCP content wrapper. Reads default to 4000
characters/50 elements with explicit truncation. Prefer focused selectors before
requesting larger limits. The server enforces output budgets independently of
the extension. Explicit screenshots remain image content with separate limits.
Install extension 4.1.1 for focused snapshot arguments and specific script errors.
Device results separate connection, sharing, and pending-request state without
removing legacy status fields. Existing identities and credentials need no reset.

Version 4.1.0-beta.3 and extension 4.1.2 fix own-banner obstruction of text-like
inputs, focus approved clicks, expose safe timeout causes and viewport/control
metadata, return bounded HTML-title metadata and reject malformed target handles
while preserving legacy tokens. Real Chrome/native Firefox form POST echo tests
verify mutations and readable response pages without widening browser authority.

Run `npm test`, `npm run build`, and `npm run check`. See
[browser tests](../domagent-extension/test/README.md) for real-browser validation
and unsupported capability/physical-prompt qualification limits.
