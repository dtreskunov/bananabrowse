# Grouped workspace protocol v5

Policy `grouped-workspace-v1` replaces the v4 one-tab/window and per-action approval
ceremony. Persistent identity and runtime browser authority are separate.
Service 5.0.0-beta.10 / extension 5.0.8 is the current matched release.
Runtime consent policy is `task-group-run-v1`; v5 identity/signature bytes and
schema3 are unchanged. Earlier5.0.4 extensions retain stricter sidebar gating.

## Tools

- `adopt_browser({pairing_code})`: authenticated proposal, final local confirmation.
- `list_browser_workspaces()`: caller-linked devices, versions, connection and workspace state.
- `wait_for_workspace({device_id,description,timeout_seconds?})`: default300/max600
  seconds; immediate if active, otherwise requests local browser access through a
  coalesced extension notification/control prompt. No remote activation or grants.
- `list_workspace_tabs({workspace_id})`: active grouped targets and bounded metadata.
- `create_workspace_tab({workspace_id,url?,description})`: fresh background tab,
  no adoption of existing unshared tabs, eight-tab capacity.
- `request_handoff({target_id,description,wait_timeout_seconds?})`: global notification,
  target-only wait, explicit Done/Cancel; other tabs can work.
- Existing15 page operations keep explicit target_id and operation arguments.
  No ordinary `wait_timeout_seconds`; readiness timeout_ms and execution budget remain.

Descriptions use minimum40 after trimming, maximum500 Unicode code points.
Text output is 16KiB default/64KiB maximum UTF-8 serialized content wrapper;
inspector4KiB, reads4000chars/50elements by default with explicit truncation.
Snapshots are DOM-derived, field-value-redacted, top-level/open-shadow only.
Input is DOM-based, not native/trusted keystrokes; press_key has no browser default
action guarantee. Selectors must be unique; refs/documents and resolved label/control
identity remain exact. No mutation replay after uncertainty.

## Lease and dispatch

Device hello/challenge/proof v5 authenticates the bound namespace/client.
The extension sends signed workspace.sync snapshots:

```
workspace_id, activation_id, client_id, group_id, window_id,
state, revision, lease_ms<=5000,
tabs:[{target_id,tab_id,title,url,page_state,capabilities}]
```

Signatures bind service origin, namespace, epoch and connection as well as
the payload. The host acknowledges revision with workspace.active.
Ordinary command -> automatic local preparation -> command.ready ->
command.execute (fresh bounded budget) -> result remains serialized per tab.
Workspace-level capacity is two; human handoff does not reserve ordinary slots.
Every continuation checks activation/lease/cancellation. Tab creation publishes
authority through a signed snapshot before its result can return a handle.

Workspace: active/paused/inactive. Tab execution: idle/running/waiting_for_human.
Page: ready/loading/navigation_only/unavailable. `wait_for_page` loaded is
document readiness, not application readiness; optional `content_selector`
adds a visible-match condition within the same0..10000ms deadline.
Unknown/foreign handles are generic NOT_AUTHORIZED. Caller-owned bounded
tombstones can explain WORKSPACE_PAUSED/INACTIVE or TAB_NOT_IN_WORKSPACE.
Refused DOM is DOCUMENT_NOT_CONTROLLABLE, with fixed inspection_stage/
injection_reason/last_error/timeout_ms where available. Raw exceptions are omitted.

## UX and lifecycle

Start creates a named native group with a blank tab. Drag or menu Add grants
existing-tab scope while active. Remove revokes immediately; re-add gets fresh
handle. Website-created tabs/popup inheritance is excluded until explicitly added.
Only grouped metadata is exposed. No tab/window focus change unless the user clicks a task
row/menu/notification. End/lease loss leaves tabs/group open.
Native panel restoration, browser restart and reconnect restore no runtime access.
Pause cancels backlog; explicit Continue creates a fresh execution activation.

The dashboard's presence is no longer the consent lease. A deliberate Run binds
the actual group/window/client until Pause/End, group scope loss, disconnect,
restart or revocation. Closing/minimizing the dashboard or browsing elsewhere
does not revoke Run; background group verification renews the bounded server
lease. Toolbar popup offers status, Pause all tasks and Open dashboard; opening
it or the dashboard alone never starts another group. Existing site-created
tab exclusion, group movement checks and protected-origin guards remain.

Restart diagnostics are separate from authority: discovery includes service_epoch,
service_started_at, current connection_id and terminal end_reason/ended_at.
Inactive summaries are retained up to ten minutes, scoped to the authenticated
client and stripped of tabs. After reconnect, an updated extension compares the
service epoch and can publish a signed inactive empty summary under the new
connection/fresh activation. It reports SERVICE_RESTARTED or CONNECTION_LOST
through diagnostic last_session_end (source extension_reported).
No stale active snapshot, old handle or retired activation is accepted as Resume.
Do not synthesize TARGET_EXPIRED for random unknown/foreign handles; server
restart destroys its in-memory ownership evidence. Recovery is local Start/Resume.
Optional end_reason is covered by the snapshot signature; older snapshots without
that field remain valid. Use the matched patch for full reconnect diagnostics.

