# Extension validation (protocol v3, collaborative-tab-v1)

Actual-service Chrome and native Firefox shift server action timestamps two
minutes ahead while retaining the bounded relative budgets. Overlay/trusted UI
approvals, allow-all and human Done must still complete without a socket reset.
Controller tests also cover a server behind the browser and malformed execution
budgets. Physical Firefox pointer clicks remain an operator acceptance check. (protocol v3, collaborative-tab-v1)

With the pinned service dependencies already installed, from the repository root:

```sh
node --test domagent-extension/test/*.test.js
node scripts/build-extensions.mjs
podman run --rm --shm-size=512m -e PLAYWRIGHT_SKIP_BROWSER_GC=1 \
  -v "$PWD:/workspace" -w /workspace/domagent-mcp \
  mcr.microsoft.com/playwright:v1.58.2-noble npm run test:browser
```

The suite uses only disposable profiles and TLS fixtures inside
`domagent-extension/.browser-artifacts/`. It does not install host browser
libraries, change live services, or weaken production certificate handling.
The Chromium and Firefox engines and image must already be available.

## Automated coverage

- Real Chromium protocol fixture: signed tenant-bound enrollment and handshake,
  local sharing approval of an existing selected tab, MAIN-only script execution without
  extension APIs, page operations, screenshot PNGs, CSP behavior, protected
  requests/redirects, stop/reapproval, and IndexedDB identity after restart.
- Actual-service Chromium: real `Store` and `createApp`, anonymous setup request,
  browser fragment-token exchange and HttpOnly flow, authenticated setup form,
  once-shown operator settings, public connection link, automatic installation
  wizard, server approval form, automatic proof/connection without a local
  second confirmation, and no grant before separate local sharing approval.
  Same-origin/different-tenant credentials, devices and targets are isolated.
  Switching kills old grants and preserves independent keys.
- Native Firefox RDP: real temporary WebExtension and actual service, signed
  pairing, selected-tab sharing, protected redirects, page controls and text,
  optional-operation failures, CSP refusal, guarded human completion after
  navigation, and full process restart with persisted identity and no grants.
- Unattended Firefox: all extension pages are closed, extension-target debugger
  observation is released, and no extension UI is polled for 65 seconds. The
  same authenticated connection must remain online with no shared tab.
- Named page indicators, page-local Stop sharing, extraction exclusion,
  `clear_overlays` preserving the indicator, and independent toolbar status.
- Unit tests cover strict missing-tenant rejection, nonextractable per-pair
  keys, legacy records, connection binding, old-document queued actions, bounded
  human waits, staged ready/execute permits, cancellation/stop without retries,
  sender/tab/frame/document/nonce binding, synthetic positive clicks, and
  install-versus-update behavior.
- Actual-service collaboration: immediate request window with description,
  existing-tab selection and selecting a different normal-window tab afterward,
  per-action approvals, forged page approval/allow-all/Done rejection, human
  login/navigation without grant loss, Done/Cancel, grant-scoped allow-all,
  stale-document rejection and wait-timeout cancellation.
- Page actions run through actual HTTP MCP and the packaged Chrome
  and native Firefox extensions: document-scoped snapshots, field-value redaction,
  open-shadow-root references, ambiguous selectors, disabled/readonly/obscured
  controls, element replacement, new-snapshot invalidation, navigation expiry,
  fill/select/check/key/scroll, and explicit loaded-page results. Adapter unit
  tests mock deadlines and verify cancellation cannot execute a waiting action.
- Compact-output coverage checks default/maximum UTF-8 budgets including MCP
  wrapper escaping, multibyte/control-character text, surrogate boundaries,
  full-row truncation, oversized script rejection, focused snapshots and
  server-side enforcement against oversized older-extension responses.
  Chrome/native Firefox qualify specific script syntax/runtime errors; native
  Firefox verifies page CSP refusal is distinct from unsupported capability.
- Latest feedback regressions reproduce the sharing banner covering text input
  on a narrow page in Chrome and Firefox, then verify text/tel/email/search
  actions while preserving a site's obstruction checks. Actual extensions fill
  and submit a local form, verify the HTML POST echo under the same grant,
  inspect title/non-rendered metadata and viewport/control flags, and preserve
  detailed readiness timeout causes. Native Firefox also checks JSON POST
  navigation: a supported document remains readable, or a browser-refused
  document ends sharing without changing the response URL or repeating POST.

The extended Playwright Firefox Juggler test remains explicitly skipped by
default: the supplied 1.58.2 engine crashes on extension documents at
`FrameTree.js:543`. The native Firefox test runs by default; its assertions
are not skipped. For diagnostics only:

```sh
# Inside the same container, /workspace/domagent-mcp:
DOMAGENT_FIREFOX_JUGGLER=1 npm run test:browser -- --grep 'real firefox'
```

The native run uses Firefox's own RDP, not Juggler. Its console cannot synthesize
a physical permission gesture, so trusted options-page runtime messages drive
configuration, sharing and decisions with fixture hosts pre-granted. Synthetic
page clicks must still fail the actual production `event.isTrusted` guard.
Server approval uses
the real Store; Chrome exercises both server browser forms. Both sides still
perform actual signed enrollment and WSS authentication.

Firefox 146.0.1 in this image does not expose `tabs.captureTab`; screenshots are
not advertised and explicitly return `CAPABILITY_UNAVAILABLE`, never substitute
the visible tab. Page CSP can deny evaluation without disabling text/navigation.
Candidate minimum browser versions still require separate release qualification.

## Physical acceptance limits

Headless fixture manifests pre-grant HTTP(S) hosts. The Chrome setup test records
the real UI permission calls: onboarding requests only the connection server;
broad website permission is requested later by **Share this tab with …**. This does **not**
qualify the browser's visible permission/notification prompt UX.

With the released browser build, manually verify in supported Chrome and Firefox:

1. Installation opens the one-link wizard; updating an existing identity does
   not open it. Decline then accept the server-only permission prompt.
2. The public link starts focused sign-in/approval and automatically connects.
   No tabs are shared and no general website permission is requested yet.
3. A request opens an extension window independently of the selected tab. Visit
   an existing or new normal-window website tab and choose **Share this tab with …**
   from the toolbar. Decline then accept website permission. There are no
   capability checkboxes; only the explicitly selected tab gets fixed page APIs.
4. Confirm the named page border/banner and toolbar, keyboard-accessible
   **Stop sharing**, navigation reinstallation, and removal after stop. A website
   may hide or imitate DOM decoration; the toolbar remains independent.
5. Switch connections with active sharing, disconnect, suspend/restart, and
   verify fresh local approval is required. No old target works.
   Approve/Decline/Allow-all apply per tab; human Done/Cancel retain sharing even
   after normal login navigation. Stop cancels waiting actions immediately and
   leaves the user-owned tab open.
6. Qualify Firefox capture availability and CSP-denied evaluation, real
   notifications, and browser-policy refusal on the operator's own browser.
7. Leave the popup and settings closed for at least two minutes with no shared
   tab. The browser must remain connected and deliver a subsequent local request.
   The persistent Firefox background avoids event-page suspension without fake
   API traffic or automatically restored control.

Shared tabs use the same website sessions, not a network sandbox or isolated
profile. Password/CAPTCHA presence does not revoke sharing or block ordinary
inspection. Protected service/IdP origins remain prohibited. Stop cannot undo
requests, account changes, or already scheduled page JavaScript. Human waiting
is bounded at 600 seconds; actual execution starts only after the server permit
and has its own 25-second deadline. Side effects are never retried.
