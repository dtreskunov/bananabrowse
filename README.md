# DomAgent connections beta

Connect an independently approved browser to an MCP application. DomAgent is a
standalone service with tenant-specific HTTP MCP endpoints, its own OIDC login,
and Chrome/Firefox extensions. It has no dependency on a particular agent
application or credential manager.

**3.0.0-beta.1 is a breaking upgrade from beta.2.** Existing databases require
explicit tenant assignment and browsers require fresh pairing. Do not restart
an upgraded service against an unmigrated database.

## Browser installation

Download the browser-specific ZIP from
[GitHub releases](https://github.com/dtreskunov/domagent/releases/tag/v3.0.0-beta.1)
and extract all files together.

- Firefox: open `about:debugging#/runtime/this-firefox`, choose **Load Temporary
  Add-on**, and select the extracted `manifest.json`. Temporary installs disappear
  on restart; do not disable signature verification.
- Chrome/Chromium: open `chrome://extensions`, enable Developer mode, choose
  **Load unpacked**, and select the extracted directory.

Setup opens after installation. Paste the public **Connection link** provided
by your assistant or administrator, for example `https://your-server/join/<tenant>`.
Continue, sign in on the page opened by the extension, and approve. Connection
finishes automatically. **No tabs are shared until you approve a separate sharing
request in the extension.**

Saved connections can be switched without reinstalling. Only one is active;
switching never restores sharing. The shared webpage has a named border/banner
and **Stop sharing**, with independent toolbar status.

## Application setup

If no connection exists, the application's agent may request one:

1. Validate the operator-provided HTTPS domain and fetch `/.well-known/domagent`.
2. `POST /api/setup-requests` with `agent_name` and `request_description`.
3. Give the user the returned short-lived `verification_url` for invited-account
   sign-in and explicit approval.
4. Poll `POST /api/setup-requests/<id>/status` with the separate `status_receipt`.
   Approval returns public connection/MCP URLs, never the client credential.
5. The signed-in operator sees the credential once and configures the application
   through its own secure credential-management workflow.

The service generates tenant IDs; knowing an ID is not authorization.
MCP clients use authenticated Streamable HTTP at `/mcp/<tenant>`. Browsers use
authenticated WSS at `/extension/<tenant>`. Each credential/device is tenant-bound.

## Service installation

Node 22.13+ is required:

```sh
cd domagent-mcp
npm ci --ignore-scripts
npm start
```

Configure a canonical HTTPS origin, exact OIDC issuer, the service's own OIDC
client ID, restricted secret file if needed, and protected control-plane origins.
Register `https://your-server/oidc/callback`. Invite owners with:

```sh
node admin.js invite https://your-exact-issuer owner-subject 'Browser owner'
```

The server must run behind TLS on an independently administered host. Do not
expose its plaintext backend listener. See
[deployment/security details](docs/SECURE-PAIRING.md) and
[beta.2 migration](docs/TENANT-MIGRATION.md).

## Development

```sh
npm --prefix domagent-mcp ci --ignore-scripts
npm test
npm run build
npm run check
```

Build outputs are `dist/chrome` and `dist/firefox`, not the source manifest
directories. See [browser validation](domagent-extension/test/README.md).

The [MVP design](docs/ONBOARDING-AND-TENANCY.md) explains the tenant and onboarding
boundaries. Application-specific skills are maintained by those applications,
not shipped as DomAgent dependencies.

## Limits

This is an unsigned private beta, not a production security certification.
Firefox's tested build does not expose target-specific screenshots; page scripts
can be unavailable under page CSP. No visible-tab capture or privileged fallback
is provided.

Shared tabs use ordinary website sign-ins and may expose private page content.
Local approval governs new commands, not effects or JavaScript already scheduled.
Page decorations are best-effort visual cues; toolbar/extension state is authoritative.
Reconnect, pause, revoke, or restart ends all grants. Physical permission prompts,
notification UX, and advertised browser-version qualification remain release gates.
