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
cannot authorize v2 connections: pair again using a connection link.

**Share a tab** is always a separate local decision, requesting optional HTTP(S)
access, including intranet sites. **Run page scripts** is unchecked by default.
The named border/banner and toolbar show sharing; **Stop sharing** in the page
can stop only that tab's current document, never approve or change settings.
Decoration is best-effort; a website can hide or imitate it. Marker failures
warn without disabling otherwise usable control.

Each grant creates a dedicated tab, or reuses this client's inactive dedicated
tab. Never a user tab. Protected-origin session DNR rules (including redirects
and subresources) are installed before a grant is signed. Page evaluation and
screenshots use a narrow internal debugger dispatcher; no raw CDP is exposed.

Pause, handoff, revoke, disconnect, lost heartbeat and worker/browser restart
end control, remove debugger attachment and rules, and keep the tab. A fresh
request plus local approval is required afterward. Prior/scheduled JavaScript,
network requests and account changes are **not undone**. Website sessions are
shared, page code can read page-visible secrets, and this is not a profile or
network sandbox. Authenticate manually before granting control.

`node --test domagent-extension/test/*.test.js` runs the local unit suite.
Browser tests and limitations are documented in `../test/README.md`.
