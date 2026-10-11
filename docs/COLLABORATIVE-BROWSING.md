# Collaborative tab-sharing protocol

Service 4.1.0-beta.3 and extensions 4.1.2 use wire version 3 and policy
`collaborative-tab-v1`. This replaces dedicated automation tabs, per-capability
selection, immediate-return sharing requests, and revoking login-page handoff.
Tenant identity and OIDC setup remain independent of calling applications.

## Sharing

`request_browser_access({device_id, description, wait_timeout_seconds?})` waits
for a signed extension response describing the actual user-selected tab.
The server coalesces concurrent requests for the same client/device, with bounded
waiters and expiry. Cancelling the last waiter removes its request/prompt.
No active tab is automatically shared when a request arrives.

The local share action selects a normal user tab at the time of consent, installs
required origin protection, and signs the tab ID, fresh target ID, client/tenant,
policy, request nonce, connection ID/epoch and advertised browser operations.
Unsupported browser operations remain unavailable; this is a fixed ordinary-page
boundary, not arbitrary privileged browser APIs.

The MCP result contains `target_id`, its alias `tab_handle`, the selected `tab_id`,
and supported capabilities. Every operation still uses an explicit `target_id`.
`list_browser_targets` lists eligible devices and their `shared_tabs`, not unrelated
tabs; compatibility fields `target_id/capabilities` describe the first shared tab.
Sharing another tab is an explicit action and yields a distinct handle.

Device results also separate `connection_state` (`connected`/`offline`),
`sharing_state` (`active`/`none`), and `pending_request_id` (null without an
outstanding sharing request). The legacy `state` remains available for existing
clients: `approval_required` means connected but not sharing, not that a prompt
is currently displayed. Sharing and connection are independent; a connected
idle device needs a new explicit request before asking the user to approve.
Grant capabilities enumerate page operations, not management/handoff tools.
An advertised operation is browser-supported but may fail page policy checks.
No additional unshared tab information is exposed by these fields.

## Actions

Every page call includes a nonempty, bounded `description`. Treat it as unverified
requester text; pair it with operation-derived details. Render as text, never HTML.
One approved click/script may itself cause arbitrary ordinary-page side effects.
Descriptions are not a security proof and logs must not retain them or arguments.

The server dispatches a pending `command` with the human deadline. The extension
queues it independently of heartbeat traffic and displays:

- Approve: one exact operation.
- Decline: `ACTION_DECLINED`, no execution.
- Allow all while sharing: supported ordinary-page operations for this tab/client
  for this sharing session; never human-confirmation requests or other tabs.
- Stop sharing: invalidate local authority immediately and cancel pending work.

Positive decisions must come from trusted extension UI or real trusted user
interaction with packaged isolated overlay controls. An agent's injected script
cannot synthesize approval, allow-all, or Done. Validate target, sender/frame,
document and request nonce; do not add a general page-to-extension control bridge.
Toolbar/popup provide an independent fallback when the page overlay fails.

## Human wait and execution budgets

Human waits default to 300 seconds, max 600. Once action approval arrives:

```text
server -> command (human expires_at)
extension -> command.ready (same request/target)
server -> command.execute (fresh 25-second expires_at)
extension -> result (same request/target)
```

The server rejects successful results before it issued execution. Late ready/results
are discarded when cancelled/expired. A duplicate ready cannot execute twice.
Queues stay bounded; they are not an unlimited approval backlog.

Server `expires_at` is authoritative on the server. Sharing/command messages also
carry bounded `wait_timeout_ms`, and execution authorization carries
`execution_timeout_ms`. The extension measures those budgets on receipt using its
own clock; laptop and server wall clocks need not agree. Delayed messages cannot
extend server authority or make expired results acceptable. Invalid execution
budgets fail the individual action, not every shared tab's socket.

HTTP disconnect/MCP cancellation removes waiting work. `command.cancel` tells the
extension which request ended. Before execution it is a cancelled/expired request;
after execution begins an uncertain outcome is reported and sharing ends rather
than allowing an automatic retry. Credential revocation/rotation and disconnect
invalidate pending authority as well as active grants. Other tenants are unaffected.

Client/proxy timeout must exceed the human wait plus execution and scheduling
margin. For a 600-second client limit, request at most 540 seconds; default 300
seconds leaves headroom. The nginx example uses a 650-second read timeout.
An intermediary with a shorter hard limit must be configured or the explicit wait
reduced. Do not claim the long wait is verified through an untested gateway.

Tool-call responses use Streamable HTTP SSE, with content-free heartbeat comments
every 15 seconds while waiting. Discovery/initialization can still use JSON.
This prevents an otherwise silent human wait from hitting common proxy idle-read
timeouts; it does not override a proxy's hard total-duration limit or the client's
own operation timeout. Use an MCP-aware client, not JSON-only response parsing.

## Cooperative user interaction

