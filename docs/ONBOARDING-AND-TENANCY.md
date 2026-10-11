# MVP proposal: guided DomAgent connections

**Status:** implemented in 3.0.0-beta.1; a breaking upgrade from beta.2.
**Updated:** 2026-10-10.

Build a simple way to connect a browser to an assistant, with separate logical
MCP endpoints on one DomAgent server. Keep the security boundaries that prevent
cross-tenant access and unauthorized browser control; avoid turning first-run
setup into an administration workflow.

DomAgent is client-agnostic. It knows nothing about application-specific agent
groups or credential managers. The calling application's external skill handles
discovery and its own MCP/credential configuration. Technical terms below are
implementation notes, not wording to show ordinary users.

## 1. MVP scope

| Include now | Leave for later |
| --- | --- |
| Server-generated tenant IDs and isolated endpoints | Application-specific APIs or configuration brokers |
| One initial client per tenant | Multiple-client administration and a general role-management UI |
| Configured-provider sign-in, automatic account registration, and tenant membership checks | New identity systems or self-service server administration |
| Agent setup link with name and short explanation | Identity attestations, rich request content, or a chat client |
| One Connection link field after extension installation | Automatic webpage-to-extension configuration bridges |
| Automatic connection after the user approves on the server | A second confirmation or mandatory fingerprint comparison |
| Multiple saved connections; one active connection | Simultaneous connections or an elaborate profile manager |
| Separate local approval before sharing a tab | Automatic sharing, permission expansion, or grant restoration |
| Page border/banner and toolbar sharing status | Native browser-window decoration or tamper-proof page indicators |
| Manual application credential setup | Automatic credential transfer or client-specific vault integration |
| Explicit migration and browser re-pairing | A parallel beta.2 compatibility service |

The MVP keeps a tenant owner and authorized browser members. Reuse the existing
OIDC sign-in mechanism and host administration where possible, rather than
building a new management platform. Server admission alone is not membership in
every tenant.
Any user authenticated by the configured provider may approve creating their own
connection without a DomAgent invitation. Disabled accounts remain blocked.

## 2. The end-to-end journey

### A. The agent asks the user to approve setup

The calling application's skill first checks its existing DomAgent MCP
configuration. Reuse a configured tenant instead of creating duplicates; an
authorization or connectivity failure is not a reason to create another tenant.

If there is no configuration, ask for the server domain and check compatible
metadata over HTTPS. Apply the calling application's outbound-request policy;
do not probe arbitrary private or metadata-network addresses from chat input.
Explain that DomAgent can help with a real browser session, not guarantee a
bot-protection or CAPTCHA bypass.

The agent requests a pending setup link with:

```text
Agent name: Atlas
Explanation: I need your help opening a website that requires a human browser
session so I can continue your task.
```

DomAgent generates the request and link. An anonymous request creates no tenant,
usable credential, or browser authority. Use existing request limits plus a
15-minute expiry; do not add an invitation-delivery system or notification queue.

The user opens the link, signs in, and sees:

> Atlas wants to connect to your browser.
>
> I need your help opening a website that requires a human browser session so I
> can continue your task.
>
> You're signed in as Denis on domagent.adsoconsulting.org.
> This name and explanation were supplied by the application.
>
> Atlas can ask you to share a tab. You decide each time.

Buttons: **Set up connection** and **Not now**.

Explicit approval creates one tenant, its owner membership, and one initial
MCP client. Names and explanations are bounded plain text, not verified identities
or executable content. Use limits of 80 and 500 characters; do not include
credentials, page contents, scripts, or chat transcripts.

### B. Application configuration remains an operator task

The server shows the client credential once in a separate **Application
connection settings** section. It provides a generic MCP endpoint and credential,
not instructions for a particular application or credential manager.

The operator follows the calling application's external skill to store the
credential and configure MCP. The agent can check setup status and obtain the
public connection link, but never retrieve the durable credential. Losing the
once-shown credential requires authorized rotation.

The operator and browser user may be different people. Browser setup must not
require the user to understand or perform application credential configuration.

### C. Install, paste one link, sign in

The agent or operator supplies browser-specific installation instructions and:

```text
https://domagent.adsoconsulting.org/join/<tenant-id>
```

This is a public connection link, not the secret setup-approval link.
The server's success page provides **Copy connection link** and extension
downloads. Visiting the public link shows a simple installation/help page.

After installation, the extension automatically opens:

> Connect your browser
>
> **Connection link**
> Paste the link your assistant or administrator gave you.
>
> **Continue**

The extension derives the server and tenant internally. No separate domain,
tenant-ID, credential, or fingerprint fields appear in the wizard.

Continue requests permission to contact that server, starts tenant-bound signed
enrollment, and opens the server's focused browser-approval page. Reuse an
existing sign-in session rather than forcing another login.

The server page asks:

> Connect this browser to Atlas?
> You're signed in as Denis.
> Atlas will be able to ask you to share a tab. You decide each time.

