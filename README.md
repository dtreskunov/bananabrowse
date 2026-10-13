# DomAgent grouped browser workspaces

An independent, client-isolated MCP service and Chrome/Firefox extension.
Work on real browser tabs in the background while the user browses elsewhere.
Normal logins/cookies are reused: this is **not** an isolated browser profile.

## Version and upgrade

Service **5.0.0-beta.8**, extensions **5.0.6**, browser wire **v5**, DB schema **3**.
Download [the matched prerelease](https://github.com/dtreskunov/domagent/releases/tag/v5.0.0-beta.8).
Chrome ZIPs are unpacked extensions; Firefox ZIPs are unsigned temporary add-ons.
Never disable production browser signature/security checks.

This is a breaking upgrade from the single-tab v4 approval model. Migrate existing
schema2 explicitly, preserve IDs/keys/credentials and update the extension in place.
See [migration](docs/V5-MIGRATION.md). Old browser wire versions are rejected.

## Fresh install

1. Install the compiled extension and enter the HTTPS DomAgent service domain.
2. Tell your **already configured, authenticated** MCP agent the short pairing
   code displayed by the extension. No browser-user DomAgent login is required.
3. The agent calls `adopt_browser`. Confirm the proposed client locally using
   **Connect and start workspace**. Browser website permission prompts still apply.
4. Work starts in a fresh blank tab inside a named `DomAgent - <client>` group,
   with the native sidebar as a dashboard. Blank/browser-owned pages are
   navigation-only; no privileged injection is attempted.

Pairing itself creates no authority until the task is explicitly activated.
The local Connect and start workspace action grants permission and starts a
fresh group without depending on dashboard opening; use Open dashboard to watch.

The code is an expiring invitation, not an MCP credential. Application provisioning
and credential-vault configuration remain separate; never paste durable tokens in
chat or extension settings.

## Grouped-tab consent

An **explicitly started task + actual native group membership** grants access.
The sidebar is an optional dashboard: closing it does not stop a running task.
Use the toolbar popup's **Pause all tasks** or the dashboard's Pause/End to stop
new control. Ordinary page actions, including arbitrary JavaScript, execute without
repeated per-action prompts.

- User-added existing tabs become available; remove them to revoke.
- The agent can create new background task tabs, up to eight per workspace.
- Website-created/inherited popups are excluded until explicitly added.
- Unrelated tabs are not exposed. Two executions across tabs, one per tab.
- Pause cancels unstarted work. Resume never replays old mutations.
- End, Pause, disconnect, restart, revoked access or loss of verified group scope
  ends authority within its bounded lease; **tabs remain open**. Foreground focus,
  minimization and dashboard closure do not revoke an explicit Run.
- Browser/worker restart restores identity only. Explicit Resume is required.
- Service/connection generation and bounded end reasons distinguish a stopped
  session from broken pairing. Updated reconnecting extensions can republish
  inactive empty summaries only; local Resume is still required.
- Resolved authorization failures remain diagnostic history, not red current
  errors. A retained same-named group is not automatically authorized; choose
  the group using its tab count/title preview instead of re-pairing/creating
  yet another group. Raw native IDs are available in Diagnostics, not the main view.
- Recovery actions are always visible for an inactive workspace, including when
  it has zero tab rows: select an existing native group or **New task group**, then
  use the single **Continue** / **Start** action.
  End retires local tracking and leaves the old group/tabs intact; Pause keeps it
  available for Resume. A removed/moved group cannot trap End or other selection,
  and real browser API failures still surface explicitly.
- Starting fresh clears a previous current OUTCOME_UNKNOWN warning only after
  successful authentication/active acknowledgement; historical uncertainty is
  retained and does not mean the earlier operation is safe to repeat.
- Toolbar/sidebar and supported native tab menus add/remove the clicked tab.
- Moving a task to its own window is optional and pauses until revalidated.

Human assistance uses a global system notification and pending toolbar count.
The user's click takes them to the task; explicit Done/Cancel completes it.
OS notifications may be suppressed; API delivery failure is explicit.

## MCP surface and limits

21 tools: adoption, browser/workspace discovery/wait, workspace tab listing and
creation, human handoff, and the existing 15 page operations.
Every operation addresses an explicit opaque tab handle; never a current-tab
default or raw CDP method.

Useful explanations are required: at least 40 trimmed Unicode code points,
at most 500 raw code points. Routine page calls have no human-approval timeout;
element/page readiness and bounded execution/cancellation still apply.

Snapshots/reads default to 4000 characters, 50 elements, 16KiB textual MCP content
wrapper; hard limit64KiB and inspector4KiB. Truncation is explicit. Scripts and
mutation receipts fail oversized rather than returning partial JSON.
Ref/document bindings, actionability checks, DOM-only input and CSP refusals remain.

Uninspectable viewers report `DOCUMENT_NOT_CONTROLLABLE` with safe diagnostics
and reduced navigation capability; they do not justify a privileged bypass or
repeating a POST. Protected management origins and invalid destinations remain
prohibited. No new URL/site allowlists. The user's earlier httpbin permission
refusal remains an open platform/profile-specific acceptance case, not claimed
universally fixed.

## Self-hosting and administration

Node22.13+. Operator CLI provisions separately revocable clients/devices.
Remote administration is disabled unless a strong static operator secret is
configured via protected environment or restricted file. No OIDC runtime and
no browser-user account/membership ceremony.

```sh
npm --prefix domagent-mcp ci --ignore-scripts
npm --prefix domagent-extension ci --ignore-scripts
npm --prefix domagent-extension/ui ci --ignore-scripts
npm --prefix domagent-mcp test
npm --prefix domagent-mcp run build
npm --prefix domagent-mcp run check
DOMAGENT_DB=/private/path/domagent.db node domagent-mcp/admin.js client create "Atlas"
```

See [service CLI/API](domagent-mcp/README.md),
[security and deployment](docs/SECURE-PAIRING.md),
[workspace protocol](docs/COLLABORATIVE-BROWSING.md),
[browser qualification](domagent-extension/test/README.md).

## Independent extension frontend

The extension uses its own [UI package](domagent-extension/ui/package.json):
Preact, signals, strict TypeScript and a type-check-first esbuild build. Neutral
light/dark design tokens, local Figtree fonts, compact task rows, a keyboard task
selector and an overflow actions menu adapt BananaClaw's UI patterns without any
cross-project imports, shared dependency tree, backend or runtime requirement.
Fonts and notices are included in both extension packages; no CDN or remote UI
assets are used.

The sidebar derives one current status and main action from transport, task and
fresh-activation acknowledgement. **Continue** can reconnect and activate the
selected actual native group in one deliberate local click. Reconnect alone,
native restoration and selecting a group never grant control. Pause remains
resumable; End retains the tabs. Secondary task actions, connection settings and
historical diagnostics do not compete with the main action. Unconfirmed past
actions remain in Diagnostics and must be checked before repeating them.

Run `npm --prefix domagent-extension/ui run typecheck` or `npm --prefix
domagent-extension/ui test` independently. The coordinated `domagent-mcp` build
checks UI types and packages both browsers; its test command also runs the UI
state tests. These commands require only this checkout and its three independent lockfiles.

## Native scripting and richer diagnostics

Firefox requires **153+** and uses Manifest V3. Updating in the same profile
preserves the extension ID, IndexedDB device keys and pairing; the first Run/
Continue can request the optional `userScripts` permission. Firefox requires it
alone: existing installs normally grant it with one click; when both scripting
and website access are missing, a second fresh click grants website access.
No task starts after only the first grant. Chrome remains145+;
`USER_SCRIPT` additionally needs **Allow user scripts** enabled in the extension's
browser settings. These are setup permissions, not per-action approvals.

`evaluate_script` accepts `world: "MAIN" | "USER_SCRIPT"` (defaultMAIN).
MAIN accesses page globals; USER_SCRIPT shares the DOM but has isolated globals,
an extension-configured user-script CSP and no privileged extension APIs/messaging.
Firefox browser-compiles source instead of calling page eval. Chrome MAIN retains
its constrained debugger evaluator. Modes never silently switch/retry. Browser-
internal/protected pages and refused documents remain excluded. Source limits
remain65536 UTF-16 units, output16KiB default/64KiB maximum.

Errors carry sanitized exception/message/stack/cause diagnostics, validation
fields/limits and execution phase; credentials/headers/URL secrets are redacted,
truncation explicit and diagnostics are not copied into activity logs.
`wait_for_page` optionally accepts `content_selector`: one shared timeout waits
for document readiness plus a visible match (use a row OR an empty-state marker).
Without it, loaded means document-ready only. `type_text` uses browser editing
commands for contenteditable and checks bounded post-event DOM reconciliation;
this is not proof of server persistence or native keystrokes. Human handoff can
include `suggested_text` with explicit Copy; Copy does not send or mean Done.
Old5.0.4 peers retain their stricter sidebar behavior and ordinary calls, but new
world/content/handoff fields require5.0.5 or return UPGRADE_REQUIRED before dispatch.
No collection/batch/iteration tools or background jobs were added.

Shared-profile scripts can read page data and cause account actions. Pause/End
cannot undo sent requests, scheduled effects in other contexts or site workers.
Metadata history is a bounded commands/observed-events log, not a complete audit.
