# Secure pairing: implementation and deployment

## Trust model

DomAgent, its independently administered VM, TLS proxy, and IdP are trusted.
Agent requests and pages are untrusted. The extension enforces locally approved
client/target ownership and a semantic operation allow-list. A compromised
BananaClaw can abuse existing grants but cannot mint new extension approvals.

Keep this VM's administration, OIDC secret, state, and extension distribution
independent from BananaClaw. OneCLI is trusted for group-specific credentials and
MCP traffic; it does not make an authorized malicious action safe.

## Configuration

| Variable | Meaning |
| --- | --- |
| `DOMAGENT_ORIGIN` | Required canonical HTTPS origin without path/query/credentials |
| `DOMAGENT_OIDC_ISSUER` | Required exact HTTPS issuer, including path/trailing slash |
| `DOMAGENT_OIDC_CLIENT_ID` | DomAgent's own OIDC registration |
| `DOMAGENT_OIDC_CLIENT_SECRET_FILE` | Restricted file containing the confidential-client secret; optional for public clients |
| `DOMAGENT_PROTECTED_ORIGINS` | Additional comma-separated HTTPS control-plane origins, including BananaClaw |
| `DOMAGENT_BIND` | Backend address; default `127.0.0.1` |
| `DOMAGENT_PORT` | Backend port; default `18792` |
| `DOMAGENT_DB` | Private database; default `./data/domagent.db` |

The service adds its own origin and the issuer/authorization-endpoint origins to
the protected list. Configure every relevant control-plane alias. The extension
also enforces its local protected-origin configuration.

The server discovers and validates OIDC through `openid-client`. Owners are
matched by exact `(issuer, subject)`, never by a claimed email/group name.
Admin invitations expire after seven days; the first admitted login consumes the
invitation. Owner sessions expire after eight hours and remain revocable.

Use `admin.js disable-owner <owner-id>` to disable an owner. The service checks
persistent state on requests and reconciles live devices/grants at least every
five seconds. MCP requests never inherit authority from a previous HTTP session.

## Enrollment and device protocol

Extensions generate per-service non-extractable P-256 signing keys and store them
in extension-private IndexedDB. The service persists only public keys.
Non-extractability is not hardware-backed protection from OS/extension compromise.

1. `GET /api/enrollment/challenge` supplies a 60-second one-time nonce.
2. `POST /api/enrollment/start` proves key possession and creates a five-minute
   transaction.
3. The owner opens the verification URL, signs in directly, and approves the
   exact reference/key in DomAgent's dashboard.
4. The extension shows the returned owner/reference and signs final confirmation
   only after a local action. Enrollment creates no control grant.

Enrollment API requests are proof-bound. Extension origins are restricted and
checked where supplied; Origin alone is never authentication. Chrome may omit
Origin on the challenge GET and supply it on the signed POST. A challenge with
no Origin allows that transition; a supplied challenge Origin must still match,
and the signed extension origin must match any POST Origin.

WSS `/extension` accepts `hello`, a server challenge, and a signed `proof`.
Signatures use the fixed domain-separated arrays in
[the shared protocol](../shared/protocol.js), not unspecified JSON concatenation.
The transcript binds origin, server epoch, connection ID, nonce, and key ID.
The unauthenticated deadline is five seconds.

Every device has one current connection. Replacement invalidates old grants;
old close handlers cannot erase a new connection. Five-second application
heartbeats bound silent-partition detection to 15 seconds plus scheduling delay.
Reconnect never restores authority.

## Client credentials and grants

The owner registers an MCP identity and imports the once-shown 256-bit credential
into their vault. DomAgent stores only its SHA-256 hash. Rotation/revocation ends
affected grants; old credentials stop authenticating immediately.

Client credentials authorize `/mcp` only, not owner management or enrollment.
The MCP endpoint is stateless Streamable HTTP: every POST authenticates again.
Missing/invalid credentials receive 401, and management requests still need an
owner cookie, same-origin request, and CSRF token.

An owner-created client/device link permits control requests. It does not create
an active grant. The extension's signed approval binds request, client, device
connection, fresh target, policy version, nonce, and capability list.

