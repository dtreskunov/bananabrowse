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
tenant keys reauthenticate with protocol v4 without re-pairing. Update the matched
server and extension together; unsafe older v3 clients are rejected.

An MCP request notifies/marks the toolbar. Its click opens Chrome's native side
panel immediately and shares the selected website tab when the application is
unambiguous. Panel controls also allow explicit request/client selection.
The actual tab moves into a dedicated normal window without cloning/reloading.
If the new panel cannot open after the asynchronous move, click its toolbar;
the failure is explicit. Optional HTTP(S) permission is requested only at sharing. The fixed
page capabilities include scripts; there are no capability checkboxes.

Each handle is bound to one tab/window; another tab/popup or moving the tab revokes
sharing without adopting other tabs. Multiple workspaces can be shared with one client. Another client cannot take a shared
tab. Protected-origin session DNR rules (including redirects
and subresources) are installed before a grant is signed. Page evaluation and
screenshots use a narrow internal debugger dispatcher; no raw CDP is exposed.

Each action displays operation-derived details and an unverified explanation in
the browser-owned side panel/trusted settings. **Approve**, **Decline**, and **Allow all while sharing**
apply to the selected tab only; allow-all expires when sharing ends. Approval
signals readiness; execution waits for the server's fresh 25-second permit.
Normal navigation invalidates old-document actions, not sharing. Login/CAPTCHA
presence does not block page inspection. Human assistance uses **Done**/**Cancel**
without teardown and never follows allow-all.

No positive controls are present in webpage DOM; even genuine page.decision
messages are rejected. Cosmetic page decoration retains only a trusted-click,
nonce/sender/tab/document-bound negative Stop. Private bounded metadata history
records commands/observed events, not every arbitrary-script side effect.

Pause, revoke, protected-page navigation, disconnect, lost heartbeat and worker/browser restart
end control and remove debugger attachment/rules. Explicit Stop/Disconnect closes
the controlled tab, losing unsaved state; unexpected revocation retains it. A fresh
request plus local approval is required afterward. Prior/scheduled JavaScript,
network requests and account changes are **not undone**. Website sessions are
shared, page code can read page-visible secrets, and this is not a profile or
network sandbox. Moving preserves normal logins and opener/same-origin links;
closing cannot undo sent requests, account changes or site background workers.
Human login can be completed while the tab remains shared.

`node --test domagent-extension/test/*.test.js` runs the local unit suite.
Browser tests and limitations are documented in `../test/README.md`.
