# BananaBrowse service (v6)

Self-hosted MCP server and browser hub. Service **1.0.0-beta.3**, wire **v6**,
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

Changing agents requires a restart. Removing an agent deletes its pairings and
sessions at startup.

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

Check `list_sessions` before `request_session`: an appropriate attached session
can be reused, while every `request_session` asks for a new tab group.
`list_browsers.online` is a point-in-time connection check, not a reservation.
`BROWSER_OFFLINE` can mean either a closed window or connection loss; check
sessions before retrying a failed request so an approved group is not duplicated.
`SESSION_DETACHED` means the existing session is not yet usable, for example
while reconnecting or awaiting Chrome reattachment confirmation.
Sessions are reported attached only after their first successful inventory
sync. A malformed inventory is rejected before changing any session, tab grant
or persisted inventory metadata. Upgrade the server before extensions;
unsupported capability names remain invalid rather than being silently ignored.
Session-request offline failures include `offline_reason` when observed:
`graceful_disconnect`, `connection_lost`, `heartbeat_timeout`,
`connection_replaced`, `service_stopped`, or `unknown`. Recent observations
expire after 90 seconds; they are not a claim about the current window state.
An approved request that disconnects before inventory returns its committed
detached session, rather than inviting a retry that creates another group.

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