The sidebar shows current failures separately from recent diagnostic history.
Successful reconnect/active acknowledgement clears resolved transport/auth errors,
not unrelated history-persistence/notification failures. Retained same-named
native groups may be chosen explicitly at Start; name alone never grants scope
and group movement/window validation still applies.
GROUP_UNAVAILABLE retires a stale local workspace whose native group was removed
or moved out of its bound window. Status coloring of a missing group never blocks
revocation/End, but unrelated API failures remain explicit.
Recovery is independent of tab rows: even an empty inactive workspace offers a
task selector with count/title previews and New task group. A single local
Continue/Start reconnects if needed, validates the selected actual native group
and creates fresh authority. Selection alone does not grant scope. Missing groups
cannot be resumed; backend membership and visibility checks remain authoritative.
The UI shows Starting until the fresh activation is acknowledged. Only local UI
messages carry inactive native-group previews; signed service snapshots and MCP
never receive unshared titles/counts. End removes local session tracking while
leaving native group/tabs intact; creating a fresh task uses a new workspace/handle,
not replay or re-pairing. Historical OUTCOME_UNKNOWN stays in Settings after fresh
activation resolves the current warning; inspect old outcomes before retrying.
The compact light/dark Preact sidebar uses an independent typed UI package,
locally bundled CSS and system fonts, one primary action, a keyboard task selector and
secondary actions/settings/diagnostics in an overflow menu. Historical end
reasons never overwrite the current healthy active-task status. Connection repair
alone does not activate a task, and no task action automatically replays a mutation.

System notification plus toolbar pending count announces human assistance.
Inactive workspace requests use separate per-request native notification IDs.
Only the authenticated bound client/device can issue, acknowledge or decline
them. Notification click opens trusted controls, never Run. The same local
permission/group/activation checks apply to Continue. Concurrent waits share a
request; new requests are bounded/rate-limited. Timeout/cancel/decline/revocation
clear pending state; stale clicked alerts cannot start anything. A disconnected
browser clears local prompts; a still-pending server wait re-announces after proof
reconnect. No prompt/authority survives a server restart.
Optional `suggested_text` (max8000 units) stays in the pending request/local UI,
not notifications/history. Copy is a local clipboard gesture, not Send or Done.
Notification delivery failure is explicit; OS suppression cannot prove visibility.
The user click focuses a bound task, never marks it Done or bypasses Pause.
History holds at most200 metadata-only commands/events, not descriptions/source/
values/URLs and not all JavaScript effects.
The trusted dashboard separately keeps a bounded 200-entry in-memory feed of
agent intent and command status, scoped to this client/window. Completed intent
is not written to history/storage; client switches clear it. Allow-all approval
appears once per fresh signed activation, not repeatedly when retention trims it.
Human-help controls remain bound to the live request, not a historical feed card.
The dashboard shows the latest 100 entries plus all live requests, so retention
never hides pending human controls.

System fonts replace bundled Figtree. Firefox theme.getCurrent/onUpdated map
supported sidebar/popup colors; native CSS system colors are the cross-browser
fallback, with forced-colors support. No images/remote theme resources are loaded.
Ordinary controlled documents have a packaged noninteractive viewport border,
not a browser tab-strip frame. It is cosmetic and removable/spoofable by the page;
no page indicator is read to grant authority. Native group/toolbar are the
control fallback. Decoration failures are explicit but nonfatal, and revocation
does not await decoration cleanup. Fullscreen/top-layer content and page DOM
changes can hide the best-effort viewport frame.

## Native script worlds and diagnostics

`evaluate_script.world` is MAIN (compatibility default) or USER_SCRIPT. Firefox
MV3/min153 uses browser-compiled user-script source; Chrome MAIN retains the
constrained debugger evaluator, while USER_SCRIPT requires browser enablement.
USER_SCRIPT shares DOM, has per-activation scratch globals/CSP, no privileged
extension APIs and messaging disabled. MAIN exposes the page's JS environment.
Never silently switch worlds or repeat an uncertain mutation. Source is parsed
and native exceptions serialized in-realm before browser Error cloning so names,
messages, stacks and causes survive; caller source is never evaluated in the
privileged extension realm. Site CSP headers are not modified.

MCP failures retain isError/code plus bounded credential-redacted diagnostics
and validation fields/limits/phase/dispatch status. Native dumps/source/values
are not added to audit/activity logs. Result size limits remain; diagnostics
truncation is explicit. Old peers receive UPGRADE_REQUIRED for new optional fields
before script dispatch, without lost identity or broadened authorization.

Contenteditable type_text uses a browser editing command instead of raw
textContent assignment; ordinary controls use beforeinput/native setter/InputEvent.
Bounded post-event readback detects tested editor reconciliation/rollback.
INPUT_REJECTED/INPUT_NOT_APPLIED are not success and do not trigger fallbacks.
DOM verification does not prove persistence, message delivery or trusted keystrokes.

Grouped tabs can navigate away from browser-owned/refused current documents
without injection into them, to ordinary permitted HTTP(S) destinations.
No new URL allowlist. Protected origins/invalid destinations remain denied.
Reduced capability never claims DOM readability, never bypasses renderer/CSP
or repeats a POST. Existing user-profile httpbin refusal remains an open
acceptance question; collect actual versions and response evidence.

See [security](SECURE-PAIRING.md), [migration](V5-MIGRATION.md) and
[browser tests](../domagent-extension/test/README.md).