Clients can be shared across invited browser owners by their exact public client
ID. The browser owner reviews that identity in their own dashboard and may link
only devices they own. This does not reveal any other owner's devices or grant
the client operator permission to create links. Each owner can unlink their own
device independently, and local extension confirmation is still required.

The service routes each operation by authenticated client identity. The extension
independently resolves that target to its own dedicated tab. Page operations
require an explicit target even if there is only one browser. Per-target queues
are serialized and limited to 32 entries. Commands expire after 25 seconds;
mutations are never automatically retried after uncertain outcomes.
Each dispatched command carries its original enqueue deadline as `expires_at`;
the extension rejects expired work before page execution, including after local
inspection or queueing. A timeout cannot become a fresh execution allowance.
Pending access requests are coalesced. After local denial, the client cannot
prompt that device again for 30 seconds; a local owner-initiated request may
bypass that notification cooldown, but never bypasses approval.

There is no current-tab adoption, automatic user-tab attachment, raw debugger
forwarding, or remote resume operation. Local resume requires another approval.

## Protected origins, scripts, and human handoff

Control-plane origins must be blocked for the target tab, including redirects
and relevant subresources. A navigation listener after the request is not a
substitute. Grants must fail closed if the browser cannot install the required
blocking policy.

Untrusted scripts execute only with ordinary page authority. Firefox must not
evaluate supplied strings in an extension/content-script realm. Chrome uses
only narrowly selected internal debugger operations. No browser-cookie/profile
or cross-origin frame execution interface is exposed.

Unsupported safe evaluation or capture must return an explicit capability error.
The screenshots must refer to the authorized tab, not the currently visible tab.

Capabilities are also local grant selections. Page evaluation is unchecked by
default in the approval UI; capture is offered only when the adapter exposes a
target-specific capture API. Missing capabilities do not imply a server config
error and must not be added remotely.

CSS selectors use `document.querySelector`. Missing elements return
`ELEMENT_NOT_FOUND`, and malformed CSS returns `INVALID_SELECTOR`; neither ends
the grant. Implicit HTML defaults are not DOM attributes: a bare `<button>`
submits its form but does not match `[type="submit"]`.

Successful click/type acknowledgements can survive an ordinary navigation they
triggered; page-derived results and commands queued for the old document still
fail as `TARGET_STALE`. Never automatically retry a mutation after a stale or
uncertain reply.

Every operation requires inspection of the current document. If browser policy
refuses that inspection, `PAGE_UNAVAILABLE` ends the local and server grant,
discards queued work, and clears the active target. The connection and tab stay
open; the owner must inspect or navigate it and locally approve a fresh target.
Navigation is not a bypass for an uninspectable document. Optional script/CSP
or capture failures alone remain `CAPABILITY_UNAVAILABLE` without ending an
otherwise inspectable grant.

Known auth signals, conservative heuristics, and explicit `request_handoff`
pause control. Browser prompts and file selection need human intervention.
Automatic login/CAPTCHA detection is best effort, not a secret-isolation guarantee.

Keep tabs open when control ends. Pause stops new agent commands, not already
scheduled JavaScript, requests, or account changes. Tabs share ordinary website
sessions and can reach internal networks. Disclose this before approval.

## systemd, containers, and logs

The [systemd unit](../deployment/domagent.service) runs Node as an unprivileged
service user with private state and credentials loaded from restricted files.
Install the clone at `/opt/domagent`, dependencies under its MCP package, and
configuration at `/etc/domagent/domagent.env`.

Alternatively use the [compose example](../deployment/compose.yaml) on the
independent VM. It publishes only host loopback, runs a non-root read-only
container with no Docker socket, and sends output to journald. Ensure the mounted
OIDC secret is readable by the container's service UID without exposing it to
unrelated users. Do not commit the secret file.

Put a TLS reverse proxy in front; adapt the [nginx example](../deployment/nginx.conf.example)
to the real hostname/certificate. Do not expose the backend listener publicly.
Do not enable raw access logs. Review proxy error logging for URL/token disclosure
before production; the example limits error logging to critical events.

Service audit output is structured metadata only. No DOM, screenshot, script,
typed text, page title, full URL, cookie, credential, private key, pairing proof,
or OIDC code/token is retained in service audit records. Journal retention/access
follow host policy. BananaClaw may retain returned page content in conversation
history independently.

