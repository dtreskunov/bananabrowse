# Firefox secure extension

Build from the repository root: `node scripts/build-extensions.mjs`. Load
**`dist/firefox/manifest.json`** as a temporary extension for development.
This source directory is not an installable package. Firefox 128+ is the
candidate baseline for MAIN-world scripting; actual Firefox release validation
is still required.

Firefox uses Manifest V2 with a persistent background page for its long-lived
authenticated browser connection. The earlier MV3 event-page build could be
suspended while the browser was idle; opening the toolbar then woke it again.
This is not a requirement to share a tab or keep the popup/settings open.
Website access remains optional and is still requested only on local approval.
Chrome continues to use its MV3 service worker.

Installation opens **Connect your browser**. Paste the public HTTPS connection
link (`https://server.example/join/<tenant-id>`) and choose **Continue**. Permission
is requested only for that server. Sign in and choose **Connect browser** on the
server; verified approval completes automatically, without sharing a tab.

Saved connections have independent nonextractable device keys. One connection
is enabled at a time; switching ends sharing and queued actions. Updates keep
identity without reopening setup. Legacy origin-only records cannot authorize
tenant connections and require fresh pairing. Existing tenant keys authenticate
protocol v4 without re-pairing; matched upgrades reject unsafe older v3 clients.

Requests notify/mark the toolbar. Click it to open the native Firefox sidebar and
share the selected actual tab with an unambiguous linked application. Panel
controls also allow explicit selection. Sharing moves the actual tab into a
dedicated normal window, preserving its document and unsaved state. Each handle
owns one tab/window; other tabs/popups or moving it revoke sharing, not adopt
other tabs. If opening controls after the move is browser-refused, click the
workspace toolbar; `PANEL_OPEN_REQUIRED` is explicit. Sharing requests optional HTTP(S)
website permission, including intranet hosts. Capabilities are fixed, without
checkboxes, and scoped only to selected tabs. Multiple tabs per client are allowed.

Each action's operation-derived details and unverified description appear in the
browser-owned sidebar or trusted settings.
**Approve**, **Decline**, or **Allow all while sharing** control ordinary actions;
allow-all is scoped to that grant. **Done**/**Cancel** handle human assistance
without ending sharing; allow-all never confirms human tasks. Readiness waits for
the server's fresh 25-second execution permit. Navigation invalidates old-document
actions without ending sharing; password/CAPTCHA presence does not block inspection.

Webpage DOM has no positive controls and every page.decision is rejected, even
with genuine sender/nonce metadata. The cosmetic banner contains only a
trusted-click, bound negative Stop. Private local metadata history is capped at
200 events, not exposed to MCP and not a full audit of arbitrary-script effects.

A blocking webRequest listener protects all requests from each selected shared
tab, including redirects and subresources, before grant approval. Remote code is
injected only in the **MAIN page world**: never eval'd in the extension/content
realm. Page CSP can make evaluation unavailable, which returns a typed failure.
Screenshots use `tabs.captureTab(tabId)` only; if absent, screenshot capability
is not advertised. No visible-tab substitution or placeholder exists.
The tested Firefox 146.0.1 build does not expose that API to this extension;
screenshots are unavailable there. `evaluate_script` is advertised as a fixed
capability and requires per-action approval unless allow-all is enabled; page CSP
can still make it unavailable.

Control ends on stop, protected-page navigation, revoke, disconnect, missed heartbeat and restart.
Explicit Stop/Disconnect closes owned tabs, losing unsaved state. Unexpected
revocation leaves the response for inspection; fresh approval is required. Tabs share website
sessions; page-readable secrets, cookies and ordinary page network/account
actions are exposed. Prior/scheduled JavaScript and side effects are not undone.
Normal cookies/login state and opener relationships persist; this is not a
sandbox. Closing cannot undo sent requests/account changes/site background
workers. No claim is made that login/CAPTCHA heuristics hide all secrets.

`node --test domagent-extension/test/*.test.js` runs local enforcement tests.
See `../test/README.md` for browser qualification limitations.
