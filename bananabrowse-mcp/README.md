# BananaBrowse service (v6)

Self-hosted MCP server and browser hub. Service **1.0.0-beta.2**, wire **v6**,
SQLite schema **6**. Node 22.13+ (built-in `node:sqlite`). See
[architecture](../docs/ARCHITECTURE.md).

## Configuration

| Variable | Meaning |
| --- | --- |
| `BANANABROWSE_ORIGIN` | Canonical public HTTPS origin, e.g. `https://bananabrowse.example.com` (required) |
| `BANANABROWSE_BIND`, `BANANABROWSE_PORT` | Listen address, default `127.0.0.1:18792`; keep it behind a TLS proxy |
| `BANANABROWSE_DB` | SQLite path, default `./data/bananabrowse.db`. A v5 or older DB is refused (`SCHEMA_VERSION_UNSUPPORTED`) |
| `BANANABROWSE_PROTECTED_ORIGINS` | Comma-separated origins that sessions can never share or open, e.g. your identity provider. The service origin is always protected |
| `BANANABROWSE_AGENT_<ID>` | One per agent: `"Name|https://homepage|sha256:<hex of API key>"`. `<ID>` becomes the lowercase agent ID (`_` → `-`), used in `/mcp/<agent-id>`. The homepage may be empty |
| `BANANABROWSE_ARTIFACTS_DIR` | Artifact blobs (6.1), default `<dir of BANANABROWSE_DB>/artifacts`; created 0700, files 0600. Must be writable (systemd `ReadWritePaths`) |
| `BANANABROWSE_PAIRING_SECRET` / `_FILE` | Optional HMAC key for in-memory pairing codes; random per process by default |
| `BANANABROWSE_OAUTH_ENABLED` | `true` enables OAuth authorization-code flow with DCR at `/mcp`; default `false`. Existing API-key endpoints are unchanged |

Changing configured agents requires a restart. Removing a configured agent deletes
its pairings and sessions at startup. OAuth identities are stored in SQLite and
do not require environment entries.

## OAuth with dynamic client registration

Enable `BANANABROWSE_OAUTH_ENABLED=true`, rebuild and restart. Set the MCP client's
server URL to `https://<server>/mcp`; no API key or pre-registered OAuth client is
needed. Clients discover RFC 9728 protected-resource metadata from the `401`
`WWW-Authenticate` challenge, then RFC 8414 authorization-server metadata and
the RFC 7591 registration endpoint.

The browser authorization page asks for a pairing code from **Pair an agent** in
the extension window. Submitting the form sends a pairing proposal to that
extension. No authorization code is returned until the person approves there.
The authorization heading uses the registered name, for example
“BananaClaw (Denis Treskunov) wants to use BananaBrowse”.
The page and extension mark OAuth names and websites as self-reported, not
operator-verified. Keep the extension open while authorizing.

An OAuth identity is distinct from a DCR client registration: a shared client
registration does not expose all users' browsers to each other. The identity can
pair additional browser registrations with `pair_browser`, always with local
approval. The same access token can then request sessions in either browser.
Reauthorizing that registered client through an already-paired browser reuses
the identity, but still prompts for approval. Unpairing or forgetting one browser
removes only its access and sessions; removing the last pairing revokes all
codes, grants and tokens for that identity.

Protocol and lifecycle:

- Authorization code + **PKCE S256** only. The canonical RFC 8707 resource is
  `BANANABROWSE_ORIGIN/mcp`; a supplied `resource` must match exactly. The only scope
  is `mcp`. Omitted resource/scope parameters use these fixed values.
- Redirect URIs match the registered string exactly. HTTPS is required, except
  HTTP loopback callbacks (`localhost`, `127.0.0.1`, `[::1]`). Credentials and
  fragments are rejected; there are no wildcard or arbitrary-port matches.
- DCR supports public clients (`token_endpoint_auth_method: "none"`) and
  confidential clients (`client_secret_basic`, the RFC default, or
  `client_secret_post`). Client secrets are returned only at registration.
- Consent forms expire after 5 minutes, are single-use and protected by an
  HttpOnly Secure SameSite cookie, CSRF token and same-origin POST check.
  Their `strict-origin` referrer policy preserves the browser's form POST
  Origin header without forwarding authorization URL paths or query strings.
  Authorization codes expire after 2 minutes and are single-use.
- Access tokens last 10 minutes. Refresh tokens rotate on every use, with a
  fixed 30-day authorization lifetime. Refresh-token reuse revokes that entire
  grant, without the extension refresh endpoint's grace window. Code replay also
  revokes the grant issued from that code.
