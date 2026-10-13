# Next release plan: browser-local grouped workspaces

Status: approved implementation specification for v5. Written 2026-10-12 UTC.
Updated 2026-10-12 23:38 UTC: global human-assistance CTA; no new URL allowlists.

Baseline: service **4.3.0-beta.3**, extensions **4.3.3**, browser wire **v4**,
source commit `8f4b1da92fa07ee0338cb0b8d6da4b2500e7201d`.

Release target: **5.0.0-beta.2**, extensions **5.0.0**, browser wire **v5**.
This is a coordinated breaking upgrade, not another v4 patch: consent, ownership,
tab/window policy, onboarding, administrative authentication and MCP discovery
all change. The MCP negotiated date version is independent of browser wire v5.

## 1. Goals and agreed product decisions

The primary experience becomes:

> Enter service domain -> tell the agent a pairing code -> confirm once ->
> work together in a named tab group, with the sidebar as a dashboard.

Confirmed scope:

- Browser users do not need a DomAgent account or OIDC login.
- One operator manages independently authenticated MCP clients.
- Client isolation remains mandatory; account/role/membership UX is removed
  from the default path.
- An actual DomAgent tab group defines access. Adding existing tabs to that group
  is consent; removing them revokes access. The title string alone is not identity.
- With an active workspace and an open DomAgent sidebar, the agent can operate
  on multiple grouped tabs in the background while the user browses elsewhere.
- No routine action approval, separate Share button or Allow-all ceremony.
- Agent-created background tabs are in scope through `create_workspace_tab`.
- End, sidebar closure and disconnect revoke authority but leave user tabs open.
- New Tab is usable as a navigation-only starting point.
- Browser-refused documents need explicit unavailable/navigation-only handling,
  not misleading offline status or repeated POSTs.
- Native tab-menu Add/Remove actions and optional movement of the whole task
  into its own window are in scope.
- Human assistance has a global system-notification CTA and browser-wide pending
  indicator; it must not depend on finding a sidebar or another browser window.
- No new URL/site/New Tab allowlists in this release. Existing protected-origin
  restrictions remain; ordinary navigation destinations retain existing rules.
- Keep useful descriptions and fix Unicode length consistency; length is not
  proof of consent.

Not in scope:

- Permission for ungrouped tabs, cookie/profile export, raw CDP or browser chrome.
- Agent tools to resume user-paused work, open the sidebar, change clients,
  regroup existing unshared tabs or broaden permission.
- Automatically adopting website-created popups or tabs.
- Bypassing protected/privileged renderers, CSP or host permission refusal.
- Browser account isolation, guarantees of complete script-effect auditing,
  or undoing requests/account changes/service workers.
- A new hosted multi-user SaaS account system, automatic report watcher,
  unlimited parallelism or a monolithic agent-task execution API.

## 2. Fresh installation and reverse pairing

### 2.1 Extension-owned initiation

1. Installation opens a minimal setup page with a service-domain field.
2. Normalize a bare hostname to HTTPS. Reject credentials, unexpected paths,
   queries/fragments and cross-origin redirects; verify bounded public metadata.
3. Request permission for that service only, not general website access.
4. Generate a nonextractable P-256 device key before knowing the client's
   namespace. Create a signed, expiring, initially unbound pairing request.
5. Display a short code, expiry, Copy and Start again. No OIDC redirect.

Default code: eight cryptographically random Crockford-style Base32 characters
displayed as `K7MP-4QTX` (40 bits), case/separator-insensitive, lifetime five
minutes. The extension generates it; the service reserves it atomically and
instructs regeneration on a collision. A word-code alternative is deferred.

The short code is an expiring invitation, not a durable MCP credential. Keep a
separate random 256-bit receipt for private status/cancellation. Store only
protected hashes of lookup secrets, with a domain-separated keyed hash for
short-code records and a dedicated server secret supplied by restricted file
or environment configuration. Do not put codes/receipts in URLs or logs.

### 2.2 Authenticated client adoption

The operator has provisioned an MCP client independently. The agent receives
the code in chat and calls `adopt_browser({pairing_code})` using that client's
existing credential.

- Credential context selects the namespace/client; caller-supplied client,
  owner or tenant IDs are not accepted.
- No pending-browser enumeration or unauthenticated adoption endpoint.
- Creation/guessing/proposal limits apply per source/client and globally.
  Only trust forwarded addresses from explicitly configured proxy infrastructure.
