# Tenant-scoped pairing and deployment

The 4.3.0 service uses [single-tab workspaces](COLLABORATIVE-BROWSING.md).
Positive consent lives in browser-owned panels, never webpage DOM.
Identity setup remains; live connections require wire protocol v4.

## Trust and authorization

DomAgent, its independent host/TLS proxy, configured OIDC provider, browser,
extension package, and update channel are trusted. Agents and webpages are not.
DomAgent is generic: calling applications handle their own configuration and
credential managers. The service never needs their internal group IDs.

An authenticated account from the configured OIDC provider approves creation of a server-generated tenant and its
initial client. Server admission does not confer membership in other tenants.
Tenant owners may add/remove admitted accounts. Browser pairing makes the
tenant's initial client eligible to request control; it creates no active grant.

Accounts register automatically on first validated OIDC sign-in; no invitation
prerequisite is required. Access to the OIDC application can be restricted at the
provider. Existing disabled accounts remain blocked. Provider profile names are
display labels only; exact issuer/subject determines identity and tenant access.

Every HTTP MCP request authenticates and matches its credential's tenant to
`/mcp/<tenant>`. WSS `/extension/<tenant>` authenticates the device key in that
tenant. Protocol v4 binds origin and tenant into every signed transcript, including
the selected tab and dedicated window IDs in sharing approval.
Cross-tenant client/device relationships are rejected. Bare `/mcp`, `/extension`,
legacy enrollment endpoints, and older protocol proofs are no authorization fallback.

## Setup and enrollment

Anonymous `POST /api/setup-requests` creates an expiring pending request only.
Requester name/explanation are escaped, unverified plain text; they do not
authorize creation. Link tokens and separate status receipts are random 256-bit
values, stored as hashes. Requests expire after 15 minutes.

The secret approval link uses a fragment. Packaged same-origin JS removes it from
history and establishes provisional HttpOnly setup-flow state. GET previews do
not approve or consume the link. Existing OIDC state/nonce/PKCE and session/CSRF
checks govern explicit signed-in user approval. Approval creates at most one tenant
and shows a client credential once. Status polling returns public URLs only.
Never log request bodies, token-bearing URLs, credentials, page contents, or proofs.

The public `/join/<tenant>` link is the single extension setup input. It provides
no membership. Per-pair nonextractable P-256 keys live in extension-private
IndexedDB; keys are not hardware-backed protection from OS compromise.

Tenant enrollment challenges are one-time (60 seconds); transactions expire
after five minutes. After the tenant member approves the exact device transaction
on the server, the extension automatically submits its bound key confirmation
and authenticates WSS. This deliberately replaces beta.2's second local pairing
confirmation. Server/page success alone is not proof; the extension validates
the transaction and actual handshake.

Tab sharing still requires a separate local approval. Subsequent actions wait for
individual approval or per-tab **Allow all while sharing**, without a capability
checklist. Broad website permissions are requested only at local sharing, not
during enrollment. Multiple saved pairings have one active connection. Switching
invalidates old queues, proofs, and grant authority before connecting the new pair.

## Runtime guarantees and limits

- Five-second heartbeats; silent devices lose authority at 15 seconds plus
  scheduling delay. Identity reconnect never restores grants.
- Identity remains connected while no tab is shared. Firefox uses a persistent
  MV2 background page to avoid idle event-page suspension; Chrome retains its
  MV3 worker. Neither requires a popup or settings page to remain open.
- User-selected existing or newly opened tabs only; explicit target IDs on every
  operation, multiple shared tabs and no automatic current-tab adoption.
- Serialized target queue capped at 32. Human waits default to 300 seconds, max
  600; execution gets a separate 25-second deadline after local approval.
  Cancellation before execution removes work; uncertain mutations end control
  and never retry.
- Local denial has a 30-second prompt cooldown.
- Protected origins include the entire service origin, identity/authorization
  provider origins, and configured control-plane sites. Block redirects and
  subresources before allowing a grant.
- Ordinary page-world scripts only. No raw CDP, browser cookie/profile extraction,
  privileged schemes, or unshared-tab access.
- `ELEMENT_NOT_FOUND` and `INVALID_SELECTOR` are selector failures.
  `TARGET_STALE` is a document race; don't automatically retry mutations.
  `PAGE_UNAVAILABLE` ends unusable authority and requests fresh local approval.
- Successful click/type acknowledgements can survive the navigation they caused;
  page results and work queued for the previous document stay invalid.
- Snapshot/reference actions are limited to the top-level page and
  open shadow roots. New snapshots invalidate old refs; replacement elements
  never inherit an old ref. DOM input retains the current approval boundary.
  Readiness waits recheck grant/cancellation/document binding before each
  attempt, never replaying an executed mutation. `wait_for_page` follows
  ordinary navigation without changing which tab is shared.
- Firefox screenshot support requires `tabs.captureTab`; it is absent in the
  tested build, so capture is not advertised. Page CSP can deny supplied scripts.

