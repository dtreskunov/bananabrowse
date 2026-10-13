# DomAgent grouped browser workspaces

An independent, client-isolated MCP service and Chrome/Firefox extension.
Work on real browser tabs in the background while the user browses elsewhere.
Normal logins/cookies are reused: this is **not** an isolated browser profile.

## Version and upgrade

Service **5.0.0-beta.2**, extensions **5.0.0**, browser wire **v5**, DB schema **3**.
Download [the matched prerelease](https://github.com/dtreskunov/domagent/releases/tag/v5.0.0-beta.2).
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

If the browser does not allow opening its panel after asynchronous setup, click
the toolbar to start. Pairing itself creates no authority until the native panel
is open and the workspace explicitly activated.

The code is an expiring invitation, not an MCP credential. Application provisioning
and credential-vault configuration remain separate; never paste durable tokens in
chat or extension settings.

## Grouped-tab consent

An **active workspace + open DomAgent sidebar + actual group membership** grants
access. Ordinary page actions, including arbitrary JavaScript, execute without
repeated per-action prompts.

- User-added existing tabs become available; remove them to revoke.
- The agent can create new background task tabs, up to eight per workspace.
- Website-created/inherited popups are excluded until explicitly added.
- Unrelated tabs are not exposed. Two executions across tabs, one per tab.
- Pause cancels unstarted work. Resume never replays old mutations.
- Closing/replacing the native sidebar, End, disconnect or stale visibility
  lease ends authority within its bounded lease; **tabs remain open**.
- Browser/worker restart restores identity only. Explicit Resume is required.
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
npm --prefix domagent-mcp test
npm --prefix domagent-mcp run build
npm --prefix domagent-mcp run check
DOMAGENT_DB=/private/path/domagent.db node domagent-mcp/admin.js client create "Atlas"
```

See [service CLI/API](domagent-mcp/README.md),
[security and deployment](docs/SECURE-PAIRING.md),
[workspace protocol](docs/COLLABORATIVE-BROWSING.md),
[browser qualification](domagent-extension/test/README.md).

Shared-profile scripts can read page data and cause account actions. Pause/End
cannot undo sent requests, scheduled effects in other contexts or site workers.
Metadata history is a bounded commands/observed-events log, not a complete audit.
