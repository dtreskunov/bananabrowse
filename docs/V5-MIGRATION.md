# v4 -> v5 migration, verification and rollback

This is a coordinated service5.0.0-beta.2 / extension5.0.0 / browser wire5 upgrade.
It removes mandatory OIDC and account membership from runtime authorization,
uses explicit client-device bindings and replaces one-tab/per-action consent
with active native-sidebar/group authority. End leaves tabs open.

## Detect and preview

Health/well-known v4 and SQLite user_version2 require explicit migration.
Unknown/newer layouts are refused, not guessed. Run the new code's read-only
preflight on the correct absolute DB path:

```sh
node domagent-mcp/migrate.js preview /private/path/domagent.db
```

Check can_migrate and namespace/client/device counts. Multi-owner membership or
orphaned devices require a separately reviewed mapping, never a flattened tenant.
Preserve credentials, IDs, public keys, revoked/disabled state and namespace URLs.
No fake owner and no extension device-key reset.

## Apply

1. Agree a maintenance boundary; all live v4 authority ends.
2. Stop the exact service; create a private SQLite backup with the backup API.
   Record durable identity hash/counts and exact v4 code/extension version.
3. Apply transactional migration with the new code:

```sh
node domagent-mcp/migrate.js apply /private/path/domagent.db --service-stopped
node domagent-mcp/migrate.js verify /private/path/domagent.db
```

Schema3 retains read-only legacy migration evidence and preserves approved
associations in client_devices. Disabled/unadmitted legacy owners remain denied;
revoked flags and original credentials stay unchanged. Sessions/pending pairing/
live grants/commands never migrate.

4. Deploy exact v5 service, restore pinned dependencies, preserve all protected
   origins (including former IdP/control-plane sites). OIDC variables no longer
   authenticate; optional static operator secret is a different credential.
   No secret configured means remote dashboard is disabled. CLI remains available.
5. Verify health/wire5, authenticated MCP catalogue21, namespace isolation and
   durable ID/hash preservation without triggering user browser actions.

## Browser and agent update

Install extension5.0.0 in place with the same browser extension identity.
Existing IndexedDB keys/config are reused and device reconnect uses its same ID.
Do not remove extension storage, re-enroll, create new credentials or import a
device key just to make migration pass. Restored groups/windows are organization
only; fresh Start/Resume is required. Old v4 extensions fail UPGRADE_REQUIRED.

Existing single-tab windows remain open. The user can add their actual tabs to a
fresh DomAgent group; nothing is moved or authorized automatically.
New installs use domain -> short code -> authenticated adopt_browser -> local
Connect and start. Agent-side MCP credential setup remains independent.

Rediscover the v5 tools and update the agent skill; there are no silently reshaped
legacy sharing-tool aliases. Routine page calls no longer accept human-wait
arguments. Existing tab handles are intentionally invalid after restart.

## Rollback

Stop v5 and restore the matched private pre-migration database and v4 code plus
extension. Do not restore a stale backup without reconciling credential rotations
or revocations made since it was taken. Rollback restores the old consent/window
behavior and is not an improved security model. Keep all backup artifacts private.

Verification compares original namespace/client/device common fields and original
owner/membership migration evidence, not live authority. Post-migration provisioning
or credential changes should be documented separately; initial exact migration
verification must occur before those changes.
