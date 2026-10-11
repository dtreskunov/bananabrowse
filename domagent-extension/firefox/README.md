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
v2 connections and require fresh pairing.

**Share a tab** requires separate local approval and optional HTTP(S) website
permission, including intranet hosts. A named page border/banner and toolbar
show sharing. The page's **Stop sharing** stops only that tab's current document,
never approves, resumes, or changes settings. Decoration is best-effort and can
be hidden or imitated by a website; cosmetic failures warn but do not block
otherwise usable control.

A blocking webRequest listener protects all requests from each active dedicated
tab, including redirects and subresources, before grant approval. Remote code is
injected only in the **MAIN page world**: never eval'd in the extension/content
realm. Page CSP can make evaluation unavailable, which returns a typed failure.
Screenshots use `tabs.captureTab(tabId)` only; if absent, screenshot capability
is not advertised. No visible-tab substitution or placeholder exists.
The tested Firefox 146.0.1 build does not expose that API to this extension;
screenshots are unavailable there. `evaluate_script` is offered but unchecked
by default: select it during fresh local approval to enable ordinary page
evaluation, subject to the page's CSP.

Control ends on pause, handoff, revoke, disconnect, missed heartbeat and restart.
The tab remains open, and a fresh local approval is required. Tabs share website
sessions; page-readable secrets, cookies and ordinary page network/account
actions are exposed. Prior/scheduled JavaScript and side effects are not undone.
No claim is made that login/CAPTCHA heuristics hide all secrets.

`node --test domagent-extension/test/*.test.js` runs local enforcement tests.
See `../test/README.md` for browser qualification limitations.
