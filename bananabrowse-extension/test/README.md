# v6 tests

```sh
npm --prefix bananabrowse-mcp ci --ignore-scripts
npm --prefix bananabrowse-extension ci --ignore-scripts
npm --prefix bananabrowse-extension/ui ci --ignore-scripts
npm --prefix bananabrowse-mcp test          # service, extension unit and UI presentation tests
npm --prefix bananabrowse-mcp run build
npm --prefix bananabrowse-mcp run check
```

Use Podman with the Playwright image to test in real browsers, even when no
browser is installed on the host. The image includes Chromium and Firefox for
page-helper tests and Chromium for extension end-to-end tests. From the
repository root, after building:

```sh
podman run --rm --userns=keep-id --ipc=host \
  -v "$PWD:/work:rw" -w /work/bananabrowse-mcp \
  mcr.microsoft.com/playwright:v1.58.2-noble \
  node node_modules/@playwright/test/cli.js test \
  --config ../bananabrowse-extension/playwright.config.cjs \
  query-all.spec.cjs app-window.spec.cjs
```

Native Firefox extension end-to-end tests require an official Firefox 153+
build mounted into the container; the bundled Playwright Firefox is sufficient
for page-helper tests, not a substitute for that extension test:

```sh
podman run --rm --userns=keep-id --ipc=host \
  -v "$PWD:/work:rw" -v /path/to/firefox153:/firefox153:ro \
  -e BANANABROWSE_FIREFOX_BINARY=/firefox153/firefox/firefox \
  -w /work/bananabrowse-mcp mcr.microsoft.com/playwright:v1.58.2-noble npm run test:browser
```

What they cover, against the real service over TLS with a real MCP client:

- `app-window.spec.cjs` (Chrome): install opens the app window; setup by
  clicking the real UI; pairing code and Approve; session request card,
  approval, colored group in the background; the shared page-action fixtures;
  `create_tab`; a user-added tab coming into scope; progress feed; handoff with
  a flashing group, badge and Done; close confirmation (`beforeunload`), graceful
  disconnect, debugger and protection rules removed; reopen with automatic
  reattach and the same tab IDs; second window refused; ungrouping ending the
  session; decline; `end_session` ungrouping. A second test simulates a new
  browser run (headless Chromium does not restore groups across real
  restarts): group IDs change, the window asks to reconnect, and tab IDs survive.
- `firefox-app.spec.cjs` (native Firefox 153 over RDP): the same flow driven
  through the window's controller (RDP evaluation is not a user gesture), plus
  `USER_SCRIPT`, protected-origin blocking, per-tab session values, close and
  reopen, and a **full browser restart** that reattaches the same session and
  tab IDs.
- `page-actions.spec.cjs`, `readiness-editing.spec.cjs`: page helper behavior
  in both engines.
- `query-all.spec.cjs`: structured extraction in both engines, including scoped
  open shadow roots, redaction, URL handling, Unicode limits, field errors and
  preservation of focus, scrolling and snapshot refs. The app-window fixtures
  also exercise `query_all` through the real MCP service and extension.

Permission prompts are pre-granted in disposable profiles (Chrome manifest
`host_permissions`, Firefox's permission store). Physical permission dialogs,
OS notification visibility and real Chrome session restore remain manual
acceptance checks.
