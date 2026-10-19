# Upgrading from v5 to v6

v6 is a clean break: wire v6, DB schema 6, new MCP tools. Nothing migrates.
Browsers register again and agents pair again.

These notes cover DomAgent 6.x and the move to BananaBrowse 1.0. The DomAgent
sections use today's BananaBrowse names for settings and files.

## Service

1. Stop the v5 service and keep its database file as a private backup (v6 refuses
   to open it: `SCHEMA_VERSION_UNSUPPORTED`).
2. Point `BANANABROWSE_DB` at a new path.
3. Remove `BANANABROWSE_OIDC_*` and `BANANABROWSE_OPERATOR_SECRET*`. Put any origins that
   must stay off-limits (for example a former identity provider) in
   `BANANABROWSE_PROTECTED_ORIGINS`.
4. Add one `BANANABROWSE_AGENT_<ID>="Name|homepage|sha256:<hex>"` line per agent.
   Generate new keys with `node bananabrowse-mcp/dist/bananabrowse-mcp/admin.js agent-key <id> "<Name>"`.
   To keep a v5 client's existing credential, reuse its stored SHA-256 hash
   (`clients.credential_hash` in the old DB) as the `sha256:` value, so no secret
   changes hands.
5. Start v6 and check `/health` reports `protocol_version: 6`.

## Agents

- Endpoint changes from `/mcp/t_<tenant>` to `/mcp/<agent-id>`. Update the MCP
  client URL and any credential-injection path rules.
- Tools changed: `adopt_browser` → `pair_browser`; `list_browser_workspaces` →
  `list_browsers` and `list_sessions`; `wait_for_workspace` → `request_session`
  (fails fast when offline); `list_workspace_tabs` → `list_tabs`;
  `create_workspace_tab` → `create_tab`; new `end_session` and
  `report_progress`. Page tools take `tab_id` instead of `target_id`, and
  `request_handoff` takes `instructions`. Rediscover tools after upgrading.

## Browsers

Install extension 6.0.0 over 5.x. The toolbar button now opens the BananaBrowse
window. Enter the server and a browser name, then pair each agent again with a
new code. Old tab groups are left alone and are not adopted.

## Rollback

Stop v6, restore the v5 code and the untouched v5 database, and reinstall the
5.x extension. v6 never writes to the v5 database.

## 6.0 → 6.1

No schema or wire-version change; upgrade the service and extensions in any
order.

- **Artifacts.** `evaluate_script` accepts `return_as: "artifact"` (plus
  `artifact_name`, `artifact_mime`, `artifact_encoding`) and returns a handle
  instead of the data. New tools `list_artifacts` and `read_artifact`; new route
  `GET|HEAD|DELETE /mcp/<agent-id>?artifact=<id>` with the MCP bearer key. It
  shares the MCP path, so credential injectors that match `/mcp/<agent-id>`
  exactly need no change. Artifacts need extension 6.1.0; older
  extensions answer `CAPABILITY_UNAVAILABLE` with `required_extension_version`.
- **Storage.** Artifacts live in `BANANABROWSE_ARTIFACTS_DIR` (default
  `<dir of BANANABROWSE_DB>/artifacts`). Under systemd hardening the directory must
  be inside `ReadWritePaths`.
- **Limits.** Browser messages may be up to 8 MiB (was 4 MiB). Reverse proxies
  that cap WebSocket frames must allow this.
- **Errors.** Error results drop stacks and causes in favor of a `hint`,
  compact `diagnostics` and code-specific details (`stale_reason`, sizes, script
  `line`/`column`/`snippet`, per-key `unexpected_field`).
- **Scripts.** Top-level `await` and `return` work in `evaluate_script`.
- **Snapshots.** Links include `href`; decorative SVG is skipped; interactive
  elements are kept first when truncating. Refs never repeat across documents
  in a tab.