- A wrong or unsuccessful claim does not burn the invitation permanently.
  One pending proposal is bounded and expires; authenticated retries from the
  same client are idempotent. Competing claims cannot silently overwrite it.
  Decline can rotate the code; no guessing-driven indefinite lockout.
- Expired, cancelled and unknown codes have the same non-enumerating failure.
- The short code cannot query private status or retrieve credentials.

Extension shows the proposed client and service, identifying which display
labels are application-supplied rather than verified human identity.
One trusted local **Connect and start workspace** confirmation selects the
intended client. Decline never creates durable access.

The final signed transcript binds service origin, request/proposal IDs, public
key identity, extension origin, exact client/namespace, fresh challenge and
expiry. Recheck revocation, expiry, receipt/proof and current proposal at atomic
commit. Crash/retry/double approval produces one binding. The agent sees only
its public device/connection result, never browser keys or operator credentials.

Persistent binding and runtime workspace authority are different: pairing
without an open/activated sidebar shares no tab.

### 2.3 First workspace and later sessions

After confirmation, request any browser-required HTTP(S) website permissions
inside a real user gesture. Create a fresh blank task tab and native group in
the user's existing normal window; do not adopt the setup/sign-in tab.

Open the window-scoped native sidebar immediately when gesture rules permit.
If asynchronous setup loses activation, show one truthful **Click the toolbar
to start** instruction; never use webpage consent as fallback.

The blank/New Tab tab starts navigation-only. Once it reaches an ordinary,
permitted and inspectable site, normal capabilities become available.

Normal explicit toolbar opening can activate the remembered workspace/client.
Restored sidebars, browser startup, reconnect and extension worker restart do
not automatically resume authority; show **Resume workspace**. Keep independent
saved client bindings, but require explicit client selection when ambiguous.

## 3. Workspace and consent state machine

Initial scope: one chosen client and one managed group per browser window;
different windows can host independent workspaces. Do not add a group selector
per command. Backend limits bound aggregate work across windows.

Bind authority to client/namespace, authenticated device, connection generation,
fresh workspace ID/activation epoch, actual group ID and current window ID.
Runtime browser group IDs are not durable permission IDs.

| Event | Result |
| --- | --- |
| Explicit Start/Resume with our panel open | Active; grouped eligible tabs become authorized |
| Browse another tab/site outside group | Continue background work; do not enumerate/expose it |
| Add an existing eligible tab to active group | Issue that tab a fresh handle after protection/validation |
| Remove a tab, close it or move it out | Revoke its handle and cancel unstarted work |
| User Pause all | Paused; reject new execution, cancel unstarted work |
| User Resume while panel open | Fresh execution epoch; old queued calls do not resume |
| End session, our panel closes/replaced, socket/visibility lease lost | Inactive; invalidate authority; retain tabs/group |
| Browser/extension restart | Identity only; restored groups inactive |
| Protected management destination | Block and revoke that tab's authority; retain enforcement through pending request rejection |
| Permitted but uninspectable document | DOM unavailable; safe, explicit navigation-only state where permitted |

No foreground-tab requirement. An unfocused window can continue if its DomAgent
panel is still open: open does not mean the user is watching every action.
Implement cancellation honestly: no new command starts after local revocation;
an already executing request may finish and cannot necessarily be undone.

### 3.1 Sidebar presence is an enforced lease

Browser-native open-state evidence is required, not `ui.state` polling,
options-page existence, a live port alone or assumed document visibility.
Use a window-scoped Chrome panel, not a tab-specific panel that disappears
when the user selects an unrelated tab.

- Firefox: use `sidebarAction.isOpen({windowId})` plus our actual panel
  connection/lifecycle and generation. A different sidebar does not count.
- Chrome: qualify native open/closed events, switching to another extension's
  panel and document teardown against the actual supported engine.
- A trusted panel instance owns a fresh local lease. The host mirrors a bounded
  lease; stale extension/server messages cannot revive it.
- Initial measurable target: native closure revokes synchronously on the local
  event where available; otherwise within a maximum five-second lease. Query/
  renew roughly once per second and check fresh authority before page work.
  Test background throttling before committing those intervals.
- Pause survives incidental open events. Panel restoration/reconnection requires
  fresh explicit Resume. Only a trusted local action can initiate activation.

**Release gate:** prove both browsers' detection and bounded loss behavior.
Raise minimum versions to the first actually qualified implementations. Do not
ship an invisible-running fallback or pretend `getOptions()` proves openness.

