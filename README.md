# DomAgent secure-pairing beta

A local development branch of [DomAgent](https://github.com/vaishnavucv/domagent)
with independent browser-owner authorization, an HTTP MCP service, and Chrome
and Firefox extensions. No GitHub fork or published package is required.

**This is a private beta, not a production security certification.** Review
[validation gates](docs/SECURE-PAIRING.md#validation-and-release-gates) before
using real authenticated browser sessions.

## Architecture

```text
Browser extension -- outbound authenticated WSS --> Independent DomAgent service
  private device signing key                        OIDC owner dashboard
  local approval and semantic operations            /extension device bridge
  dedicated per-client automation tabs              /mcp HTTP MCP
                                                       ^
Agent group -- per-group OneCLI credential injection --+
```

DomAgent must be administered independently from BananaClaw, preferably on its
own host or VM. A BananaClaw login does not authorize device enrollment or control.
Device enrollment and every new control grant require trusted extension UI.

## Build and test locally

Node 22.13+ is required. Dependencies are pinned in the existing MCP package:

```bash
cd domagent-mcp
npm ci --ignore-scripts
npm test
npm run build
npm run check
```

Extension packages are generated under `dist/chrome` and `dist/firefox`.
See the browser-specific guides for private-beta installation. Do not load the
unbuilt source directories or rely on Firefox temporary installs for durable use.

The server has no insecure development login or unsigned-device shortcut.
Tests inject an internal mock identity provider and disposable state; these are
not exposed by the production entrypoint.

Real-browser validation is documented in
[the browser test guide](domagent-extension/test/README.md). The default suite
passes three Chrome/native-Firefox tests and explicitly skips one extended
Firefox case blocked by Playwright's Juggler instrumentation. Core Firefox
pairing/control is smoke-tested, not fully qualified for production.

## Deploy and enroll

1. Register DomAgent directly with an HTTPS OIDC issuer. Its callback is
   `https://your-domagent-host/oidc/callback`.
2. Configure the canonical HTTPS origin, exact issuer, and client ID. Keep the
   client secret in a restricted file, not agent configuration.
3. Invite the browser owner by the issuer's immutable subject:
   ```bash
   DOMAGENT_DB=/var/lib/domagent/domagent.db \
     node domagent-mcp/admin.js invite \
     https://your-issuer.example owner-subject 'Browser owner'
   ```
   Use the **exact** issuer string, including any path/trailing slash.
   Invitations expire after seven days and are consumed by first sign-in.
4. Start the service behind a TLS reverse proxy, using
   [systemd](deployment/domagent.service) or the
   [container example](deployment/compose.yaml).
5. In the extension, configure the HTTPS service origin and enroll. Check the
   dashboard's reference/key and finish confirmation locally in the extension.
6. Register an MCP client in the dashboard, securely import its once-shown
   credential into your vault, and link it to the enrolled device. Other invited
   browser owners may independently review and link that same public client ID
   to their own devices.
7. Request browser access through MCP and approve the dedicated tab locally.

Never expose the plaintext backend port to the Internet. The deployment examples
collect metadata through journald and disable raw reverse-proxy access logs.

## BananaClaw integration

Reuse existing per-agent-group HTTP MCP configuration and OneCLI grants. Register
one DomAgent identity per group. Do not share that credential globally or put the
real token in materialized container configuration.

[Agent-readable instructions](integration/skills/domagent/SKILL.md) can be
installed as a container skill. They explain how to guide the user through
independent enrollment and approval without handling raw secrets.

**OneCLI integration is gated:** actual header injection and proxy traversal
must be verified for each provider in the operator's deployment. This repository
does not invent a working placeholder, claim that environment variables prove
proxy use, or enable direct credential fallback.

## Browser operations

`list_browser_targets` and `request_browser_access` discover/request only your
eligible devices. Requests return immediately while the owner reviews them.
Every page operation requires an explicit active `target_id`.

Available semantic operations: `navigate`, `click`, `type_text`, `get_text`,
`evaluate_script`, `get_screenshot`, `get_interactive_elements`, `clear_overlays`,
and `request_handoff`, subject to the browser's advertised capabilities.

There is no raw CDP endpoint, `use_current_tab`, automatic user-tab attachment,
cookie/profile export, or remote grant approval. The upstream unauthenticated
stdio/local bridge is intentionally not retained as an authorization bypass.

Control ends on pause, disconnect, restart, or revocation. Reconnect restores
device identity only. Tabs stay open for human handoff; stopping new commands
does not undo completed actions or previously scheduled page JavaScript.

Page JavaScript can access page-visible secrets and perform authenticated account
actions. A dedicated tab is not an isolated browser profile or network sandbox.
See [security details, protocol, and deployment](docs/SECURE-PAIRING.md).