The page-edge border/banner is a helpful, spoofable DOM decoration, not a
security boundary. Positive action approval and Done exist only in exact
packaged extension UI. Webpage positive decisions are unconditionally rejected:
a real click in a page-controlled layout is not sufficient consent evidence.
Its negative Stop may close only its nonce/document-bound shared tab.
Toolbar/extension UI state is independent. Cosmetic failures warn rather than
claim tamper-proof decoration or disabling otherwise usable sharing.
Banner warnings are scoped to the currently shared tab and clear when rendering
recovers or sharing ends. Historical cosmetic failures must not override current
connection/sharing status. Human assistance shows Done/Cancel without revoking
sharing. Stop/disconnect always requires fresh explicit tab sharing afterward.

Tabs share website sign-ins, readable cookies/storage, and internal-network
access. Text/images/scripts may expose private information. Visible login/password
or CAPTCHA controls no longer automatically revoke the shared session; agent code
should request human assistance rather than handle credentials. Allow-all page
scripts are not secret-isolating. Normal cookies/login state and opener links
are preserved; the dedicated window is visibility/ownership, not a sandbox.
Stop/explicit Disconnect closes owned tabs and loses unsaved state. Revocation,
unexpected disconnect or browser-refused pages retain the response for inspection.
Closing stops document scripts but cannot undo requests/account changes or
site background workers. Extra tabs/popups or moving the controlled tab revoke
authority; no new tab is auto-adopted and unrelated tabs are never closed.

Extension-private history is capped at 200 metadata-only events. It excludes
descriptions, arguments, source, values, URLs and page contents; errors saving it
are surfaced. It is a command/observed-event log, not a full script-effect audit.

## Deployment

| Variable | Purpose |
| --- | --- |
| `DOMAGENT_ORIGIN` | Canonical HTTPS service origin |
| `DOMAGENT_OIDC_ISSUER` | Exact HTTPS issuer, preserving path/trailing slash |
| `DOMAGENT_OIDC_CLIENT_ID` | This service's own registration |
| `DOMAGENT_OIDC_CLIENT_SECRET_FILE` | Restricted confidential-client secret file, optional for public clients |
| `DOMAGENT_PROTECTED_ORIGINS` | Additional comma-separated control-plane origins |
| `DOMAGENT_BIND` / `DOMAGENT_PORT` | Private backend listener, default loopback / 18792 |
| `DOMAGENT_DB` | Private state path |

Use [systemd](../deployment/domagent.service) or
[compose](../deployment/compose.yaml) behind [a TLS proxy](../deployment/nginx.conf.example).
The systemd example is a system service template; the running user-level install
may use different paths. Keep secret/state files private, use an unprivileged
service identity and restricted permissions, and do not share the container
daemon or administration with untrusted client applications.

SQLite has one schema version and rejects 2.x beta.2 state until explicitly migrated.
Follow [the coordinated migration procedure](TENANT-MIGRATION.md). Do not hot-
restart an upgraded worktree without reviewing the database/endpoint transition.
Rollback requires matched database and code versions.
3.x tenant databases/device identities need no schema migration for collaboration.
Update server and extensions together, reconnect with v4, and explicitly share
tabs again. Existing grants and allow-all state never survive a restart.
Older v3 clients are rejected because their webpage consent controls are unsafe.
No database/credential reset is needed. Matched rollback restores that weakness.

Audit logs are allowlisted metadata only. Keep raw proxy access logs disabled
and review proxy errors/journal access. A calling application may retain returned
page content independently. Backups preserve revocation state, not active grants;
restoring stale credentials requires reconciliation/rotation.

Socket diagnostics record device/tenant IDs, a server-selected reason, numeric
close code, and connection duration. `HEARTBEAT_TIMEOUT` means liveness expiry;
`SOCKET_CLOSED` with 1001 means the peer or intermediary closed the connection.
It does not prove an authentication failure or a particular browser action.
Untrusted close-reason strings are never logged.

## Validation and release gates

Run the service/extension unit suite, syntax checks, both compiled builds, and
real Chrome/native Firefox tests. The extended Firefox Juggler test remains
explicitly skipped because of the known harness crash, not as proof of parity.
Test tenant isolation, preview/replay/concurrent setup, one-link installation,
automatic pairing without sharing, switching, revocation, and restart.
Also test existing-tab consent, long waits/cancellation, action approve/decline,
allow-all, forged page-message rejection, human Done after navigation, and stale
document execution. Verify actual client/proxy timeouts for human-wait calls.

Physical optional-host permission prompts, notification UX, actual deployed
OIDC/TLS, client-specific credential injection, and all advertised browser versions
need operator acceptance. Headless pre-granted fixtures do not qualify physical
prompt UX. Publish both compiled ZIPs and checksums from the tested commit;
temporary unsigned Firefox packages are not persistent production installations.