`request_handoff({target_id, description, wait_timeout_seconds?})` uses the same
pending-command path but always requires **Done** (or Cancel), even under allow-all.
It pauses that tab's agent command queue while the human acts, not ownership of
the browser. Done returns `{state:"completed",user_confirmed:true}` without a
page action or fresh tab-sharing ceremony.

The user may log in, solve a challenge, click, type, or navigate. Human assistance
completion must tolerate navigation deliberately performed by that user. Normal
page requests approved/queued for the old document must still fail stale checks;
they cannot silently run on the new document. Existing sharing survives ordinary
navigation, but protected or browser-refused pages are not an inspection bypass.

No password/CAPTCHA heuristic automatically ends an otherwise accessible shared
session. The agent should ask the user to enter credentials; unrestricted ordinary
page scripts can still see DOM-visible secrets. This is disclosed behavior, not
universal secret filtering.

## Structured snapshots and reliable page actions

Install extensions 4.1.2 from the 4.1.0-beta.3 release to use these additions.
Existing device identities and credentials need no reset; share tabs again
after updating. Older releases remain available for coordinated rollback.

`get_page_snapshot({target_id, description})` returns a compact DOM-derived
snapshot: `document`, `url`, `title`, visible `text`, and element references.
Elements have an opaque `ref`, `role`, accessible-name approximation, tag,
disabled/readonly/editable state, viewport membership and checked state where
applicable. Excessive DOM size returns `RESULT_TOO_LARGE`. Field values, including contenteditable values, are
redacted from snapshots. This is not a native accessibility tree or a general
secret-filtering guarantee for page text/scripts.

### Compact output budgets (4.1.0-beta.2)

Service 4.1.0-beta.2 and extensions 4.1.1 default to 4000 text characters and 50 elements rather than
whole-page dumps. Textual MCP results have a default 16 KiB budget and a hard
64 KiB maximum, measured as UTF-8 bytes of the serialized MCP result including
its text-content wrapper and JSON escaping. JSON-RPC/SSE framing adds a small
amount of transport overhead. Neither many calls in aggregate nor explicit
image results are covered by the textual budget.

Read tools accept `max_output_bytes` (1024..65536). `get_text` and
`get_page_snapshot` accept `max_text_chars` (0..16000); snapshot and legacy
element enumeration accept `max_elements` (1..100). The byte budget may reduce
these requested counts further, particularly for multibyte/escaped text.
Truncation is explicit in `truncated`, `text_truncated`, and
`elements_truncated`. Text is clipped at a valid string boundary; rows are
returned whole. Do not interpret a partial result as a full page or tree.

Focus `get_page_snapshot` with a unique `selector` to inspect a relevant
section instead of repeatedly requesting the entire page. Its refs still
belong to that document, and every new snapshot invalidates the previous refs.
`get_text` should normally target a specific selector/ref. Prefer these tools
over scripts that return full DOM/HTML, whole-page text, or large arrays.
Arbitrary script values, mutation receipts, and device lists cannot be safely
truncated: oversized results return `RESULT_TOO_LARGE`, never partial JSON.
The extension bounds reads before reporting them; the MCP server enforces
the same budgets even when an older extension returns a larger result.
New sizing/scoping arguments and specific script errors require the new
extension; older extensions retain their existing argument/capability rules.
Screenshots remain separate explicitly requested image content under their
existing size bounds, not a text-output-budget exception for other operations.

`evaluate_script` takes JavaScript source/expression, not a function body.
`document.title` and `(() => document.title)()` are valid; a top-level
`return document.title;` is invalid. Return only small, focused JSON data.
New extensions distinguish `SCRIPT_SYNTAX_ERROR`, `SCRIPT_RUNTIME_ERROR`,
`SCRIPT_SERIALIZATION_ERROR`, `SCRIPT_POLICY_BLOCKED`, and
`SCRIPT_EXECUTION_UNAVAILABLE`. Error codes do not include page/source/exception
contents. A recognizable Firefox eval-policy refusal is `SCRIPT_POLICY_BLOCKED`;
generic browser injection failure is not presumed to be CSP. Browser support
does not guarantee every page permits eval. Use snapshots/text instead of
retrying or bypassing a policy refusal. Chrome runtime evaluation keeps its
existing narrow page-context boundary.

The scope is the top-level document and open shadow roots only. Closed shadow
roots and iframe documents are not exposed. References belong to the exact DOM
element in that document. Navigation returns `TARGET_STALE`; a removed element
or reference from an earlier snapshot returns `ELEMENT_STALE`. A new snapshot
invalidates the previous reference set and never reuses its reference numbers.

Targeted actions accept either `selector`, or both `ref` and `document`:

```json
{
  "target_id": "<shared tab handle>",
  "ref": "e3",
  "document": "<document from snapshot>",
  "description": "Fill the account nickname",
  "text": "My nickname",
  "timeout_ms": 3000
}
```