Back up identities and credential/revocation state, never active grants. A stale
backup can resurrect an old credential: reconcile and rotate affected credentials
before reconnecting restored state.

## BananaClaw and OneCLI

Use existing group-level HTTP MCP config and grant this client credential only
to the matching OneCLI agent. Do not add it to the global new-agent secret list.
The [container skill](../integration/skills/domagent/SKILL.md) guides setup without
putting credentials into chat.

To install the instructions for a selected group, copy
`integration/skills/domagent/` into that BananaClaw checkout's
`groups/<group-folder>/skills/domagent/`, then restart that group through the
normal administration workflow. Workspace skills are discovered for that group;
ensure `domagent` is not in its disabled-skill list. This is an operator action,
not something the DomAgent service can perform remotely.

Use BananaClaw's existing group MCP settings editor: name `domagent`, transport
`http`, URL `https://your-domagent-host/mcp`, and the operator-verified
gateway placeholder in the appropriate header. The current CLI
`ncl groups config add-mcp-server` creates stdio entries only. Do not use a stdio
wrapper to bypass credential injection. The settings API replaces the entire
MCP map; preserve unrelated entries if using it instead of the editor.

Do not substitute a real token for an unverified placeholder. For each provider,
verify authenticated discovery/status, actual proxy traversal, destination-bound
injection, group isolation, credential non-exposure, revocation, and explicit
failure when the gateway/grant is absent. Test with the actual gateway and
deployment rather than assuming `HTTPS_PROXY` suffices.

## Validation and release gates

Automated service tests cover signed enrollment, owner admission, CSRF, OIDC
state binding, per-client targets, connection replacement, protected navigation,
revocation, and real HTTP MCP discovery/status through the SDK.
An isolated OIDC fixture exercises the actual `openid-client` library's discovery,
PKCE, state, nonce, issuer, audience, and expiry validation; it is not a substitute
for testing real HTTPS discovery and the deployed identity provider.
Extension tests/builds cover the local policy/runtime separately.

Real Chrome tests have exercised packaged-extension control and the actual
service's signed enrollment through real dashboard forms, cross-owner MCP
routing, target-specific PNG capture, and pause.

A native Firefox 146.0.1 RDP test passes signed pairing, local confirmation,
trusted-UI grants, navigation/text, form POST, and pause. It additionally verifies
explicitly approved MAIN-world evaluation without extension APIs, CSP-denied
evaluation without ending otherwise usable grants, protected fetch/image/frame
requests and top-level redirects, refused document inspection, disconnect,
fresh approval, and a full Firefox process restart. After reinstalling the
temporary add-on in the same profile, identity/key persist, tab provenance is
empty, and old grants remain invalid.

The tested Firefox build does not expose `tabs.captureTab`; screenshots are
therefore omitted from approval capabilities and return an explicit unsupported
error. No visible-tab fallback is used. These tests pre-grant host permissions:
physical optional-host prompts, notification UX, independently restarted
background scripts, and other candidate browser versions still need qualification.
The broader Firefox / Playwright 1.58.2 test is blocked by a crash inside
Playwright's Juggler frame instrumentation after loading the options document;
the native smoke avoids that instrumentation rather than weakening the extension.
Do not advertise full Firefox qualification from the smoke test alone.

The reproducible real-browser tests are documented in
[the browser test guide](../domagent-extension/test/README.md). They mock external
OIDC identity-provider infrastructure, not the actual service's enrollment or
MCP authorization path. The default browser suite passes three tests and
explicitly skips the blocked extended Firefox Juggler case. Set
`DOMAGENT_FIREFOX_JUGGLER=1` only to run that additional qualification case on a
compatible harness; this opt-in does not change production extension behavior.

Before production:

- Qualify physical optional-host permission/notification UX and repeat the browser
  matrix on every advertised version. Validate independently restarted workers
  and target-specific capture wherever that capability is advertised.
- Validate a real configured OIDC provider, TLS termination, owner invitations,
  and browser cookie/Origin behavior.
- Complete the live OneCLI verification for every advertised BananaClaw provider.
- Review the deployed extension update channel and proxy/journal permissions.

Beta builds are source/private packages. Firefox temporary installations do not
provide production persistence. Store signing/publishing remains independent of
BananaClaw. Never download executable extension code from the service.
