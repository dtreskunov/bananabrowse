# Upgrading from v5 to v6

v6 is a clean break: wire v6, DB schema 6, new MCP tools. Nothing migrates.
Browsers register again and agents pair again.

## Service

1. Stop the v5 service and keep its database file as a private backup (v6 refuses
   to open it: `SCHEMA_VERSION_UNSUPPORTED`).
2. Point `DOMAGENT_DB` at a new path.
3. Remove `DOMAGENT_OIDC_*` and `DOMAGENT_OPERATOR_SECRET*`. Put any origins that
   must stay off-limits (for example a former identity provider) in
   `DOMAGENT_PROTECTED_ORIGINS`.
4. Add one `DOMAGENT_AGENT_<ID>="Name|homepage|sha256:<hex>"` line per agent.
   Generate new keys with `node domagent-mcp/dist/domagent-mcp/admin.js agent-key <id> "<Name>"`.
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

Install extension 6.0.0 over 5.x. The toolbar button now opens the DomAgent
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
- **Storage.** Artifacts live in `DOMAGENT_ARTIFACTS_DIR` (default
  `<dir of DOMAGENT_DB>/artifacts`). Under systemd hardening the directory must
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
  runs: in `domagent-mcp/` run `npm ci && npm run build:service` after every
  update, and start `dist/domagent-mcp/index.js` instead of `index.js` (update
  systemd `ExecStart`; see `deployment/domagent.service`). The operator CLI is
  `dist/domagent-mcp/admin.js`. The Docker image builds this itself.
