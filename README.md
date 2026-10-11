# DomAgent collaborative browsing beta

Share a browser tab you choose with an MCP application. DomAgent is an independent
tenant-scoped service with OIDC sign-in and Chrome/Firefox extensions. It does not
depend on a particular agent application or credential manager.

## Install and connect

Download your browser's compiled ZIP from
[v4.1.0-beta.2](https://github.com/dtreskunov/domagent/releases/tag/v4.1.0-beta.2)
and extract all files.

- Firefox: `about:debugging#/runtime/this-firefox` -> **Load Temporary Add-on** ->
  extracted `manifest.json`. Unsigned temporary installs disappear on restart;
  do not disable signature verification.
- Chrome: `chrome://extensions` -> Developer mode -> **Load unpacked** ->
  extracted directory.

Installation opens the one-link setup wizard. Paste your public
`https://your-server/join/<tenant>` link, sign in on the page opened by the
extension, and approve. The browser connects automatically. No tab is shared yet.

Multiple saved connections have one active connection. Firefox uses a persistent
MV2 background page; Chrome uses an MV3 worker. Neither requires the popup to
stay open to keep the browser online.

## Share a tab you choose

When an agent requests access, the extension opens a small request window and
marks its toolbar. Go to the existing tab you want to share, or open a new one.
Use the extension's **Share this tab** action. The waiting MCP call returns an
opaque handle for that exact tab. It can request additional tabs separately.

Every action includes a plain-language explanation. Review it on the shared page
or in the extension:

**Approve** executes the exact action once. **Decline** rejects it.
**Allow all while sharing** accepts supported ordinary-page actions for that
client/tab until sharing ends. There is no capability checklist, no automatic
user-tab adoption, and no permission for unshared tabs or browser-profile export.

The user can interact with the tab at the same time. Human assistance such as
sign-in uses **Done / Cancel / Stop sharing**, keeping the tab shared while the
agent waits. Password/CAPTCHA detection no longer automatically revokes control.
User navigation invalidates stale queued actions, not the sharing relationship.
Do not automatically retry an uncertain mutation.

**Stop sharing** immediately disables local authority and pending work. A page
border/banner is a useful visual cue, not an unspoofable security boundary;
extension toolbar and popup state remain independent.

## MCP application setup

Validate `/.well-known/domagent`, create a pending agent setup request with
`POST /api/setup-requests`, and show the returned short-lived approval link.
Users authenticated by the configured OIDC provider register automatically.
Approval creates a separate tenant/client and shows its credential once to the
operator; status receipts return only public connection/MCP URLs.

Use the application's own secure credential-management workflow for
`https://your-server/mcp/<tenant>`. Credentials are tenant-scoped and never
belong in chat. Device WSS is `/extension/<tenant>`.

`request_browser_access` now waits for the user to share a tab.
All page operations and `request_handoff` require `description`.
Human waits default to five minutes, configurable up to ten; execution then
has a separate 25-second budget. Configure actual MCP client, proxy, and network
timeouts accordingly. A 600-second client timeout is suitable for the default
300-second human wait, not a full 600-second wait plus execution.
Tool-call responses stream SSE with heartbeat comments during human waits;
initialization/discovery remain JSON-compatible. Use an MCP-aware client.

See [collaborative protocol details](docs/COLLABORATIVE-BROWSING.md).

### Structured snapshots and reliable browser actions

Service 4.1.0-beta.1 and extension 4.1.0 add `get_page_snapshot` with document-scoped element
references and redacted field values. Actions support unique CSS selectors or
snapshot references, readiness waits, and explicit stale/disabled/obscured errors.
New tools include `select_option`, `set_checked`, `press_key`, `scroll`, and
`wait_for_page`. Top-level pages and open shadow roots are supported; iframe and
closed-shadow-root control remain out of scope.

Input remains DOM-based in both browsers. `press_key` dispatches page keyboard
events, not native keystrokes or browser default actions. The approval model and
wire protocol remain unchanged. Install the updated extension ZIP linked above
and explicitly share a tab again; existing pairing identities are retained.
See [operation semantics and examples](docs/COLLABORATIVE-BROWSING.md#structured-snapshots-and-reliable-page-actions).

Service 4.1.0-beta.2 and extension 4.1.1 make reads compact by default: 4000 text characters, 50
elements, and a 16 KiB serialized text-result budget with a 64 KiB hard maximum.
Explicit truncation flags prevent partial results being mistaken for complete
pages. Focused snapshots/selectors and bounded opt-in limits replace repeated
whole-page dumps. Script syntax, runtime, serialization and policy failures are
reported separately. Install the updated release ZIP above to use focused
snapshot arguments and the specific script errors. The server enforces output
budgets even with an older extension.

Extension `4.0.1` uses bounded local approval/execution budgets instead of requiring
the laptop's clock to match the server. This fixes a valid Allow/Allow-all action
being rejected as an invalid future deadline. Update both the server and extension;
existing tenant identities and credentials are unchanged.

## Service and development

Node 22.13+:

```sh
npm --prefix domagent-mcp ci --ignore-scripts
npm run build
npm run check
npm test
```

Start `node index.js` in the MCP package after configuring the canonical HTTPS
origin and this service's own OIDC client/issuer. Place the plaintext backend
behind a trusted TLS proxy. See [deployment/security](docs/SECURE-PAIRING.md)
and [2.x tenant migration](docs/TENANT-MIGRATION.md).

**Protocol v3 is a coordinated server/extension upgrade.** 3.x tenant databases,
credentials and device identities remain; no reset is needed. Old v2 live proofs
and grants cannot authorize the new service. Update the extensions and reconnect,
then explicitly share again. Beta.2 (2.x) databases still require explicit migration.

Browser screenshot support remains limited by the actual target-specific API;
the tested Firefox build does not expose it. Page CSP may deny scripts. No
privileged fallback or visible-tab screenshot is provided. This is an unsigned
private beta; physical permission prompts and all advertised browser versions
remain acceptance gates.

Shared tabs use existing website sign-ins and can expose private page content,
readable cookies/storage, and network/account actions. Human login does not promise
secret isolation, especially under allow-all scripts. Pause/stop cannot undo effects
or JavaScript already scheduled. Protected DomAgent/IdP management origins stay blocked.
