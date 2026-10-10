# Chrome secure extension

Build from the repository root: `node scripts/build-extensions.mjs`. The build
uses the pinned esbuild dependency in `domagent-mcp`. Load **`dist/chrome`** using
Chrome's Load unpacked flow. This source directory is not an installable package.
Chrome 118+ is the candidate baseline, not a claim of release qualification.

Open extension options, save the canonical **HTTPS** service origin and add
local IdP/management origins. Saving requests permission for that service only.
Start enrollment, follow its service-dashboard link, check dashboard approval,
verify the displayed owner ID, and locally confirm. Connect restores identity
only. Approve each client's request locally, selecting allowed capabilities.
Approval requests broad optional HTTP(S) host access, including intranet sites.

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