Buttons: **Connect browser** and **Not now**.

The approving account must be an authorized member of that tenant. A public link
does not invite the account or grant access.

### D. Finish automatically

The extension detects server approval, validates the transaction, submits its
private-key proof, and establishes authenticated WSS automatically. There is no
second **Confirm and connect** action.

This deliberately relaxes the earlier requirement for final extension-local
enrollment confirmation. The user approves once on the server, for the exact
tenant and device key the extension registered. Page messages or success redirects
are still not proof of approval; the extension checks the bound server transaction.

Show success only after the handshake succeeds:

> You're connected to Atlas.
> No tabs are being shared.
>
> **Done**

Pairing makes the tenant's initial client eligible to request access. It does not
create a control grant, open an automation tab, or request broad website access.

### E. Daily use

Use familiar names and simple states:

| Situation | Wording / action |
| --- | --- |
| Setup unfinished | "Finish connecting your browser" / Finish setup |
| Connected | "Connected to Atlas. No tabs are being shared." |
| Request waiting | "Atlas would like to use a tab." / Review request |
| Sharing | "Atlas can use the shared tab." / Stop sharing |
| Disconnected | "Connection lost. No tabs are being shared." / Try again |

Show the website as secondary text to distinguish connections with the same name.
Provide a simple saved-connection list with **Switch connection**, **Disconnect**,
and **Settings**. Only one connection is active. Switching ends old grants and
queued work before connecting the selected identity; it never resumes sharing.

Sharing review explains that the separate tab uses existing website sign-ins and
may expose private information. Buttons: **Share a tab** and **Not now**.
Use friendly descriptions for optional abilities, such as **Run page scripts**,
unchecked by default. Keep unsupported operations unavailable.

Keep normal screens free of OIDC, WSS, MCP, tenant, enrollment, grant, target,
client IDs, fingerprints, and raw error codes. Retain detailed diagnostics only
where the existing settings make them useful; do not build a diagnostics product.

## 3. Visible sharing, without a new security subsystem

Add a high-contrast border around the shared webpage and a small persistent banner:

> Atlas can use this tab. **Stop sharing**

Reinforce it with the extension toolbar's sharing badge/title. A whole-window
border is neither reliably supported across Chrome/Firefox nor accurate when
other tabs are not shared. Do not rely on color alone.

The banner should be keyboard accessible and avoid obscuring site controls.
Exclude its controls from page extraction/actions. Reinstall it after navigation
and remove or update it on stop, handoff, and disconnect. `clear_overlays` must
not remove the active sharing indicator.

Use a narrowly scoped stop-only action from the shared tab/document. It may
invalidate its own local grant immediately, never approve/resume sharing, change
settings, or stop another client's tab. The popup also provides **Stop sharing**.

Treat page decoration as best-effort UX, not an unspoofable security boundary.
Websites can imitate or hide DOM decorations; do not build tamper monitoring or
end otherwise usable sharing solely because a cosmetic indicator cannot render.
Report indicator failures and keep independent toolbar status accurate. Required
document-inspection failures still end control as in beta.2.

## 4. Minimal service contract

| Surface | Path |
| --- | --- |
| Public compatibility metadata | `/.well-known/domagent` |
| Create pending agent setup request | `POST /api/setup-requests` |
| Approve pending setup | `/connect/<request-id>#token=<setup-token>` |
| Public browser connection link | `/join/<tenant-id>` |
| Focused browser approval | `/pair/<tenant-id>?enrollment=<public-id>` |
| MCP endpoint | `/mcp/<tenant-id>` |
| Browser WSS | `/extension/<tenant-id>` |
| Tenant chooser / settings | `/dashboard`, `/dashboard/tenants/<tenant-id>` |

Generate tenant IDs with at least 128 random bits. IDs are public routing values,
not credentials. Do not use or store application-specific internal group IDs.
The extension accepts the canonical HTTPS connection-link format; reject secret
approval links, credentials, malformed paths, and cross-origin redirects with
helpful messages.

Setup creation returns a request ID, verification URL, expiry, and a separate
status receipt. These are small fields in the existing store, not another service.
The receipt returns only request state and the public connection link after
approval. The link token correlates one approval; it cannot authenticate MCP or
retrieve a credential.

Store token hashes and use random 256-bit tokens. Put the approval token in the
fragment, transfer it with a small same-origin script to provisional server flow
state, then remove it from history. GET previews do not approve or consume it.
Preserve flow through existing OIDC cookies and fixed server-side destinations.
No token-bearing IdP redirects, third-party page resources, or raw request-body
logs. Concurrent approvals create at most one tenant.

An eligible authenticated account can approve a forwarded setup link; for this MVP,
trust the account review and expected request rather than requiring another
identity-checking ceremony. The model/chat may see the expiring setup link, but
must never see the durable MCP credential.

Add tenants and owner/member relationships, tenant columns on existing clients,
devices/enrollments, and setup-request state. Use transactional migrations and
composite constraints to reject cross-tenant links. Preserve the initial client's
explicit pairing eligibility without a separate manual link step.

