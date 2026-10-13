# v5 browser and security validation

```sh
npm --prefix domagent-mcp ci --ignore-scripts
npm --prefix domagent-extension ci --ignore-scripts
npm --prefix domagent-extension/ui ci --ignore-scripts
npm --prefix domagent-mcp test
npm --prefix domagent-mcp run build
npm --prefix domagent-mcp run check
podman run --rm --userns=keep-id --ipc=host \
  -v "$PWD:/work:rw" -w /work/domagent-mcp \
  mcr.microsoft.com/playwright:v1.58.2-noble npm run test:browser
```

Disposable fixtures only: Chrome145.0.7632.6 and official native Firefox153.0.
Renderer/page-helper tests still use Playwright's Firefox146.0.1 and do not
qualify native MV3/user-script APIs. Native tests require
`DOMAGENT_FIREFOX_BINARY` pointing to Firefox153+; qualification verified
the official archive against Mozilla SHA512SUMS and mounted it separately.
`DOMAGENT_LEGACY_FIREFOX_EXTENSION` can point to the published5.0.4 directory
to qualify real MV2 pairing -> MV3 same-profile reload after restart. Device key/
ID, pairing and storage must survive without re-enrollment. This is not proof
of every physical hot-update UI path.
Native platform gates exercise real Chrome onOpened/onClosed and panel-port
disconnect, Firefox isOpen after browser show/hide, and native group creation.
Auto-opened Firefox install sidebar is not consent.
An explicit Run stays active after dashboard closure (native Firefox tested35s
without incoming tool/UI calls). Toolbar Pause all revokes; cold restart restores
no Run. MAIN/USER_SCRIPT native source and original CSP stacks are tested through
the actual paired MCP service. Chrome USER_SCRIPT uses the browser's real
userScriptsAccess setting in a disposable profile, not a broadened target grant.

Actual service integrations prove domain-only reverse pairing and signed device
authentication, explicit Start, grouped background operations with an unrelated
foreground tab, create tab, caller-scoped handles, Pause/End/native closure leaving
tabs intact, and persisted Firefox keys without restored runtime authority.
Refused inspection can downgrade the same handle to navigation-only with safe
diagnostics; navigating away does not require a new per-action prompt.

Retained page fixtures cover strict selectors/refs, actionability waits, redacted
snapshots, control/associated-label replacements and site-obstruction checks,
HTML POST response, compact-output Unicode/escaping bounds, inspector hiding/
reveal metadata and no native-keystroke/CSP workaround.

Unit/service tests cover adoption receipts/proposals/replay/revocation, local/static
operator auth and CSRF, explicit schema migration preserving durable identities/
disabled state, client isolation, signed workspace revisions/lease expiry,
cross-tab capacity and per-tab scheduling/cancellation, no privilege rebind,
protected-navigation guard retention, and late cancelled creation cleanup across
fresh activations. A focused independent security follow-up confirmed both
identified teardown races were addressed with regressions.

Chrome headless without pre-granted hosts leaves the native permission prompt
pending and confirms no pairing/workspace authority; direct background configuration
without the actual grant fails PERMISSION_REQUIRED. Renderer fixtures separately
exercise a declined request returning false. Physical dialog decline is not claimed:

```sh
# same disposable container, optional-host failure path
DOMAGENT_OPTIONAL_PERMISSIONS=1 npm run test:browser -- --grep 'v5 Chrome actual'
```

Positive Firefox optional-host grants are supplied through the browser's native
permission store in the disposable RDP fixture, not broadened manifests. This
qualifies permission-state behavior, not a physical permission-dialog gesture.
Physical optional-host dialogs, notifications outside the browser/DND, menu
appearance, narrow sidebar layout and all minimum browser builds remain operator
acceptance tasks. Native notifications successful creation is not proof a user
saw them. No test installs libraries into the user's browser or mutates accounts.

The old v4 extended Juggler consent test was retired with that protocol, not
silently used as proof of v5 parity. Firefox coverage is its actual native RDP
engine; page-helper-only tests run both engines. No published browser-profile
specific POST bug is considered fixed merely by these disposable results.

New fixtures qualify delayed/empty visible content markers, exact timeout stages,
browser editing events, managed contenteditable state and asynchronous rollback,
popup-only stopping and Copy without Send/Done. Native source parsing/capture tests
cover expression/statements/Promises, strict directives, syntax/no-dispatch,
runtime/async stacks and no page eval. Native source capture occurs before Firefox
clones Error, rather than claiming an extension dispatcher stack is the page stack.

Permission-category regression tests invoke Firefox153's actual parent permission
API with already-granted permissions: combined userScripts/host origins fails,
standalone userScripts succeeds. They do not fabricate a user gesture or claim
physical dialog approval. Renderer fixtures exercise first-click scripting,
second-click website access, declines and no premature activation/confirmation.

Restart patch tests stop/recreate the actual Chrome fixture service while the
native panel/group remains open, verify epoch/connection changes and inactive
empty signed reprojection without replay, then require explicit local Resume and
fresh handles. Unit tests cover caller-scoped terminal metadata, ten-minute
retention, signed optional reasons, lease expiry and legacy snapshot compatibility.
Resolved red authorization errors clear while history/persistence warnings remain.
Explicit existing-group selection reuses tabs; duplicate titles alone do not
authorize them or silently create another group.

Missing-group tests preserve revoke-before-cleanup, retirement and explicit
alternate-group selection even when a native lookup races group deletion.
Empty-sidebar renderer fixtures in both Chrome and Firefox assert single-action
recovery and exact selected native IDs at320px width in light/dark themes with
no tab rows and a stale warning. They check fresh-ack Starting, current vs
historical status, permission-denial safety, combined reconnect/Continue,
keyboard task selection, menu/Escape/back focus restoration, focus retention
across live updates, overflow bounds and locally bundled fonts.
They mock browser APIs for rendering only, not production authorization.
Actual Chrome tests exercise native ungroup/removal, End preserving groups/tabs,
existing group reactivation and fresh task creation. Failed activation/End tests
surface unrelated API errors without retaining active authority or closing tabs.

The independent UI package also has pure derived-state/decoding/selection tests,
included in the main `npm test`. `npm --prefix domagent-extension/ui run
typecheck` checks strict TypeScript without a service build. No frontend dependency,
import or runtime connection to BananaClaw is needed.