## 4. Native group behavior and simplified UI

Group label: `DomAgent - <client label>`. Blue active, grey paused/inactive,
yellow human assistance; sidebar text repeats status so color is not the only
signal. Keep a newly started group expanded. Never infer authority from a title
match, color or a user renaming another group.

Main sidebar:

```text
DomAgent - Atlas                    Working on 2 tabs

Flight search       Reading available flights
Hotel comparison    Checking cancellation terms
Travel notes        Idle

[ Pause all ]                       [ End session ]
Recent activity                                      v
Settings                                             ...
```

- Tab rows navigate only on the user's click. Background work never steals
  focus, opens remote request windows or sends per-action notifications.
- Human work uses the global CTA described below. Sidebar **Needs your help**
  and **Done/Cancel** are secondary task context, not the only announcement.
- Keep primary controls visible at 320px sidebar width. Connections, versions,
  permission status and diagnostic details live under Settings.
- Keep bounded local metadata-only history; no script source, descriptions,
  field values, page contents or URLs persisted.
- Remove the obstructive webpage command/approval decoration or reduce it to
  optional cosmetic status. No positive webpage consent bridge.
- Rename Stop to End session and explicitly remove close-on-Stop behavior.
  Do not implement an agent `close_tab` tool in this release.

### 4.1 Add/remove entry points

Drag an existing tab into/out of the actual managed group, or use native menu:
**Add to DomAgent - Atlas** / **Remove from DomAgent - Atlas**.
Use the clicked tab ID, not whichever tab is selected. Multiple available
workspaces use a submenu. Adding while paused/inactive changes organization
only; it never starts/resumes authority.

Toolbar/sidebar provides an equivalent Add current tab action. Firefox supports
tab context since 53; Chrome's tab context is available from 150. On older
otherwise-supported Chrome, provide explicit toolbar/page-menu fallback and
feature detection. Group APIs require Firefox 139+ for full group management.
Qualify actual browser versions; current Chrome118/Firefox128 manifest minima
are not sufficient for the new feature set.

Native groups are window-local. Optional **Move workspace to its own window**
is user-only, moves real tabs and preserves their documents/state. Pause before
movement, revalidate the entire group/window and verify the new panel is open;
resume only after that local gesture and successful rebinding. Moving/ungrouping
tabs outside this managed transition fails closed. Never close unrelated tabs.

### 4.2 Global human-assistance CTA

`request_handoff` creates one extension-owned system notification through the
browser notifications API, visible outside the task window/sidebar:

```text
DomAgent needs your help
Atlas is waiting for you to complete a browser task.
Click to go to the task.
```

Use notification-click as the cross-browser CTA. Offer a Go to task button only
where the native API supports it; do not assume Firefox supports Chrome's
notification buttons or persistence flags. No new browser window, injected
webpage consent prompt, or automatic focus stealing.

- The user's click focuses the exact still-authorized task tab/window and
opens the trusted task controls where browser gesture rules allow. Review
the full unverified instruction there; completion still needs explicit
Done/Cancel. Clicking or dismissing the notification never means Done.
- Display a browser-wide toolbar badge with the count of pending human tasks,
plus an accessible title. It remains until completion/cancellation/expiry
and routes the user's toolbar click to pending assistance. It is a fallback
indicator, not a replacement for the global announcement.
- Coalesce multiple pending tasks into bounded notifications/counts; no repeated
alert per polling cycle, command or agent retry. Only explicit human-assistance
requests trigger this attention channel. Use one reminder only if separately
enabled; default is no automatic reminder.
- Notifications contain generic task/agent context, not raw URLs, account data,
page contents, typed values or scripts. Do not persist arbitrary descriptions
in OS notifications. Application labels remain unverified.
- Verify notification creation/permission failures explicitly and surface
delivery state to the waiting MCP call and trusted UI. Do not pretend the user
was alerted if delivery failed. A browser API's successful creation cannot
prove the user saw the notification: OS do-not-disturb and notification
settings can suppress it. Document that platform limit.
- Every click is bound to request/target/workspace epoch. Removed tabs, expired
tasks or ended workspaces cannot be reopened as active authority by a stale
notification. Clear obsolete notifications and decrement pending counts.
- Human wait blocks only its target tab; other grouped work can continue.
Pause/End semantics still apply, and notification handling cannot bypass a
user pause or silently restart an inactive workspace.

