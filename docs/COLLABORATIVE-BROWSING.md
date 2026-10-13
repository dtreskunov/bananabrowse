# Grouped workspace protocol v5

Policy `grouped-workspace-v1` replaces the v4 one-tab/window and per-action approval
ceremony. Persistent identity and runtime browser authority are separate.
Service5.0.0-beta.1 / extension5.0.0 is a matched breaking upgrade.

## Tools

- `adopt_browser({pairing_code})`: authenticated proposal, final local confirmation.
- `list_browser_workspaces()`: caller-linked devices, versions, connection and workspace state.
- `wait_for_workspace({device_id,description,timeout_seconds?})`: passive human wait,
  default300/max600seconds; no remote panel opening or grant creation.
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
Page: ready/loading/navigation_only/unavailable.
Unknown/foreign handles are generic NOT_AUTHORIZED. Caller-owned bounded
tombstones can explain WORKSPACE_PAUSED/INACTIVE or TAB_NOT_IN_WORKSPACE.
Refused DOM is DOCUMENT_NOT_CONTROLLABLE, with fixed inspection_stage/
injection_reason/last_error/timeout_ms where available. Raw exceptions are omitted.

## UX and lifecycle

Start creates a named native group with a blank tab. Drag or menu Add grants
existing-tab scope while active. Remove revokes immediately; re-add gets fresh
handle. Website-created tabs/popup inheritance is excluded until explicitly added.
Only grouped metadata is exposed. No focus change unless the user clicks a task
row/menu/notification. End/close/lease loss leaves tabs/group open.
Native panel restoration, browser restart and reconnect restore no runtime access.
Pause cancels backlog; explicit Resume creates a fresh execution activation.

System notification plus toolbar pending count announces human assistance.
Notification delivery failure is explicit; OS suppression cannot prove visibility.
The user click focuses a bound task, never marks it Done or bypasses Pause.
History holds at most200 metadata-only commands/events, not descriptions/source/
values/URLs and not all JavaScript effects.

Grouped tabs can navigate away from browser-owned/refused current documents
without injection into them, to ordinary permitted HTTP(S) destinations.
No new URL allowlist. Protected origins/invalid destinations remain denied.
Reduced capability never claims DOM readability, never bypasses renderer/CSP
or repeats a POST. Existing user-profile httpbin refusal remains an open
acceptance question; collect actual versions and response evidence.

See [security](SECURE-PAIRING.md), [migration](V5-MIGRATION.md) and
[browser tests](../domagent-extension/test/README.md).