CSS selectors search the top-level document and open shadow roots. Multiple
matches fail with `ELEMENT_AMBIGUOUS`, never selecting the first arbitrarily.
`get_text` can omit a target to read page text. Input actions require a target.
`click`, `type_text`, `select_option`, `set_checked`, `press_key`, `get_text` and
`scroll` default to a 3-second actionability wait, bounded by `timeout_ms`
(0..10,000). Zero returns immediate readiness errors. A positive exhausted
wait returns `WAIT_TIMEOUT`. Waiting for absent, disabled, readonly, invisible
or obstructed controls never repeats an executed mutation. Invalid selectors,
ambiguous/stale targets and unsupported operations fail immediately.

Actions inspect and scroll the target into view, check the hit-test point and
reject covered controls. No browser-wide input or raw CDP surface is added:

- `type_text`: replace the field value and dispatch input/change events.
- `select_option({value})`: select a unique enabled option in a single-select.
- `set_checked({checked})`: set a native checkbox, or select a native radio.
  Clearing a radio and multi-select operations require human assistance.
- `press_key({key})`: dispatch synthetic DOM keydown/keyup for the documented
  key enum. Browser defaults (form submission, Tab traversal, editing) and
  browser shortcuts are not synthesized. Results explicitly report
  `native_input:false` and `default_action_performed:false`. Prefer the semantic
  click/fill/select/check actions when modifying native controls.
- `scroll({delta_y, delta_x?})`: scroll the document or targeted element by a
  bounded pixel delta.

`navigate` retains its existing `navigation_started:true` acknowledgement.
Call `wait_for_page({timeout_ms?})` to observe `state:"loaded"` with the current
URL and document. It follows ordinary navigation under the same tab grant;
protected destinations and cancellation still stop access. Its default wait
is 10 seconds. Neither navigation completion nor a successful click implies
that a website completed the business transaction.

These operations use the same human approval and separate execution budget as
existing tools. The shared operation definitions drive MCP schemas and both
relay/extension argument validation. Old extensions advertise only their
supported operations; new tools require installing the updated extension.
Wire version 3 and tenant/device identities remain unchanged.

### Latest retest and mutation fixes (4.1.0-beta.3)

Service 4.1.0-beta.3 and extensions 4.1.2 are available in the release ZIPs.
This build validates target-handle shape before authorization. UUID handles
and legacy 43-character tokens remain opaque and accepted; a malformed value such
as `not-a-uuid` returns `INVALID_ARGUMENTS`. Valid-shaped unknown/ended/foreign
handles return `NOT_AUTHORIZED` without revealing which other client owns one.

Positive element readiness waits still return `WAIT_TIMEOUT` when exhausted.
They now include a fixed `last_error` and bounded `timeout_ms`, for example
`{"error":"WAIT_TIMEOUT","last_error":"ELEMENT_NOT_FOUND","timeout_ms":3000}`.
Use zero for an immediate selector probe. The default element wait is 3 seconds,
not the separate human approval deadline. No exception text or page contents
are included in these diagnostics, and no executed mutation is retried.

Legacy geometry lists explicitly identify `coordinate_system:"viewport"` and
include control state and `in_viewport`. Off-screen, narrow controls are not
necessarily CSS-hidden; truly hidden inputs remain excluded. The action still
scrolls and checks the actual target before mutating it.

HTML `head > title` extraction returns bounded document-title metadata. Other
non-rendered text targets explicitly return `rendered:false` with
`empty_reason:"NOT_RENDERED"`; scripts/styles are not exposed by falling back to
raw text content. Normal text uses `text_source:"rendered"`.

A sharing banner can cover text inputs on a narrow page. The packaged helper
now temporarily excludes only its own isolated-world-tracked decoration from
the hit test, restoring it synchronously before the approved DOM action.
The banner stays available and site overlays still cause `ELEMENT_OBSCURED`.
Approved DOM clicks explicitly focus focusable controls before dispatching the
click, but never retarget a replaced or newly disabled control.
No native/trusted automation input or new approval surface is introduced.

Disposable Chrome/native Firefox tests fill text/tel/email/search controls,
assert values and radio/checkbox state, submit to a local POST echo, and inspect
the loaded HTML response under the same grant. Supported HTML form navigation
is not inherently a grant-ending event. Browser-refused response documents
(including some JSON-viewer cases) must still fail closed. The retained tab
must remain at the response URL, never silently revert or repeat the POST.
`PAGE_UNAVAILABLE` is not an invitation to bypass document inspection.

## Lifecycle and tests

Stop, tab closure, revocation, browser/service restart, or disconnect ends sharing
and allow-all state. Reconnect restores identity only. Existing user tabs remain
open and are never adopted from stale stored tab IDs.

Test real user-tab choice while a different tab/window is active; individual action
approval; denial; allow-all; human login/Done after navigation; long waits beyond
the old 25-second deadline; cancellation; cross-tenant/tab proofs; duplicate ready;
stale queued work; and accurate overlay/toolbar stop state. Keep native Firefox
persistent idle/restart and Chrome onboarding tests.