Qualification must exercise Firefox and Chrome notifications from a background
group while the user is in another window/application, plus denied/suppressed
notifications, duplicate requests, cancellation and stale notification clicks.

### 4.3 Popups, inherited membership and new tabs

Do not assume every group-membership event is a deliberate user consent gesture.
Website-created tabs/popups can inherit membership. Record them as excluded at
creation; do not grant handles simply because they were born grouped. Make them
visibly excluded or move them outside the managed group without focus changes
where safely supported. The user can explicitly add them through the menu or
remove/re-add them. Native group auto-inheritance must be covered by tests.

`create_workspace_tab` is a distinct authorized extension operation: it can
create a fresh background tab in the active workspace, but cannot adopt another
existing tab. Reserve capacity atomically; create blank, group, install protection
and validate before any requested network navigation, then publish a handle.
Pause/end/removal races revoke it. If partial creation fails,
clean up only the fresh known tab and surface the error; never report a successful
grant. Do not repeat creation automatically after an uncertain result.

Initial limits: eight authorized tabs per workspace, two concurrent page
executions per workspace, one command at a time per tab. Keep aggregate service
limits and existing per-tab bounded queues. Document these defaults; don't add
an unnecessary general scheduling framework.

## 5. MCP contract

Proposed v5 catalogue: the existing 15 page tools, `request_handoff`, and five
workspace/adoption tools (21 total if legacy aliases are omitted).

| Tool | Contract |
| --- | --- |
| `adopt_browser({pairing_code})` | Propose binding using authenticated caller identity; return proposal/status, no credential |
| `list_browser_workspaces()` | Caller-scoped device/workspace lifecycle and browser versions; no unrelated tabs |
| `wait_for_workspace({device_id,description,timeout_seconds})` | Bounded wait for user activation; immediate if already active, no remote sidebar opening or repeated prompts |
| `list_workspace_tabs({workspace_id})` | Bounded eligible tab metadata, explicit handles, execution/page states and effective capabilities |
| `create_workspace_tab({workspace_id,url?,description})` | Fresh grouped background tab; no existing-tab adoption; capacity and navigation restrictions enforced |
| `request_handoff({target_id,description,wait_timeout_seconds})` | Global notification CTA; human-only completion blocks its tab, not the entire workspace; report notification delivery failure explicitly |
| Existing page tools | Explicit target handle, document/ref validation and bounded output; no ordinary approval wait |

Keep page-operation `target_id`; do not expose raw browser IDs as addressing
authority or add a current-tab default. No agent tools for grouping existing
tabs, activating tabs/windows, changing the client or overriding Pause.

Lifecycle:

- Workspace: active/paused/inactive, independently of browser connection.
- Execution per tab: idle/running/waiting_for_human.
- Page: ready/loading/navigation_only/unavailable with effective capabilities
  and safe restriction diagnostics.
- Returning to a tab does not change another tab's command target.
- Removed/re-added tabs get fresh handles; workspace restarts get fresh epochs.
- Wait cancellation creates no permission. No mutation backlog on Resume.
- Optional bounded lifecycle notifications/resources can follow later; correct
  tools must not depend on client notification support.

Errors: WORKSPACE_PAUSED, WORKSPACE_INACTIVE, TAB_NOT_IN_WORKSPACE,
DOCUMENT_NOT_CONTROLLABLE, TAB_LIMIT_REACHED, plus existing TARGET_STALE,
ELEMENT_STALE and OUTCOME_UNKNOWN. Bounded caller-scoped tombstones may explain
removed owned handles; unknown/foreign IDs remain generic NOT_AUTHORIZED.
Do not turn a browser-refused document into permission to navigate to protected
sites, inspect privileged pages or export raw response data.

Remove `wait_timeout_seconds` from ordinary page-call schemas in v5. Keep
readiness `timeout_ms`, bounded execution budgets, SSE heartbeat for genuine
human waits, and explicit cancellation. Routine work still runs through a
ready/execute handshake for bounded scheduling, but not positive user approval.

No silent alias of v4 `request_browser_access` to a different result shape.
Prefer a clean v5 catalogue, updated skill and provider rediscovery. If a legacy
alias is required, explicitly document/version its changed contract and never
accept old v4 consent proofs as v5 authority.

