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
before restarting. Browsers must use matching protocol-v4 extensions; 3.x/4.x
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

Protocol v4 supports actual user-selected tabs moved to single-tab windows,
native side-panel approval, bounded private activity history, and supervised
actions with `description`, and **Allow all while sharing**. `request_browser_access`
waits for tab selection; `request_handoff` waits for human Done without revoking
the shared session. Human waits default to five minutes (max ten), followed by a
25-second execution budget. Configure client/proxy timeouts with headroom.
See [collaborative protocol](../docs/COLLABORATIVE-BROWSING.md).

Service 4.3.0-beta.3 / extension 4.3.3 reports connected `browser_info` versions
and allowlisted `injection_reason` inspection diagnostics. Version metadata is
self-reported and is never grant authority or package attestation; older/offline
peers return null. The user-profile-specific httpbin refusal remains unresolved:
actual form submissions are readable in disposable Firefox with either JSON
viewer setting. Do not infer MIME-type incompatibility or replay a failed POST.
Update in place to capture the safe refusal code and matching browser version.

Service 4.3.0-beta.2 / extension 4.3.1 ships the following reliability changes.
Sharing/handoff/page-action explanations require at least 40 trimmed characters
and at most 500 total; this is enforced in schemas and runtime, not a security
proof. Exact-bound re-sharing preserves active grants/queues. Page failures can
include fixed `inspection_stage` and bounded `last_error`/`timeout_ms` metadata;
transient inspection is retried before execution, never a mutation or POST.
The inspector reports bounded hiding-ancestor/reveal-control and styled-label
metadata without field values, focus or scrolling.

Service 4.3.0-beta.1 / extension 4.3.0 rejects older wire-v3 clients intentionally.
Stop/explicit Disconnect closes the controlled tab, losing unsaved state. Extra
tabs, popups and moving the tab revoke sharing without adopting other tabs.
The normal profile is reused; this window is not cookie/account isolation.
History records commands and observed events, not arbitrary script side effects.

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

Version 4.2.0-beta.1 adds inspect_element (4 KiB maximum) and explains
diagnose/reveal/refresh/act/verify in MCP initialization instructions. Extension
4.2.0 prepares operation-derived summaries before positive approvals and binds
resolved controls to the exact document/element. Older extension capabilities
remain explicit; update/reload in place and share again without resetting keys.
