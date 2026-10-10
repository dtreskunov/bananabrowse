# Extension validation

From the repository root, with parent-managed dependencies already installed:

```sh
node --test domagent-extension/test/*.test.js
node scripts/build-extensions.mjs
node domagent-mcp/node_modules/@playwright/test/cli.js test -c domagent-extension/playwright.config.cjs
```

With preinstalled engines and OS libraries in the rootless Playwright image:

```sh
podman run --rm --shm-size=512m -e PLAYWRIGHT_SKIP_BROWSER_GC=1 \
  -v "$PWD:/workspace" -w /workspace/domagent-mcp \
  mcr.microsoft.com/playwright:v1.58.2-noble npm run test:browser
```

The default suite runs the Chrome protocol fixture, actual-service Chrome
dashboard flow, and native Firefox RDP smoke. Only the extended Firefox Juggler
case is skipped unless `DOMAGENT_FIREFOX_JUGGLER=1` is explicitly set. The skip
explains the confirmed Playwright engine failure; it is not an assertion of
extended Firefox qualification. Chrome and native Firefox assertions are not
disabled or made optional.

The unfiltered default `npm run test:browser` passes in the rootless image:
**3 passed, 1 skipped (47.6s)**. The skipped test is precisely the opt-in extended
Firefox Juggler case; the native Firefox RDP smoke runs and passes by default.

The Chrome and Firefox tests use throwaway profiles and a self-signed HTTPS/WSS
fixture in `domagent-extension/.browser-artifacts/`, clean it up, and verify packaged
UI/runtime sender isolation, signed enrollment/handshake/approval, dedicated tab
creation, page operations, DNR redirect blocking, teardown, and IndexedDB key
survival. Firefox is installed as a real temporary WebExtension through its
remote-debugging addons actor; tests attempt to navigate the actual packaged
extension options UI, not a simulated page-world helper. The remote debugger and signature
preferences are confined to this throwaway test profile. Test-only browser
certificate overrides trust the HTTPS fixture. Production
code always requires HTTPS/WSS and never sets certificate exceptions.

Dedicated-tab provenance uses `storage.session` only: IDs from a previous browser
session are never trusted to adopt tabs in a later session. Device identity and
nonextractable signing keys use extension IndexedDB, not the tab inventory.

Tests also exercise owner pause/fresh reapproval, MAIN-world execution without
extension APIs, real page-CSP capability behavior, tab-specific PNG screenshots
or an explicit Firefox unavailable error, and protected-origin page fetches.

`service.spec.cjs` uses the actual `Store`, `createApp`, enrollment endpoints,
signed device bridge, owner dashboard approval, and HTTP MCP SDK. Only the OIDC
issuer and initial test-owner session are fixtures. The client is registered by
a different invited owner to exercise explicit cross-owner linking. The browser
still performs final enrollment confirmation and per-client approval locally.

Current qualification: the real Chromium fixture passes, including blocking a
protected top-level redirect and a protected page fetch. Firefox installation
succeeds without manifest warnings. RDP confirms an active policy, running
background, and the exact packaged options URL. Native Firefox loads that
document in an `extension` process, but the supplied Playwright 1.58.2 Firefox
engine fails at `chrome://juggler/content/content/FrameTree.js:543` with
`this.domWindow() is undefined`, followed by JSWindowActor message errors.
Playwright observes `about:blank` instead of the loaded document. Both headless
and headed/Xvfb attempts fail. No engine patch or extension-process security
preference workaround is applied; the full Firefox page-operation matrix remains a release
gate. Opt into that retained extended case inside the container with:

```sh
DOMAGENT_FIREFOX_JUGGLER=1 npm run test:browser -- --grep 'real firefox' --reporter=line
```

For a rootless extended run, add `-e DOMAGENT_FIREFOX_JUGGLER=1` to the image
command above and append `-- --grep 'real firefox' --reporter=line`. This remains
a diagnostic/release-qualification command expected to fail on the supplied
Juggler engine, not the normal validation path.

Reproduce the native-browser versus Playwright diagnostic with
`DOMAGENT_FIREFOX_JUGGLER=1 DOMAGENT_FIREFOX_DIAGNOSTICS=1 DOMAGENT_FIREFOX_NATIVE_OPTIONS=1`; for headed
diagnosis, additionally set `DOMAGENT_HEADED_FIREFOX=1` and run under Xvfb.

The actual-service Chrome case passes signed enrollment, the actual dashboard
approval form, local final confirmation, authentication, cross-owner MCP control,
a real PNG screenshot, and pause. No Store approval override is used. Chrome's
Origin-absent challenge GET and Origin-present signed POST succeed against the
actual service, and the dashboard form sends its exact Origin after the service's
`same-origin` response policy fix.

Both Chrome cases pass without any approval override:

```sh
# In the rootless image, working directory /workspace/domagent-mcp:
npm run test:browser -- --grep 'real [cC]hrome' --reporter=line
```

`firefox-native.spec.cjs` launches the Firefox binary directly and controls it only
through native RDP, without using Playwright's Juggler pipe. It inspects the actual
installed options document, trusts the fixture CA only in its disposable profile,
and pre-grants page hosts. The native console has no real user-activation gesture,
so configuration and grant decisions use the same trusted options-page runtime
sender boundary; enrollment/status/final confirmation and pause use actual
packaged controls. Owner approval is supplied through the real Store fixture.
This does not qualify browser permission prompts or physical approval clicks.
The native RDP smoke passes on Firefox 146.0.1 (11.3s), proving actual signed
enrollment, final local confirmation, authentication, a fresh local grant,
dedicated-tab navigation/text extraction through the actual MCP service, and
local pause. Firefox screenshots, CSP behavior, protected redirect/subresource
blocking, and browser restart still require separate real-browser qualification.

```sh
npm run test:browser -- --grep 'native Firefox RDP smoke' --reporter=line
```

The final combined run passes all three selected cases in 44.2s without any
Chrome approval override or changes to service files:

```sh
npm run test:browser -- --grep 'real [cC]hrome|native Firefox RDP smoke' --reporter=line
```

The 45 extension unit tests, source syntax checks, and both bundled builds pass.

Commands require an absolute `expires_at` timestamp from the original server
enqueue. The extension takes the earlier of that deadline and its own local
budget, and checks it again after asynchronous document inspection before issuing
page work. It never retries an expired command.

Browser-test host permissions are pre-granted in the fixture manifest, not in
the production packages. Qualify the real optional-host permission prompts and
notification behavior manually in Chrome and Firefox. A Chromium Playwright
binary and Firefox binary must already be installed; this suite does not install
them. Required OS libraries must be provisioned separately; the dependency
command is `sudo node domagent-mcp/node_modules/playwright/cli.js install-deps chromium firefox`.

Firefox unit tests separately exercise its blocking webRequest adapter, MAIN-only
supplied
script path, CSP failure, and tab-specific screenshot capability. They are **not**
real Firefox validation. The integration suite supplies temporary WebExtension
loading through Firefox RDP, which Playwright does not expose itself. Before
release, additionally load `dist/firefox/manifest.json` in Firefox
128+ with a trusted-TLS service, verify local pairing/host prompts, CSP-denied
evaluation, `captureTab` permission/availability, protected redirects/frames/
subresources, background restart, and fresh approval after disconnect.

Candidate minimum browser versions require release qualification. Password/
CAPTCHA heuristics deliberately fail closed when detected, but are not complete
secret protection. Persistent site effects and previously scheduled page code
cannot be undone by stopping control.
