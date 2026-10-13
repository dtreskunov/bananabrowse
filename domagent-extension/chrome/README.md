# Chrome grouped workspace extension5.0.0

Build with `node scripts/build-extensions.mjs`; load compiled `dist/chrome`
using Load unpacked. Minimum **Chrome145**, the qualified engine with native
panel open/closed events. Tab-strip menu context needs Chrome150; earlier
qualified engines use page-menu/sidebar Add fallback with an explicit warning.

Enter the service domain, pass the short code to the authenticated MCP agent,
and confirm **Connect and start workspace**. No browser-user OIDC account.
Service-only permission comes first; HTTP(S) website permission on start.
An active window-scoped native sidebar plus actual named group defines scope.
Background grouped tabs run without routine action prompts. New Tab starts
navigation-only. Closing/replacing the panel stops authority and leaves tabs open.
Panel page liveness alone does not grant permission; native events and bounded
heartbeat are both checked. Startup/restoration/reconnect never restores grants.

No webpage positive controls or raw CDP surface. Origin DNR rules protect redirects
and subresources. Pause cancels unstarted commands; uncertain mutations are not
retried. Site-created popups are excluded until explicitly added. Agent tab
creation is background-only and capped at eight tabs/two concurrent page tasks.

Global system notification announces human assistance; clicking takes the user
to the task, not Done. OS suppression remains possible; delivery failure explicit.
Normal logins/cookies/scripts are shared, not profile isolation. End cannot undo
sent requests, account actions or workers.

Update in place with matched wire5 service and preserve extension key storage.
See [qualification](../test/README.md) and [migration](../../docs/V5-MIGRATION.md).