- Revocation at `/oauth/revoke` revokes the matching grant and all its tokens.
  Other authorizations and pairings remain intact. Unpair all browsers to revoke
  every authorization of an identity.
- Registrations, identities and hashed codes/tokens survive service restarts in
  the existing DB. Pending consent pages do not; restart authorization if needed.
  Existing schema-6 databases gain additive OAuth tables without losing data.
- DCR and authorization/token requests are rate-limited. Registrations without an
  identity expire after 24 hours; the server caps registrations and identities at
  10,000 each, pending forms at 1,000, and token records at 100,000.

Expose `/.well-known/oauth-*`, `/oauth/*` and `/mcp` through the HTTPS reverse
proxy; the supplied proxy configuration already forwards them. Do not log request
bodies or authorization-page query strings (which can include client state), or
token and authorization-code responses. Metadata, registration, token and revocation
endpoints support CORS; the MCP endpoint retains the service's same-origin policy
when an `Origin` header is supplied. Server-side and native MCP clients are unaffected.

OAuth artifact URLs use `/mcp?artifact=<id>` with the same OAuth access token.
API-key clients continue to use `/mcp/<agent-id>?artifact=<id>` with their API key.

## Build and run

The service is strict TypeScript compiled by `tsc` to `dist/` (not committed):

```sh
npm ci                  # includes the TypeScript toolchain
npm run build:service   # tsc -p . → dist/bananabrowse-mcp/*.js, dist/shared/*.js
npm start               # node dist/bananabrowse-mcp/index.js
npm run dev             # run from source with tsx, no build step
```

Rebuild after every update before restarting the service.

## Operator CLI

```sh
export BANANABROWSE_DB=/var/lib/bananabrowse/bananabrowse.db
node dist/bananabrowse-mcp/admin.js agent-key atlas "Atlas" https://atlas.example   # new key + env line (key shown once)
node dist/bananabrowse-mcp/admin.js browsers                                        # registered browsers
node dist/bananabrowse-mcp/admin.js browser-revoke b7                               # revoke a browser, its pairings and sessions
node dist/bananabrowse-mcp/admin.js pairings
node dist/bananabrowse-mcp/admin.js pairing-revoke atlas b7
node dist/bananabrowse-mcp/admin.js sessions
```

The running service applies revocations within about five seconds and
disconnects revoked browsers.

## HTTP surface

| Route | Purpose |
| --- | --- |
| `GET /health` | Service health and protocol version |
| `GET /.well-known/bananabrowse` | Public metadata (`service`, `version`, `protocol_version: 6`, `origin`) |
| `GET /api/challenge` | Single-use nonce for registration and token proofs (extension origins only) |
| `POST /api/browsers` | Self-registration `{name, key_id, public_key, nonce, signature}` → `browser_id`, refresh token, access token |
| `POST /api/token` | Key-bound refresh `{browser_id, refresh_token, nonce, signature}` → rotated refresh token and a 10-minute access token |
| `GET /extension` (WebSocket) | Browser connection: `hello` with access token → `challenge` → `proof` signed by the device key → `welcome` |
| `POST /mcp/<agent-id>` | Streamable HTTP MCP, `Authorization: Bearer <key>`, stateless |
| `GET`/`HEAD`/`DELETE /mcp/<agent-id>?artifact=<artifact_id>` | Download (`X-Content-SHA256`, `Content-Disposition: attachment`) or delete one of the agent's artifacts; same bearer key as MCP; foreign/expired IDs are `404` |
| `GET /.well-known/oauth-protected-resource[/mcp]` | OAuth resource metadata (when OAuth is enabled) |
| `GET /.well-known/oauth-authorization-server` | OAuth issuer, endpoints, grants and PKCE metadata |
| `POST /oauth/register` | Dynamic OAuth client registration; no browser authority |
| `GET`/`POST /oauth/authorize` | Browser authorization form and extension pairing approval |
| `POST /oauth/token` | Form-encoded authorization-code exchange or refresh-token rotation |
| `POST /oauth/revoke` | Form-encoded token revocation, authenticated as the registered client |
| `POST /mcp` | OAuth-authenticated stateless MCP; bearer access token identifies the agent |
| `GET`/`HEAD`/`DELETE /mcp?artifact=<artifact_id>` | OAuth-authenticated artifact access scoped to that identity |