Description policy: minimum40 after trimming, maximum500, both counted as
Unicode code points, not bytes or UTF-16 units. Preserve raw leading/trailing
spaces in total-length counting unless explicitly trimmed before transmission;
the minimum ignores them. Test ASCII, BMP, supplementary characters and schema/
provider/runtime consistency. Do not pad explanations or expose them in logs.

Preserve text caps: 16KiB default, 64KiB hard maximum of UTF-8 serialized MCP
text-content wrapper; 4KiB inspector; explicit truncation and no partial success
for arbitrary script values/mutation receipts.

## 6. New Tab and browser-owned viewers

Do not implement a New Tab URL allowlist, site allowlist or user-maintained
permission list. The actual grouped tab and active workspace establish scope,
not recognition of its current URL as a named browser start page.

Separate navigation from inspection: an authorized grouped tab with no usable
page document can receive `navigate` to an ordinary HTTP(S) destination under
the existing destination/protected-origin rules, without inspecting or
injecting into its current browser-owned document. This covers a fresh blank/
New Tab and retained non-injectable viewers through the same capability path.
It does not grant privileged DOM access or navigation to browser settings,
extension URLs, files or protected management sites. Do not add a new list to
approximate those browser capabilities.

Separate DOM accessibility from tab/workspace authority. Where the URL is an
allowed ordinary site but injection is refused, report/document the refusal and
disable DOM tools. Navigation away can remain allowed under the group/session
policy without silently renewing the grant. Protected origins and uncertain
workspace/permission state retain their hard-deny behavior.

Read permission state without broadening it. Do not infer viewer type solely
from filename, MIME guess or exception wording. `permission_denied` is a
classification, not proof of missing host permission or JSON incompatibility.
Retain actual browser_info and safe injection_stage/reason diagnostics.

After POST, one attempt only. Preserve the actual response tab for human viewing.
No interception, form cloning, replay, privileged injection or profile-security
changes. Do not claim this redesign fixes the user's httpbin response refusal
without a matched live retest. Test real HTML/JSON, image and PDF documents in
disposable browsers; retain honest limits where native renderers refuse access.

## 7. Self-hosted administration and isolation

Default deployment: one operator; no mandatory OIDC or browser-user account.

- Extend the local admin CLI: client create/list/rename/rotate/revoke, device
  list/rename/revoke, workspace status, migration preview/execute/verify.
- Keep the user-facing model client/workspace based. Preserve current
  namespace/tenant IDs and endpoints internally for compatibility.
- Authenticate every MCP request with its client credential. A client cannot
  enumerate/adopt another client's bindings or administer the service.
- Existing application credential setup stays separate from browser adoption.
  A domain and short code do not provision or expose durable MCP credentials.
- Keep DomAgent independent of BananaClaw/OneCLI. The BananaClaw skill uses its
  existing vault workflow and never asks for raw credentials in chat.

Retain a small operator dashboard only when configured with a strong static
operator secret via restricted file or protected gitignored environment file.
No configured secret means remote administration is disabled, not anonymous.
Use a local credential-entry form over TLS (never URL query), constant-time
verification, login rate limits, bounded HttpOnly Secure SameSite sessions and
CSRF-protected mutations. Changing the secret invalidates administrative
sessions. No new account/password-recovery/role system.

Do not share that operator credential with agents or device WSS. SQLite stores
client hashes, device bindings, revocations and pairing state, not environment
lists. Display useful device IDs/status in the dashboard so old offline entries
can be deliberately revoked. Revocation exists today; do not claim each
in-place update necessarily creates a new device or silently delete old entries.

Remove OIDC requirements/endpoints from the default runtime and deployment
examples. Do not build two parallel auth systems solely for speculative hosted
use. A documented separate hosted mode can be revisited if real demand appears.
Retain configured protected origins, including former control-plane sites,
until the operator explicitly reviews changes; removing OIDC must not silently
broaden browser navigation/network access.

## 8. Data, signatures and migration

Central DB migration must decouple device authorization from OIDC owners and
tenant membership. Model explicit client-device bindings, pending adoption
requests/proposals, and administrative revocation. Owners/memberships may remain
as read-only legacy migration evidence, not runtime authorization in local mode.
Do not fabricate an OIDC owner or repurpose a shared admin credential.

Preserve current client/namespace/device IDs, public keys, credential hashes,
revoked flags and approved associations. Preserve namespace ownership boundaries.
Preflight flags unusual multi-owner data for explicit policy mapping rather than
flattening it silently. No reset of extension IndexedDB.

