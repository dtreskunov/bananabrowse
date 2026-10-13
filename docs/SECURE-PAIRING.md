# v5 client-scoped pairing and security

Trust the independent service/TLS proxy, extension package/update channel and
browser. MCP callers and webpages do not gain operator rights. Grouped browser
sessions reuse normal account state and are not a sandbox.

## Pairing and identities

Browser setup requires the service domain only. A nonextractable P-256 key signs
an expiring eight-character code invitation plus private32-byte receipt.
Authenticated `adopt_browser` chooses its own client namespace from its credential.
The extension confirms one exact proposal locally, then signs the service/client/
request/key/nonce transcript. No short-code enumeration or private status by code.
Codes use keyed domain-separated HMAC; receipts are hashed; collisions explicit.
Creation, proposals, guessing, status and global socket/pending state are bounded.

Browsers can omit HTTP Origin on extension GET fetches. The pairing endpoint accepts
the explicit extension-origin header only when Origin is absent; a present foreign
Origin cannot be overridden. Neither header is a source attestation: authorization
requires key proofs, private receipt, authenticated claimant and local confirmation.
WSS requires the actual extension Origin and device challenge/proof.

Every HTTP MCP request authenticates its namespace endpoint. Device/client
association is an explicit DB binding, independent of OIDC accounts. Revocation/
rotation invalidates pending proposals and runtime authority; revoked identities
are never rescued by fresh pairing.

## Workspace authority

Signed v5 snapshots bind group/window/client/device/connection, fresh activation,
monotonic revision, leased state and exact tab IDs/handles/capabilities.
Only actual group membership plus explicitly activated native panel grants scope.
Native group name/color is organization, not identity. No persisted active lease.
Pause/End/removal invalidates locally before asynchronous cleanup and on the server;
unstarted work is cancelled. Executing mutations may already have effects.

The native panel owns a private runtime port and a fresh heartbeat, plus browser
open-state evidence. Chrome requires onOpened/onClosed; Firefox uses isOpen for
the bound window. A settings page/tab cannot renew the panel lease. Lost native
state/heartbeat ends control at most five seconds later. Restored panels or
network reconnection do not silently reactivate work.

Background tabs may execute while the user views another tab/application.
Two concurrent ordinary tasks per workspace, one per tab; eight grouped targets.
Website-created/inherited tabs are excluded until explicitly added; creation
through the MCP tool is bound to its original activation and cancellation.

Network protection covers configured management origins, redirects/subresources.
Protected-navigation revocation retains enforcement through browser rejection,
not premature guard removal. Navigation-only blank/viewer tabs cannot receive
DOM authority. No activeTab trick, privileged renderer bypass, POST replay or
new site allowlist. Old page approval messages remain rejected.

## Operator secrets and deployment

`DOMAGENT_ORIGIN`, `DOMAGENT_DB`, bind/port and protected origins configure the
service. Default operator administration is local CLI. An optional remote dashboard
requires a random strong `DOMAGENT_OPERATOR_SECRET` or restricted0600 regular
secret file. With neither, administration routes are404, not anonymous.
Operator authentication is distinct from all client credentials/device proofs.
Secure HttpOnly SameSite sessions, exact Origin, CSRF and login rate limits apply.
Secret rotation invalidates sessions. Do not put secrets in URLs or logs.

Preserve former control-plane origins explicitly when removing OIDC.
Rate limits use actual socket peers, not untrusted forwarded headers; a proxy
shares conservative source budgets. Backend remains private behind TLS.
No public endpoint can provision a durable MCP credential.

Logs retain IDs, fixed event/failure codes and durations only. Never bodies,
codes/receipts, bearer credentials, source, values or browser exception contents.
Connected browser_info is bounded self-reporting, not package attestation.
Human notifications are generic; clicking/dismissing is not completion.

See [migration/rollback](V5-MIGRATION.md), [service configuration](../domagent-mcp/README.md)
and [qualification tests](../domagent-extension/test/README.md). Checksums are
asset integrity, not SLSA provenance. Firefox temporary ZIPs are not signed XPIs.