Registration is open and rate-limited. A registered browser can do nothing
until a person pairs an agent in its window. Unpaired browsers are deleted
after 24 hours offline, paired ones after 30 days offline (with their pairings
and sessions); agents can drop a stale pairing themselves with `unpair_browser`. Refresh tokens rotate on every use. Reusing a superseded
token within 5 minutes is tolerated (lost responses); after that it revokes the
browser. Every refresh also needs a fresh signature from the browser's
non-extractable key.

The server pings each browser every 30 s and drops it after 90 s of silence.
Proxy idle timeouts must exceed 30 s. Long MCP calls (`pair_browser`,
`request_session`, `request_handoff`) stream SSE keepalives every 15 s and can
wait up to 600 s.

## Agent workflow and recovery

### Task-owned sessions

Use one native tab group per task, not a shared group for every task using the
same agent credentials. The server cannot infer task boundaries from MCP
connections; the agent starts a new session for each new task.

1. Generate a fresh random lowercase UUID `request_key` and retain it with the
   original `browser_id`, `purpose`, `urls` and `title`.
2. Call `request_session({browser_id, request_key, purpose, urls?, title?})`.
   After approval it returns session metadata, tabs and a private `session_token`.
3. Include `session_token` in **every session/tab call**, including page tools,
   `list_tabs`, `create_tab`, `close_tab`, `report_progress`, `request_handoff`
   and `end_session`. The token must belong to the target session, even when
   multiple tasks share the same agent identity.
4. When done, call `end_session({session_id, session_token})`. Tabs are ungrouped
   and stay open; `close_tabs: true` still requires local approval. Never use
   `unpair_browser` for routine task cleanup: it revokes all the agent's sessions
   on that browser.

`list_sessions` is metadata-only: it never returns tokens or request keys.
Knowing a session/tab ID does not authorize operating on it. A missing token is
`INVALID_ARGUMENTS`; an incorrect token or a foreign ID is `NOT_FOUND`, before
any browser command or approval prompt. Browser pairing/unpairing and artifacts
remain agent-scoped. Capabilities protect against accidental cross-task use;
deliberately sharing the token or request key shares access.

Keep the token, request key and original arguments privately in task context,
including across compaction. If a response is lost, repeat `request_session`
with the **same key and original arguments** to recover the same session and
token without another approval, including after a service restart or while the
browser is offline. `timeout_seconds` may change. A concurrent duplicate gets
`SESSION_REQUEST_PENDING`: wait and retry the same request. Changed creation
arguments return `SESSION_REQUEST_CONFLICT`. A request cancelled/declined before
commit creates no session and can be retried with the same key.