Existing tenant-keyed extension records must remain reusable. Add unbound
pending-service records for reverse pairing, then bind to a client namespace
only after confirmed adoption. Never weaken existing key validation to merge
different origins/clients, duplicate keys arbitrarily or expose private keys.

Workspace state is ephemeral: no active grant, Allow-all flag, pending command
or visibility lease survives migration/restart. Native groups/tabs can persist
as organization only. Never adopt stale numeric tab/group IDs automatically.

Wire v5 transcripts use new domain separators, preserve identity proof, and
bind namespace/client/device connection, workspace activation, group/window,
tab handle, capabilities, nonces and sequence/revision. Atomic removal/change
invalidates authority before asynchronous cleanup. Reject v4 messages with an
explicit upgrade-required response, not a fallback to old approval semantics.

Implement an explicit schema migration command with preview, transactional
apply, validation and known source schema checks. Upgrade code refuses old or
newer unsupported schema rather than calling a schema initializer that overwrites
user_version. Keep a matching backup/code rollback procedure.

Current v4 single-tab windows remain open after upgrade. User may elect to group
their tabs with the new toolbar/menu; do not move them automatically or retain
their old grants. New End semantics (leave tabs open) must be prominent.

## 9. Implementation order and concrete surfaces

| Stage | Work and prerequisites | Primary surfaces |
| --- | --- | --- |
| A | Qualify native groups, sidebar-open evidence, context menus, background throttling, New Tab/viewers. Stop if the visibility gate cannot be met. | extension adapter/manifests; real-browser harness |
| B | Specify v5 shapes, state transitions, limits and signing. Define DB migration and legacy mappings. Depends on A. | shared/protocol.js; docs; store/migrate tests |
| C | Implement local/static administration and explicit client-device bindings. Depends on B. | config.js, store.js, admin.js, app.js, deployment |
| D | Implement reverse pairing, proofs, code lifecycle and authenticated adopt tool. Depends on C. | controller/keys/UI; store/app/MCP; protocol tests |
| E | Implement native group workspace registry, visibility lease and synchronous revoke. Depends on B/C; preserve existing bindings without D if testing migration. | adapter/controller/background; server.js |
| F | Wire v5 discovery, page dispatch, handoff and bounded background-tab creation. Depends on E. | mcp.js/server.js; adapter/controller; shared schemas |
| G | Simplify sidebar/setup, global human-assistance notifications, menus and optional user window move. Depends on D/E/F. | ui; manifests; background; activity |
| H | End-to-end hostile-race/regression tests, migration rehearsal, documentation/skill/acceptance-plan update. Depends on C-G. | tests; docs; BananaClaw skill; agent workspace plan |
| I | Scoped commits, exact assets, coordinated publish/deploy and live acceptance. Depends on H and manual platform gates. | release assets; service; operator extension update |

Reuse the existing adapter, per-tab scheduling, signing, result-bounding,
activity-history and vault integration. Introduce a workspace-state helper only
where necessary; do not add a second router/scheduler or duplicate protocol logic.
No unrelated BananaClaw core edits, frontend experiments or local install files
in the release commits.

## 10. Verification and release acceptance

Mandatory tests:

1. Pairing code generation/normalization, collisions, expiry, rate limits,
   competing adoption, double confirmation, receipt isolation, replay, revoked
   client and interrupted commit; no OIDC/browser account or fake owner.
2. Separate client/workspace isolation and admin-vs-MCP credential separation.
   Disabled admin routes, session/CSRF protections and secret rotation.
3. Genuine group add/remove/re-add, renaming, fake same-name groups, inherited
   popup exclusion, group/window move, restored IDs, stale epochs and revocation.
4. Native panel close/switch/crash/restart/background states; forced stale-lease
   loss verified within the chosen maximum. Settings pages cannot renew authority.
5. Multiple grouped background tabs while an unrelated foreground tab remains
   unchanged and unenumerated; one executor per tab and cross-tab limits.
6. Pause/end cancels queued work; executing outcomes stay uncertain where
   necessary; resume cannot replay work. Human Done blocks only its task tab.
   Global notification click routes to the bound task without auto-completion;
   denied/suppressed notifications are distinguished from delivered API requests.
   Test deduplication, pending counts, expiry and stale notification clicks.
7. Tab creation races/limits/cleanup, no focus stealing, protected URL blocks,
   blank/viewer navigation-only start without a current-page allowlist,
   no browser-settings injection and no broadened destination permission.