- **Stale browsers (6.1.0-beta.3).** Paired browsers offline for 30 days are
  deleted with their pairings and sessions. New tool `unpair_browser` lets an
  agent drop its own pairing; `list_browsers` adds `last_seen` and `paired_at`;
  pairing renames a browser to `name (n)` if the agent already has a browser
  with that name. Remove existing orphans with `admin.js browser-revoke`.
- **Closing tabs (6.1.0-beta.5, extension 6.1.3).** New tool
  `close_tab({tab_id, description, timeout_seconds?})`; `end_session` accepts
  `close_tabs: true` with a `description`. Closing is never automatic: the
  extension shows a system notification and an approval card (the agent's
  description and the tabs affected) and closes only after the user clicks
  **Close**; **Keep open** returns `ACTION_DECLINED` and the session continues.
  The service cannot order a close: `session.end` only ungroups. Both need
  extension 6.1.3; older extensions (including 6.1.2, which closed without
  asking, shipped in 6.1.0-beta.4) get `CAPABILITY_UNAVAILABLE` with
  `required_extension_version` before anything is sent to the browser.
- **TypeScript build (6.1.0-beta.6, extension 6.1.4).** No protocol, schema or
  behaviour change. The service is now TypeScript and must be built before it
  runs: in `bananabrowse-mcp/` run `npm ci && npm run build:service` after every
  update, and start `dist/bananabrowse-mcp/index.js` instead of `index.js` (update
  systemd `ExecStart`; see `deployment/bananabrowse.service`). The operator CLI is
  `dist/bananabrowse-mcp/admin.js`. The Docker image builds this itself.

## DomAgent 6.1 → BananaBrowse 1.0

BananaBrowse 1.0.0-beta.1 renames the project and restarts versioning at 1.0.0
(extension manifests: `version` 0.9.0.1, `version_name` 1.0.0-beta.1). Wire v6
and schema 6 are unchanged, but nothing named DomAgent is accepted any more:

- **Extension.** The Firefox add-on ID is now `bananabrowse-secure@bananabrowse`
  and the browser key store is `bananabrowse-v6`. Remove the DomAgent extension,
  install BananaBrowse 1.0.0-beta.1, register the browser again and re-pair agents.
- **Wire names.** Setup reads `/.well-known/bananabrowse`, the service reports
  `service: "bananabrowse"`, the extension sends `X-BananaBrowse-Extension-Origin`,
  and the MCP server is named `bananabrowse`, so agent tools are
  `mcp__bananabrowse__*`.
- **Configuration.** Every `DOMAGENT_*` variable is now `BANANABROWSE_*`, including
  agent keys (`BANANABROWSE_AGENT_<ID>`). Existing key values keep working; new
  keys start with `bb_`. The default database is `./data/bananabrowse.db`.
- **Layout.** The packages live in `bananabrowse-mcp/` and
  `bananabrowse-extension/`; the service starts `dist/bananabrowse-mcp/index.js`
  (see `deployment/bananabrowse.service`).

## BananaBrowse 1.0.0-beta.1 → beta.2

Wire v6 and schema 6 are unchanged. Update and rebuild the service, then update
the Chrome/Firefox extension to 1.0.0-beta.2 (numeric manifest 0.9.0.2).
Existing registrations, pairings and sessions are preserved; no re-pairing or
database migration is needed.

- **Structured extraction.** `query_all` reads rows with relative field
  selectors and supports inline JSON or artifacts. It requires extension
  0.9.0.2; an older extension receives `CAPABILITY_UNAVAILABLE` with
  `required_extension_version` before dispatch. Existing operations continue
  to work with beta.1 extensions.
- **Session reliability.** Fixes synchronous approval/inventory cleanup and
  returns an already-approved detached session if the connection drops before
  its first inventory. No automatic session-request replay is introduced.
  Offline session-request errors now include a recent observed reason when
  available, rather than assuming the user closed the window.
- **Agent guidance.** Check existing sessions before requesting another group,
  use read-only selector probes, verify application outcomes after actions,
  and check optional capabilities before calling them.