Every MCP request authenticates afresh and matches the credential's tenant to
the endpoint. Bind tenant and origin in protocol-v2 enrollment, WSS proofs, grants,
commands, and results. Use independent device keys per `(origin, tenant)` and
scope live registries and saved connections accordingly.

Retain existing TLS, CSRF/session checks, protected-origin blocking, revocation,
explicit targets, queue/deadline handling, and local sharing approval. Protect
the entire DomAgent origin and configured control-plane origins, not just one
tenant path. Tenant removal/revocation must not disrupt unrelated tenants.

These are essential boundaries, not optional hardening. Relax repeated setup
confirmations and cosmetic requirements, not cross-tenant authorization or
permission to use the browser.

## 5. Small recovery model

Save enough setup progress to resume, with bounded polling and an expiry:

- Closed sign-in tab: **Open sign-in again** for the current request.
- Expired request: **Start again**, preserving the connection link.
- Wrong/inaccessible link: explain, let the user edit it.
- Access denied: "You don't have access to this connection. Ask its owner."
- Permission declined: preserve inputs and allow another explicit attempt.
- Already paired but offline: retry the connection, not enrollment.
- Update/restart: retain identities; never restore control grants.

Do not add background invitation delivery, automatic tenant recreation, or an
elaborate retry engine. Do not report Connected until the connection is real.

## 6. Implementation plan

### 1. Tenant foundation and scoped endpoints

Extend [store.js](../domagent-mcp/store.js), [app.js](../domagent-mcp/app.js),
[server.js](../domagent-mcp/server.js), and [shared/protocol.js](../shared/protocol.js).
Add tenant ownership/membership, scoped clients/devices/enrollments, protocol v2,
and isolated MCP/WSS paths. Reuse existing authentication, errors, and lifecycle
helpers. Write two-tenant negative tests alongside the changes.

Provide one explicit migration command with reviewed client assignments and a
consistent backup. Preserve owner/client identity and revocation state where
assigned; require fresh tenant-bound browser pairing. No default-tenant fallback
or parallel legacy endpoint.

### 2. Pending setup and focused approval pages

Add setup-request state, bounded name/explanation fields, public metadata, and
focused server pages. Reuse existing OIDC/session/CSRF handling. Approval creates
one tenant/client atomically and shows the credential once to the operator.
Return only public setup progress to the agent.

### 3. Extension connection model and wizard

Extend [keys.js](../domagent-extension/src/keys.js) and
[controller.js](../domagent-extension/src/controller.js) for per-tenant identities
and a simple saved-pair list. Update [background.js](../domagent-extension/src/background.js)
and [the UI](../domagent-extension/ui/) to open setup on installation, parse one
connection link, open sign-in, poll approval, and connect automatically.
Keep local sharing approval independent of this automatic enrollment completion.

### 4. Daily-use UI and visible sharing

Simplify the popup and sharing review, add the border/banner and stop-only action,
and wire navigation/teardown to its lifecycle. Reuse existing grant/pause machinery.
Test switching, revocation, stop, navigation, and accurate toolbar states. Do not
add a native-window manager, tamper detector, or general webpage messaging API.

### 5. Integration, acceptance, release, cutover

Publish generic DomAgent documentation. Relocate application-specific instructions
currently under `integration/skills/` to the calling application's repository;
its skill handles existing MCP detection and manual credential configuration.

Keep the existing 70 unit tests and browser regressions. Add coverage for:

- Anonymous setup, first-user registration and authenticated approval, expiry/replay,
  disabled-account rejection, and no credential exposure.
- Tenant A credentials/proofs/targets being rejected by tenant B.
- Fresh-install one-link setup and automatic completion after server approval.
- No sharing or broad site permissions during onboarding.
- Multiple saved connections with no grant restoration on switch/restart.
- Named sharing indicator, accessible stop-only controls, and accurate status.

Exercise the real Chrome and native Firefox flows with the actual server.
Physical permission/notification prompts remain manual acceptance checks;
headless pre-granted fixtures do not prove their UX. Preserve explicit Firefox
capability limitations rather than adding unsafe fallbacks.

Release matching server/extension versions with both compiled ZIPs and checksums.
Use the selected coordinated cutover: stop and back up the live service, apply
reviewed tenant assignments, update client endpoints/credentials outside DomAgent,
restart and verify health, then install extensions and re-pair browsers.
Rollback restores the matching code and database backup, never old code against
a migrated schema.

Validation: 84 unit tests pass; the default Chrome/native Firefox suite passes
three tests with one known Juggler harness case explicitly skipped. Physical
browser permission/notification prompts remain manual acceptance gates.

**Done means:** the install-to-connected journey and tenant isolation pass,
the release ZIPs are verified, and the deployed service works. Broader roles,
client management, diagnostics, automated client provisioning, or extra security
ceremonies are not prerequisites for this MVP.