Recovery records survive session termination for seven days; during that time
the same key returns `SESSION_ENDED` rather than reopening a group. Never reuse
old request keys, even after that retention period. Unpairing removes recovery
records. The service persists hashes of request keys/tokens and a server
signing key, not plaintext task credentials. Tokens/keys are never sent to the
extension. If both credentials are lost, there is no automatic reclaim:
ask the user to end the orphaned group and approve a new one. Tokenless sessions
from older service versions are similarly not claimable; see
[the upgrade notes](../docs/V6-UPGRADE.md#task-owned-sessions).

### Connection recovery

`list_browsers.online` is a point-in-time connection check, not a reservation.
`BROWSER_OFFLINE` can mean either a closed window or connection loss; retry
session creation only with the same task's request key and original arguments.
`SESSION_DETACHED` means the existing session is not yet usable, for example
while reconnecting or awaiting Chrome reattachment confirmation.
Session-request offline failures include `offline_reason` when observed:
`graceful_disconnect`, `connection_lost`, `heartbeat_timeout`,
`connection_replaced`, `service_stopped`, or `unknown`. Recent observations
expire after 90 seconds; they are not a claim about the current window state.
An approved request that disconnects before inventory returns its committed
detached session and token, rather than inviting a retry that creates another group.

Start with `get_page_snapshot`. `inspect_element` is an immediate read-only
selector/readiness probe: zero matches are missing, one has readiness details,
and multiple matches are ambiguous. It does not focus or scroll. A successful
DOM action receipt is not proof of the application's intended outcome; inspect
the resulting page. After `OUTCOME_UNKNOWN`, never blindly replay the mutation.

Check `list_tabs.capabilities` before optional operations. Chrome supports
screenshots; Firefox requires `tabs.captureTab`, which may be unavailable.
Use a DOM snapshot when screenshots are unsupported. `max_output_bytes` bounds
serialized MCP output including its wrapper; `max_text_chars` applies only to
text-extraction tools, not arbitrary script results. For bulk script data,
use `return_as: "artifact"` and download the result.

Common page failures include `INVALID_SELECTOR` (fix CSS syntax),
`ELEMENT_AMBIGUOUS` (narrow the selector or use a snapshot ref),
`ELEMENT_NOT_FOUND` (probe or wait for content), and visibility/obstruction
errors (diagnose with `inspect_element`). `WAIT_TIMEOUT.last_error` identifies
the readiness condition that did not resolve. Tool errors include recovery
hints where applicable.

## Structured extraction

`query_all` reads rendered rows without arbitrary scripts, scrolling, focus
changes or other mutations. It uses the current document and open shadow roots;
iframes, closed shadow roots and extension controls are excluded.

```json
{
  "tab_id": "t12",
  "description": "Read listing titles, prices, and links to compare the available items.",
  "selector": ".listing",
  "fields": {
    "title": { "selector": ".title" },
    "price": { "selector": ".price" },
    "href": { "selector": "a", "attribute": "href" }
  },
  "limit": 50,
  "timeout_ms": 0,
  "max_text_chars": 4000,
  "max_output_bytes": 16384,
  "return_as": "value"
}
```

Selectors are site-specific; use a snapshot or read-only inspection to discover
them. Field selectors are relative to each row, including its open shadow roots;
`:scope` selects the row itself. Each field must match at most one rendered
element. Omit `attribute` for rendered text, with editable values and hidden
content redacted. Attributes are limited to `href`, `src`, `title`, `alt`,
`datetime`, and `aria-label`; form values and HTML are not exposed. `href`/`src`
are resolved against the element's base URL and restricted to HTTP(S).

Results contain `document`, `scope`, `rows`, `matched_count`, `returned_count`,
`rows_truncated`, `field_issues` and `truncated`. Counts cover rendered,
in-scope rows present at extraction time, not the site's total dataset.
`field_issues` names the zero-based row, field, and reason (`missing`,
`redacted`, `unsupported_url`, or `text_truncated`). Unavailable values are
`null`; empty rendered text is `""`. Missing fields are not mistaken for
complete extraction. Multiple matches fail with `ELEMENT_AMBIGUOUS`, including
`query_field` and `row_index`; invalid field selectors report the same location
with `INVALID_SELECTOR`. No rows yields `ELEMENT_NOT_FOUND`, or `WAIT_TIMEOUT`
with `last_error` after a positive wait.

Limits: 1–20 fields, 50 rows by default (maximum 100), and 4000 characters per
text field (maximum 16000). Field names are 1–40 ASCII letters/digits/underscores,
start with a letter, and cannot be `constructor` or `prototype`. Text truncation
never splits a surrogate pair. `timeout_ms` defaults to 0 for row readiness and
is capped at 10000; existing document-readiness checks still apply.

Inline output uses the normal 16 KiB budget (maximum 64 KiB), including the MCP
wrapper. Only complete rows are removed to meet it; if one row cannot fit,
`RESULT_TOO_LARGE` is returned. `return_as: "artifact"` with optional
`artifact_name: "listings.json"` stores the JSON result through the existing
artifact system, bypassing inline trimming but not the requested row/text
limits or transport/artifact caps. It does not collect additional pages.
Check tab capabilities first: `query_all` requires extension 1.0.0-beta.2
(numeric version 0.9.0.2). Older extensions return `CAPABILITY_UNAVAILABLE`
before dispatch, with no script fallback.

## State

SQLite holds browsers (public key, hashed refresh tokens), pairings, sessions
and tab ID rows. Sessions last 7 days from the last time the browser reported
their group alive, and are deleted as soon as an inventory shows the group gone.
No commands or activity history is stored on the server. Page content is
stored only as artifacts an agent explicitly creates (`evaluate_script` or `query_all` with
`return_as: "artifact"`): agent-scoped, 24 h TTL, 64 MiB / 100 per agent, oldest
evicted first, pruned when the agent is removed from the configuration. Access
tokens, pairing codes, pending requests and live tab state are in memory, so a
restart disconnects browsers briefly; they refresh their tokens, reconnect and
reattach automatically.

Logs are JSON lines with IDs and fixed codes only, never page data, codes,
tokens or scripts.

## Deployment

See [`../deployment`](../deployment): a systemd unit, a compose file, an env
example and an nginx example (WebSocket upgrade and a long read timeout). Back up
the DB with SQLite's backup API while the service is stopped or idle.