8. Viewers and real POST responses; missing optional hosts vs renderer refusal;
   stable effective capabilities, same-handle navigation recovery where safe;
   never replay/privileged bypass.
9. Preserve current snapshot/action/label/readiness/CSP/protected-origin tests,
   output byte caps, history redaction, UTF-8 Unicode boundary thresholds and
   complete specific error/result shapes.
10. Migration of actual-like schema2 fixtures preserves existing IDs/hashes/
    keys/revocations and client isolation; crash-safe restore and matched rollback.

Use actual optional-host grant paths in at least one browser qualification, not
only manifest pre-grants. Keep the native Firefox tests, disclose the known
Juggler harness limitation and qualify newer browser versions where necessary.
Request a focused independent security review of the new consent/adoption/admin
boundaries before release; report uncertainty instead of using a source-only
review as proof of physical UX.

Physical user acceptance:

- Domain-only install and code adoption without DomAgent login.
- One confirmation/start; no per-action prompts.
- Group drag/menu consent; background work while browsing an unrelated site.
- Pause all and panel closure leave all tabs intact and stop new commands.
- Global human-assistance CTA is discoverable while the user is outside the
  task window/sidebar; clicking it goes to the correct task, never confirms Done.
- New Tab navigation and clear unavailable-viewer explanation.
- No accidental popup authority or silent restored-session activation.

Update README, security/collaboration/build docs, release/migration instructions,
deployment environment examples, MCP instructions and the BananaClaw skill.
Create a new v5 agent-plan revision; preserve old reports. Correct current plan
claims that permission_denied is necessarily permanent, every update re-pairs,
or two paths are two origins. D12 remains an open acceptance failure, not a
mandated expected failure signature. Fix Unicode maximum in regression coverage.

### Deployment checklist

1. Run targeted tests, full service/extension suites, both builds and syntax
   checks; exercise actual platform gates and migration/rollback rehearsal.
2. Preview changed files and namespace migration mapping; preserve unrelated
   dirty work and don't commit agent runtime notes or installation secrets.
3. Stop at a maintenance boundary, back up private SQLite using its backup API,
   and record hashes/counts of durable identities/bindings. End live grants.
4. Commit scoped tested revisions with standard trailers, push and publish
   Chrome/Firefox compiled ZIPs, tracked-source ZIP and SHA256SUMS. Redownload and
   verify assets; checksums are not SLSA provenance.
5. Apply the explicit migration, deploy exact v5 service code, verify public
   metadata and authenticated client-scoped MCP without waking the model or
   mutating the user's browser. Ensure old wire versions fail explicitly.
6. Ask operator to update extension in place to 5.0.0, preserve device storage,
   verify identity reuse and explicitly Start/Resume a disposable group.
7. Update the agent acceptance plan's rollout state to the actual commit and
   deployed/installed versions. Focus on onboarding/group/background/closure
   gates; do not repeatedly spend prompts on unchanged baseline tools.
8. Review delivered evidence and iterate on confirmed failures with surgical
   changes/new versions. No unattended report watcher is implied.

Rollback restores matched pre-migration DB, code and extension protocol. Reconcile
any credential/revocation changes made since the backup; never casually restore
stale authority. Keep backups private and never reset user identities to make
the upgrade appear successful.

## 11. Platform references and remaining decisions

- [Chrome sidePanel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel):
  window-scoped panels and native lifecycle; open needs a user gesture.
- [Firefox sidebarAction.isOpen](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sidebarAction/isOpen):
  browser-native open state must be combined with our panel instance.
- [Chrome tabGroups](https://developer.chrome.com/docs/extensions/reference/api/tabGroups).
- [MDN tabGroups](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabGroups):
  full Firefox group APIs from 139.
- [Chrome contextMenus](https://developer.chrome.com/docs/extensions/reference/api/contextMenus)
  and [MDN compatibility data](https://github.com/mdn/browser-compat-data/blob/main/webextensions/api/menus.json):
  native tab context Firefox53 / Chrome150.

Implementation-stage decisions must be evidence-led:

- Exact browser minimum that supports reliable native closure detection.
- Whether background timers satisfy the visibility-lease maximum without
  falsely promising continuous observation.
- Which viewer failures permit safe navigation-only recovery and which must
  remain hard-denied.
- Actual group auto-inheritance and whole-group window-move event order.

Everything else above has a proposed concrete default. These are release gates,
not invitations to silently substitute less restrictive behavior.
