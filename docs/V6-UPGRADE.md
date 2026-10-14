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
   Generate new keys with `node domagent-mcp/admin.js agent-key <id> "<Name>"`.
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
