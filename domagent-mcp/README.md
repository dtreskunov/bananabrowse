# DomAgent service (v6)

Self-hosted MCP server and browser hub. Service **6.1.0-beta.5**, wire **v6**,
SQLite schema **6**. Node 22.13+ (built-in `node:sqlite`). See
[architecture](../docs/ARCHITECTURE.md).

## Configuration

| Variable | Meaning |
| --- | --- |
| `DOMAGENT_ORIGIN` | Canonical public HTTPS origin, e.g. `https://domagent.example.com` (required) |
| `DOMAGENT_BIND`, `DOMAGENT_PORT` | Listen address, default `127.0.0.1:18792`; keep it behind a TLS proxy |
| `DOMAGENT_DB` | SQLite path, default `./data/domagent.db`. A v5 or older DB is refused (`SCHEMA_VERSION_UNSUPPORTED`) |
| `DOMAGENT_PROTECTED_ORIGINS` | Comma-separated origins that sessions can never share or open, e.g. your identity provider. The service origin is always protected |
| `DOMAGENT_AGENT_<ID>` | One per agent: `"Name|https://homepage|sha256:<hex of API key>"`. `<ID>` becomes the lowercase agent ID (`_` → `-`), used in `/mcp/<agent-id>`. The homepage may be empty |
| `DOMAGENT_ARTIFACTS_DIR` | Artifact blobs (6.1), default `<dir of DOMAGENT_DB>/artifacts`; created 0700, files 0600. Must be writable (systemd `ReadWritePaths`) |
| `DOMAGENT_PAIRING_SECRET` / `_FILE` | Optional HMAC key for in-memory pairing codes; random per process by default |

Changing agents requires a restart. Removing an agent deletes its pairings and
sessions at startup.

## Operator CLI

```sh
export DOMAGENT_DB=/var/lib/domagent/domagent.db
node admin.js agent-key atlas "Atlas" https://atlas.example   # new key + env line (key shown once)
node admin.js browsers                                        # registered browsers
node admin.js browser-revoke b7                               # revoke a browser, its pairings and sessions
node admin.js pairings
node admin.js pairing-revoke atlas b7
node admin.js sessions
```

The running service applies revocations within about five seconds and
disconnects revoked browsers.

## HTTP surface

| Route | Purpose |
| --- | --- |
| `GET /health` | Service health and protocol version |
| `GET /.well-known/domagent` | Public metadata (`service`, `version`, `protocol_version: 6`, `origin`) |
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

## State

SQLite holds browsers (public key, hashed refresh tokens), pairings, sessions
and tab ID rows. Sessions last 7 days from the last time the browser reported
their group alive, and are deleted as soon as an inventory shows the group gone.
No commands or activity history is stored on the server. Page content is
stored only as artifacts an agent explicitly creates (`evaluate_script` with
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
