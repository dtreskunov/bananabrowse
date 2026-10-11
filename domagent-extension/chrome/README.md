# Chrome secure extension

Build from the repository root: `node scripts/build-extensions.mjs`. The build
uses the pinned esbuild dependency in `domagent-mcp`. Load **`dist/chrome`** using
Chrome's Load unpacked flow. This source directory is not an installable package.
Chrome 118+ is the candidate baseline, not a claim of release qualification.

Installation opens **Connect your browser**. Paste the public HTTPS connection
link (`https://server.example/join/<tenant-id>`) and choose **Continue**. Only
that server's permission is requested. Sign in and choose **Connect browser** on
the server; the extension verifies approval and finishes automatically. This
shares no tabs and does not request general website permission.

Saved connections have independent, nonextractable device keys. One connection
is enabled at a time; switching stops all old sharing and queued actions.
Updates retain identity without opening setup. Legacy origin-only identities
cannot authorize tenant connections: pair again using a connection link. Existing
tenant keys reauthenticate with protocol v3 without re-pairing.

An MCP sharing request opens a small extension-owned window immediately. Visit
an existing/new website tab and use the toolbar's **Share this tab with …**.
The chosen normal-window tab URL is displayed; the request window itself cannot
be shared. Optional HTTP(S) permission is requested only at sharing. The fixed
page capabilities include scripts; there are no capability checkboxes.

Multiple tabs can be shared with one client. Another client cannot take a shared
tab. Protected-origin session DNR rules (including redirects
and subresources) are installed before a grant is signed. Page evaluation and
screenshots use a narrow internal debugger dispatcher; no raw CDP is exposed.

Each action displays its operation and description in the tab overlay and trusted
extension popup/settings. **Approve**, **Decline**, and **Allow all while sharing**
apply to the selected tab only; allow-all expires when sharing ends. Approval
signals readiness; execution waits for the server's fresh 25-second permit.
Normal navigation invalidates old-document actions, not sharing. Login/CAPTCHA
presence does not block page inspection. Human assistance uses **Done**/**Cancel**
without teardown and never follows allow-all.

Overlay approval handlers run in the packaged isolated world and require
`event.isTrusted`; page scripts cannot approve by clicking the cosmetic DOM.
Nonce/sender/tab/frame/document/grant binding protects runtime decisions. A
website can hide or imitate decoration; the trusted popup/settings is a fallback.

Pause, revoke, protected-page navigation, disconnect, lost heartbeat and worker/browser restart
end control, remove debugger attachment and rules, and keep the tab. A fresh
request plus local approval is required afterward. Prior/scheduled JavaScript,
network requests and account changes are **not undone**. Website sessions are
shared, page code can read page-visible secrets, and this is not a profile or
network sandbox. Human login can be completed while the tab remains shared.

`node --test domagent-extension/test/*.test.js` runs the local unit suite.
Browser tests and limitations are documented in `../test/README.md`.
