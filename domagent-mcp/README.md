# DomAgent service 5.0.0-beta.10

Node 22.13+ authenticated tenant-scoped Streamable HTTP MCP and signed browser
wire **v5**. Existing `/mcp/<tenant>` credentials/identities and
`/extension/<tenant>` WSS endpoints are preserved; v4 browser proofs/grants are
not accepted. There is no OIDC runtime, browser-user account or fabricated owner.

```sh
npm ci --ignore-scripts
DOMAGENT_ORIGIN=https://domagent.example.net npm start
```

## Local operator CLI

Set `DOMAGENT_DB` explicitly for every command (default `./data/domagent.db`).
Run as the service OS user. The database/parent directory are private (0600/0700).

```sh
node admin.js client create "Atlas"        # alias: client provision
node admin.js client list
node admin.js client rename <client-id> "New name"
node admin.js client rotate <client-id>
node admin.js client revoke <client-id>
node admin.js device list                  # includes revoked/offline entries
node admin.js device rename <device-id> "Laptop"
node admin.js device revoke <device-id>
```

Create/rotate prints the new application credential **once**, only to the local
CLI output; put it straight into the application's vault. Never paste it into
agent chat. List/status/audit/errors never print credential hashes, keys, pairing
codes, receipts or descriptions. Revoked credentials/devices cannot be rescued by
rotation or pairing. Rename does not change IDs.

## Optional remote administration

Without `DOMAGENT_OPERATOR_SECRET` or `DOMAGENT_OPERATOR_SECRET_FILE`, `/login`,
`/dashboard` and `/api/operator/*` are disabled (404), not anonymous. Use a random
256-bit value and a private, gitignored env file or restricted regular secret
file (0600; no symlink/group/world access). Both forms together are rejected.
Serve the configured HTTPS origin through the reverse proxy.

`GET /login` accepts local credential entry via a POST form (never a URL).
Sessions are one-hour, bounded, HttpOnly/Secure/SameSite=Strict; every mutation
requires exact service Origin and session CSRF. Changing the static secret
invalidates old sessions (file rotation is detected on every request). Login
attempts are bounded per source and globally. The dashboard lists devices,
including old offline entries, and permits rename/revoke; application credential
creation/rotation remains CLI-only.

JSON equivalents: `POST /api/operator/login {secret}`, then
`GET /api/operator/clients|devices|workspaces`, and
`POST /api/operator/client|device/<id>/rename {csrf,label}` or
`.../revoke {csrf}`; `POST /api/operator/logout {csrf}`. A static operator bearer
is accepted **only** for read-only `GET /api/operator/workspaces`; the CLI
`workspace status` uses `DOMAGENT_ORIGIN` and `DOMAGENT_OPERATOR_SECRET`.
Operator credentials do not authenticate MCP or device WSS.

## Explicit schema2 migration

Starting this service on schema2 refuses `SCHEMA_MIGRATION_REQUIRED`; unknown,
unversioned populated or newer schemas also fail closed. No live auto-migration.

```sh
node admin.js migration dry-run
# Stop service, take a private SQLite backup (SQLite backup API), keep matched v4 code.
node admin.js migration migrate --service-stopped
node admin.js migration verify
# Equivalent: node migrate.js preview|dry-run|verify <db>
#             node migrate.js apply <db> --service-stopped
```

Apply is transactional with locked preflight and integrity checks. IDs, tenant
endpoints, credential hashes, public keys, revocations and approved associations
survive; `client_devices` explicitly authorizes relationships. Old
owners/memberships remain `legacy_*` migration evidence, not runtime auth.
Legacy disabled/unadmitted owners remain denied via `legacy_disabled`; revoked
flags themselves are never changed. Unusual multi-owner tenants or devices
without a client require an explicit separately reviewed mapping and are
rejected, never silently flattened. Ephemeral sessions, enrollments and setup
requests are cleared; no grant, command or lease survives.

Rollback restores the matched pre-migration DB, service and extension versions.
Review credential/revocation changes since backup before restoring anything;
never restore stale authority just to make rollback appear successful.

## Reverse pairing APIs

`GET /.well-known/domagent` returns bounded service metadata.
Extension-Origin-only APIs (no secrets in URLs):

- `GET /api/pairing/challenge` → `{origin,nonce,expires_at}`.
- `POST /api/pairing/start` → `{request_id,expires_at}`; signed P-256 key proof,
  one-time five-minute challenge, extension-generated eight-character Crockford
  code, private random 32-byte base64url receipt and label.
- `POST /api/pairing/status` signed request/key/receipt → pending/proposed/confirmed.
- `POST /api/pairing/confirm` signed exact proposal/client/tenant/nonce/receipt →
  public device/client binding; same transcript is idempotent only within the
  original five-minute lifetime.
- `POST /api/pairing/cancel` signed request/key/receipt → cancellation before binding.

