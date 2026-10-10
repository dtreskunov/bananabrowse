---
name: domagent
description: Guide a browser owner through independent DomAgent enrollment and per-agent-group approval, then use authorized browser targets through HTTP MCP. Never handle raw credentials.
---

# DomAgent real-browser access

DomAgent is a separate, independently authorized service. Browser control is
optional. Your MCP identity belongs to the whole agent group, not just this chat.
You cannot approve enrollment, activate browser control, or remotely resume it.

## Guide the operator through setup

1. Check whether your group has an HTTP MCP server named `domagent`, using the
   existing permitted `ncl groups config` workflow. Agent-initiated changes
   require the normal administrator approval.
2. Ask the operator to open the known DomAgent HTTPS dashboard directly, sign
   in with its external identity provider, and create a client identity for this
   specific agent group. Do not claim BananaClaw login authorizes DomAgent.
3. The operator imports the once-shown client credential directly into OneCLI
   and grants it only to this group's OneCLI identity. **Never ask for, receive,
   echo, or store the credential in chat or configuration.**
4. Configure the group using existing HTTP MCP settings with the HTTPS `/mcp`
   endpoint and only the gateway-recognized placeholder established by the
   operator. Use the group's MCP settings editor with transport `http`; the
   current `ncl groups config add-mcp-server` command supports stdio entries
   only. Do not invent a sentinel or put a real bearer token in headers.
5. Require verification that this provider's actual HTTP transport uses OneCLI,
   injects the correct group credential, and refuses direct/plaintext fallback.
   Proxy environment variables alone do not prove this. Stop on failed checks.
6. Ask the browser owner to install the independently distributed extension,
   enter the known service origin, and start enrollment locally. The extension
   opens DomAgent's own dashboard. The owner checks the reference/key, signs in,
   approves there, then returns to the extension for final local confirmation.
7. The owner links the client to that device in DomAgent. Linking permits a
   request only. Ask the owner to review and approve the dedicated automation
   tab in the extension; never attempt to click the approval UI yourself.

Keep the configured DomAgent/IdP/BananaClaw control-plane origins protected.
Do not suggest raw debugging ports, credential extraction, insecure WS/HTTP,
disabling TLS verification, or weakening extension permissions.

## Use targets safely

- `list_browser_targets` returns only your eligible devices and control state.
  Ask which device to use if there are several. Every browser operation needs
  an explicit active `target_id`.
- `request_browser_access` returns immediately with pending state. Explain the
  required local approval, then poll status sparingly. Do not repeatedly trigger
  requests, enumerate unrelated devices, or substitute another client's target.
- Chrome and Firefox may advertise different capabilities. Use only advertised
  operations. An unsupported operation is not permission to use raw CDP,
  privileged Firefox evaluation, or a screenshot of another tab.
- Use `request_handoff` when authentication, CAPTCHA, file picking, browser
  permissions, or other human interaction is needed. The owner must approve
  resuming control locally afterward.
- `HANDOFF_REQUIRED`, `CAPABILITY_UNAVAILABLE`, `NOT_AUTHORIZED`,
  `BROWSER_OFFLINE`, and stale targets are explicit limitations, not success.
- Do not automatically retry a mutating operation after timeout or a lost reply.
  `OUTCOME_UNKNOWN` means the action may already have happened.

## Explain the grant honestly

The tab shares the user's website login sessions. Page content, ordinary
JavaScript-readable cookies/storage, and DOM-visible secrets may be returned
to you and retained in BananaClaw conversation history. Internal-network sites
reachable by that browser are also reachable within the disclosed grant.

Raw browser cookie/profile extraction, extension credentials, and unowned tab
adoption are not supported. Login/CAPTCHA detection is best effort, not a
universal secret filter. Authenticate before granting control when possible.

Disconnect, browser/service/worker restart, pause, and revocation end control.
Reconnection restores device identity only and requires fresh local approval.
Pause leaves the page open and stops new agent commands; it cannot undo earlier
requests, account changes, or JavaScript already scheduled by previous actions.
