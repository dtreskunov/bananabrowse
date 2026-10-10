# Firefox secure extension

Build from the repository root: `node scripts/build-extensions.mjs`. Load
**`dist/firefox/manifest.json`** as a temporary extension for development.
This source directory is not an installable package. Firefox 128+ is the
candidate baseline for MAIN-world scripting; actual Firefox release validation
is still required.

Use extension options to save an **HTTPS** service origin and local
IdP/management origins, start enrollment, verify on the owner dashboard, check
approval, and explicitly confirm the displayed owner. Reconnecting restores
identity only. Approving a client locally requests optional HTTP(S) host access,
including intranet hosts, and creates only a dedicated automation tab.

A blocking webRequest listener protects all requests from each active dedicated
tab, including redirects and subresources, before grant approval. Remote code is
injected only in the **MAIN page world**: never eval'd in the extension/content
realm. Page CSP can make evaluation unavailable, which returns a typed failure.
Screenshots use `tabs.captureTab(tabId)` only; if absent, screenshot capability
is not advertised. No visible-tab substitution or placeholder exists.

Control ends on pause, handoff, revoke, disconnect, missed heartbeat and restart.
The tab remains open, and a fresh local approval is required. Tabs share website
sessions; page-readable secrets, cookies and ordinary page network/account
actions are exposed. Prior/scheduled JavaScript and side effects are not undone.
No claim is made that login/CAPTCHA heuristics hide all secrets.

`node --test domagent-extension/test/*.test.js` runs local enforcement tests.
See `../test/README.md` for browser qualification limitations.