The MCP client calls `adopt_browser({pairing_code})`; no pending-browser
enumeration and no browser receipt/key/application credential is returned.
Codes use domain-separated keyed HMAC with a secret generated securely in DB
metadata (optional `DOMAGENT_PAIRING_SECRET[_FILE]` override); receipts are hashed.
Keep an override stable across restarts. Collision is explicit
`PAIRING_CODE_COLLISION`; unknown/expired/cancelled/competing claims all return
`PAIRING_UNAVAILABLE`. A proposal lasts at most 60 seconds within the original
five-minute invitation, allowing a fresh claim afterward rather than indefinite
lockout. Revocation/rotation cancels pending proposals.

All address-based limits use actual socket peers; forwarded headers are ignored,
not trusted automatically. Behind a proxy the conservative source budget is
shared by that proxy. Never log bodies, bearer headers, codes or receipts.

## Workspaces and MCP

Catalogue: the existing 15 page operations, `request_handoff`, `adopt_browser`,
`list_browser_workspaces`, `wait_for_workspace`, `list_workspace_tabs`,
`create_workspace_tab` (21 total). No v4 sharing aliases.

Signed `workspace.sync` full snapshots bind client/device connection, native
group/window, UUID workspace/activation, monotonic revision and current tab
handles/capabilities. Eight windows per connection, eight tabs per workspace,
two concurrent ordinary executions per workspace, one executor per tab.
Active leases are at most five seconds; closure/Pause/End/removal/disconnect
invalidate authority. Old leases cannot reactivate: explicit fresh activation
and fresh handles are needed. The service never resumes a sidebar or replays
cancelled work. `workspace.active` acknowledges each validated revision.

Device discovery includes service_epoch/service_started_at and current connection_id.
Inactive workspace summaries retain end_reason/ended_at for up to ten minutes
without tab metadata or authority. Lease expiry and disconnect record terminal
state; revocation still removes eligibility. These summaries are client-scoped.
Updated extensions sign optional end_reason metadata and, after reconnect, may
republish only inactive empty summaries with a fresh activation. They can report
SERVICE_RESTARTED by comparing the authenticated service epoch with their saved
prior epoch; last_session_end is explicitly extension-reported context, not proof
of why a socket closed. Identity reconnect never activates the group.
Unknown old handles/tombstones still do not survive server restart; compare
generations and ask for local Resume, not credential replacement or re-pairing.

Ordinary tools take `description`, `target_id` and their operation arguments,
**not** `wait_timeout_seconds`. Descriptions count Unicode code points: trimmed
minimum 40, raw maximum 500. Scheduling uses ready/execute with a fresh
25-second execution budget, no routine human approval. `create_workspace_tab`
uses the same handshake, addresses the workspace ID, reserves capacity and
returns a handle only after a new signed snapshot publishes it. An uncertain
mutation/create result is `OUTCOME_UNKNOWN`; never auto-retry.

`wait_for_workspace({device_id,description,timeout_seconds?})` requests a trusted
local browser-access prompt when inactive (default300/max600seconds), immediate
when active. New coalesced WSS request/received/decline/cancel messages carry
connection/client bindings and TTL, not authority. Inactive peers below5.0.7
require update; ordinary active legacy use remains. Only genuine human waits use SSE heartbeats.
`request_handoff` blocks its tab, not other tabs/concurrency slots; the extension
must announce a generic global system notification and toolbar pending count,
and return `NOTIFICATION_UNAVAILABLE` on API delivery failure. Notification
click/dismiss is not Done. OS suppression cannot be detected as proof of viewing.

Only active tabs are listed. Refused/browser-owned documents can retain
navigation-only capability without DOM injection; protected origins are always
denied. No new URL allowlist. `DOCUMENT_NOT_CONTROLLABLE` alone does not destroy
a handle; capability changes come from signed snapshots. Results retain the
16 KiB default/64 KiB hard UTF-8 text-wrapper budget, 4 KiB inspector cap and
explicit read truncation; arbitrary scripts/mutation receipts never partially
succeed.

Run service tests with `node --test test/*.test.js`, syntax checks with
`npm run check`, and coordinated extension builds with `npm run build`.
Install the independent browser runtime dependencies with
`npm --prefix ../domagent-extension ci --ignore-scripts` and UI dependencies with
`npm --prefix ../domagent-extension/ui ci --ignore-scripts` before extension
builds or the combined `npm test`. The UI owns its lockfile, Preact/signals,
TypeScript and esbuild; builds type-check before bundling local CSS and fonts.
Tests use in-memory DBs and isolated loopback sockets; no production database,
browser, live migration or deployment is exercised.

Extension5.0.5 advertises explicit Run (`task-group-run-v1`) independent of its
optional sidebar dashboard. Wire5/schema3 and existing v5 signature bytes remain
compatible; new optional world/content_selector/suggested_text requests require
updated peers, otherwise UPGRADE_REQUIRED precedes dispatch. Catalogue remains21.
Validation errors expose fields/reasons/limits/units, isError:true and
not_dispatched; execution failures carry sanitized available native diagnostics
(names/messages/stacks/causes/layer/phase/world). Audit logs remain metadata-only.
