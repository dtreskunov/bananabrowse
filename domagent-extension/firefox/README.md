# Firefox grouped workspace extension5.0.0

Build `node scripts/build-extensions.mjs`; load `dist/firefox/manifest.json` as
a temporary add-on. Unsigned temporary installs disappear on restart. Do not
disable production signing checks. Minimum **Firefox146**, the qualified native
engine; group APIs appeared earlier but those releases are not claimed qualified.

Persistent MV2 background authenticates the device while idle. Enter only the
service domain, tell the already-authenticated agent the short pairing code and
confirm **Connect and start workspace**. No browser-user account/login.
General website permission is requested only during the explicit start gesture.

Native group membership is consent while the workspace is active and our
window's sidebar is open. The sidebar can open automatically on install; that
does not activate control. Native isOpen plus our panel port/fresh heartbeat are
required. Close/Pause/End leaves all tabs intact and cancels unstarted work.
Background execution does not follow or inspect unrelated selected tabs.

Drag/menu Add grants scope to existing tabs; Remove revokes. Site-created/inherited
popups are excluded until explicitly added. The agent can create bounded grouped
background tabs. Blank or refused documents retain navigation-only capability
where safe, not privileged injection. Protected management origins remain denied.
Page scripts run MAIN only and may fail CSP; screenshot support depends on
tabs.captureTab and is absent on tested146.0.1.

Global notifications use click-to-task rather than Chrome-only buttons. Delivery
can be suppressed by OS settings; it never confirms Done. No per-action prompts,
no webpage positive consent, no automatic POST replay.

Normal profile login state/opener relationships are reused. This is not a sandbox
or complete script-effect audit. Update in place after explicit schema migration;
preserve key storage and existing credentials. See [migration](../../docs/V5-MIGRATION.md)
and [tests](../test/README.md).
