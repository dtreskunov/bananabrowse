# Extension validation (protocol v2)

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
  local sharing approval, dedicated tabs, MAIN-only script execution without
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
  pairing, separate local approval, protected fetch/image/frame/redirects,
  selector errors, submit/form POST/JSON-viewer regressions, browser-restricted
  document refusal, optional-operation failures, fresh approval, and full
  process restart with persisted identity and empty tab provenance.
- Unattended Firefox: all extension pages are closed, extension-target debugger
  observation is released, and no extension UI is polled for 65 seconds. The
  same authenticated connection must remain online with no shared tab.
- Named page indicators, page-local Stop sharing, extraction exclusion,
  `clear_overlays` preserving the indicator, and independent toolbar status.
- Unit tests cover strict missing-tenant rejection, nonextractable per-pair
  keys, legacy records, queued/running work on switch, stale documents, stop-only
  sender/tab/frame/document binding, install-versus-update behavior, and cosmetic
  failure that warns without blocking command authority or teardown.

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
configuration and sharing with fixture hosts pre-granted. Server approval uses
the real Store; Chrome exercises both server browser forms. Both sides still
perform actual signed enrollment and WSS authentication.

Firefox 146.0.1 in this image does not expose `tabs.captureTab`; screenshots are
not advertised and explicitly return `CAPABILITY_UNAVAILABLE`, never substitute
the visible tab. Page CSP can deny evaluation without disabling text/navigation.
Candidate minimum browser versions still require separate release qualification.

## Physical acceptance limits

Headless fixture manifests pre-grant HTTP(S) hosts. The Chrome setup test records
the real UI permission calls: onboarding requests only the connection server;
broad website permission is requested later by **Share a tab**. This does **not**
qualify the browser's visible permission/notification prompt UX.

With the released browser build, manually verify in supported Chrome and Firefox:

1. Installation opens the one-link wizard; updating an existing identity does
   not open it. Decline then accept the server-only permission prompt.
2. The public link starts focused sign-in/approval and automatically connects.
   No tabs are shared and no general website permission is requested yet.
3. Decline website permission at **Share a tab**: no target activates. Retry,
   select intended abilities, and explicitly opt into page scripts if needed.
4. Confirm the named page border/banner and toolbar, keyboard-accessible
   **Stop sharing**, navigation reinstallation, and removal after stop. A website
   may hide or imitate DOM decoration; the toolbar remains independent.
5. Switch connections with active sharing, disconnect, suspend/restart, and
   verify fresh local approval is required. No old target works.
6. Qualify Firefox capture availability and CSP-denied evaluation, real
   notifications, and browser-policy refusal on the operator's own browser.
7. Leave the popup and settings closed for at least two minutes with no shared
   tab. The browser must remain connected and deliver a subsequent local request.
   The persistent Firefox background avoids event-page suspension without fake
   API traffic or automatically restored control.

Shared tabs use the same website sessions, not a network sandbox or isolated
profile. Password/CAPTCHA detection is conservative, not complete secret
protection. Stop cannot undo requests, account changes, or already scheduled
page JavaScript. Commands retain the server's original absolute `expires_at`
and never retry after their deadline.
