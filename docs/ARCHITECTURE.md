# DomAgent v6 architecture

Status: implemented in service 6.0.0-beta.3 / extension 6.0.2 (wire v6, DB
schema 6), 2026-10-14. Clean break from v5: no DB migration, browsers
re-register and agents re-pair.

## 1. Goals

- Replace the v5 consent state machine (Start/Continue/Pause/Resume/Ready/Starting)
  with native browser gestures: the extension window is the on/off switch, a tab
  group is a session, tab membership is tab-level consent.
- No sidebar or toolbar popup. The extension UI is a single app-like window.
- No user accounts. The server knows agents (operator-configured) and browsers
  (self-registered extension instances), and the pairings between them.

## 2. Components

| Component | Role |
| --- | --- |
| DomAgent server | MCP endpoint per agent, browser registration/token endpoint, WSS hub, SQLite store |
| Extension window | Single-instance popup window. Owns the WebSocket, controller, tab/group reconciliation and all UI |
| Extension background | Thin: toolbar click, tab context menu, notification click, optional open-at-startup. Focuses/opens the window |
| Agent | MCP client authenticated by API key at `/mcp/<agent-id>` |

The extension only works while its window is open. Everything that drives tabs
runs in the window document, so closing the window ends the connection by
construction and Chrome service-worker lifetime is irrelevant.

## 3. Identity and trust

**Agents** are configured in `.env`, one variable per agent:

```sh
DOMAGENT_AGENT_ATLAS="Atlas|https://atlas.example|sha256:<hex of API key>"
```

The agent ID (`atlas`, `[a-z0-9-]{1,32}`) is operator-chosen, human-readable,
and appears in the MCP path. Only key hashes are stored;
`admin.js agent-key <id> "<Name>" [homepage]` generates a key and prints the env
line. Removing an agent from `.env` revokes
its pairings and sessions.

**Browsers** self-register. Anyone who can reach the server can register a
browser (rate-limited); a registered browser has no authority until paired.
Unpaired registrations expire after 24 hours.

1. The user enters the server domain. The extension checks `/.well-known/domagent` and
   requests host permission for that origin only.
2. The extension generates a nonextractable P-256 key in IndexedDB and registers
   `{name, public_key}` with a key proof. The server returns `browser_id` and a
   long-lived refresh token.
3. The refresh token is rotating, revocable and sender-constrained. Each refresh
   is signed by the device key over a server nonce, so a stolen token alone is
   useless. Reuse of a rotated token revokes the browser.
4. Short-lived access tokens (10 min) authenticate the WebSocket. Browsers
   cannot set WebSocket headers, so the token travels in the first `hello` frame.
   Tokens are checked at connect; revocation closes live sockets.

One server per extension install. Changing the server domain wipes the identity
("Forget this browser" revokes it server-side first).

**Pairing (agent ↔ browser)** keeps today's direction:

1. In the window, the user clicks **Pair an agent**. The extension shows an
   8-character code (`K7MP-4QTX`, 40 bits, 5-minute expiry, single use).
2. The user gives the code to their agent, which calls `pair_browser({code})`.
3. The window shows the operator-configured agent name and homepage:
   "Atlas (atlas.example) wants to use Bob's Firefox on Mac". **Approve** /
   **Decline**.
4. The pairing persists until revoked in the window (Settings → Paired agents)
   or by the operator CLI.

The code is only an invitation; the local Approve is the trust decision. Codes
are stored as keyed hashes, never logged, and guessing is rate-limited per agent.

## 4. Data model

IDs are short, prefixed, never reused, server-global base-36 counters: `b7`
(browser), `s12` (session), `g12` (tab group), `t41` (tab). Agents use their
configured ID. IDs are not authority: every lookup is scoped to the calling
agent's pairings, and unknown or foreign IDs return the same `NOT_FOUND`.

| Entity | Fields | Notes |
| --- | --- | --- |
| `agent` | `id`, `name`, `url?` | From `.env` |
| `browser` | `id`, `name`, `public_key`, `last_seen` | `name` is user-editable in the window |
| `pairing` | `agent_id`, `browser_id`, `created_at` | Persistent until revoked |
| `agent_session` | `id`, `agent_id`, `browser_id`, `tab_group_id`, `purpose`, `expires_at` | 1:1 with a tab group |
| `tab_group` | `server_id`, `client_id`, `browser_id`, `agent_session_id`, `title` | `client_id` is browser-side only |
| `tab` | `id`, `tab_group_id`, `url`, `title` | Live metadata, not history |

The server stores no activity history. The activity feed lives in extension local
storage, capped at about 200 entries.

**Group identity across restarts.** Neither browser can attach metadata to a
TabGroup.

- **Firefox:** the extension writes `{group client_id, tab id}` to each member
  tab with `sessions.setTabValue`. The group and its tab IDs survive a browser
  restart.
- **Chrome:** there is no equivalent and group IDs change on restart. On reopen,
  the extension matches candidate groups by title, color and tab URLs, and the
  user confirms each match in the window. Confirmed tabs keep their IDs.
  Unconfirmed groups are reported dead.

## 5. Lifecycle

Session states (server): `requested → attached ⇄ detached → deleted`. Tab
execution: `idle | running | waiting_for_human`. That is the whole state machine.

| User or agent action | Effect |
| --- | --- |
| User opens the window (toolbar, or at startup if enabled) | Connect. The extension reports all known groups; live ones reattach immediately (opening the window is consent). Sessions whose group is gone are deleted |
| User closes the window | Generic browser "Leave site?" confirmation, then `bye` and close 1000. Sessions become `detached` and agent calls fail `BROWSER_OFFLINE` |
| Minimize or unfocus the window | No effect |
| Agent `request_session` | Fails immediately if the browser is offline. Otherwise: system notification, plus a request card in the window |
| User approves | Group created in the last-focused normal window without stealing focus; tabs open in the background, are protected, then navigate |
| User declines or ignores the request | `DECLINED` or `TIMEOUT` |
| A tab joins the group (user drag, context menu **Add to <group>**, or a website opening it from a grouped tab) | Tab granted with a fresh `t` ID |
| Tab dragged out or closed | Grant revoked; unstarted work cancelled |
| User ungroups or closes the group | Session ends and is deleted |
| User renames the group | Title synced; agent sees it |
| Agent `end_session` | Ungroups; tabs stay open |

**Retention.** `expires_at = last report + 7 days`. Every sync where the
extension reports the group alive extends it. If the group vanished while
disconnected, the next sync deletes the session. Expired sessions are deleted.

**Group membership is the boundary.** Every tab in the group is in scope,
however it got there: user drag, context menu, agent `create_tab`, or a website
opening a popup or new tab from a grouped tab. On reattach, all tabs currently
in the group are granted; tabs the extension doesn't recognise get fresh `t` IDs.
To take a tab out of scope, the user moves it out of the group.

## 6. Window UI

The window is a single-instance `type: "popup"` window with remembered size and
position. The toolbar button focuses it. It uses system fonts and colors, light
and dark themes, and is sparse.

A healthy connection is silent: there is no header. The window title is
`DomAgent`, `DomAgent (n)` when n items are waiting, or `DomAgent: offline`.

- **Connection strip:** only when not connected. "Connecting…" on first start;
  otherwise an amber strip, "Offline: can't reach <server>. Agents can't reach
  this browser.", with Retry.
- **Requests:** pairing proposals, session requests (agent, purpose, starting
  URLs with origins emphasized, Approve/Decline) and handoffs
  (instructions, Done/Cancel). Always on top of the list.
- **Agents:** one flat list, one row per paired agent with a status of
  **Needs you**, **Working**, **n sessions** or **Idle**. Attached sessions and
  their tabs nest under the agent; clicking a tab focuses it. The heading has
  "+ Pair" and the Settings gear. With no agents, a "Pair your first agent"
  card replaces the list.
- **Activity:** feed of `report_progress` messages and tool-call descriptions.
  The agent name is shown only when more than one agent is paired.
- **Settings:** this browser's name (rename), server, agents with Unpair and
  "+ Pair an agent", open at browser startup (off by default), Firefox page
  scripts, Forget this browser.

**Attention.** Each agent gets a stable group color, hashed from its ID over the
browser palette excluding grey. While a human action is pending in a group, the
group alternates between its color and grey, the toolbar badge shows the pending
count, and one system notification is shown. Clicking the notification focuses the
window and the target tab. Clicking or dismissing never means Done. Firefox
notifications have no buttons, so all decisions happen in the window.

## 7. MCP surface (`/mcp/<agent-id>`, API key in the Authorization header)

24 tools: the 9 below plus the 15 page operations.

| Tool | Contract |
| --- | --- |
| `pair_browser({code, timeout_seconds?})` | Bounded wait for local Approve; returns `browser_id`, `name` |
| `list_browsers()` | Paired browsers: `browser_id`, `name`, `online`, self-reported `browser_info` |
| `request_session({browser_id, purpose, urls?, title?, timeout_seconds?})` | Fails at once with `BROWSER_OFFLINE`; waits for Approve/Decline/timeout (default 300 s, max 600 s); returns the session and its tabs |
| `list_sessions()` | Caller's sessions: `session_id`, `browser_id`, `tab_group_id`, `title`, `purpose`, `state` (`attached`/`detached`), `expires_at` |
| `end_session({session_id})` | Ungroup; tabs remain |
| `list_tabs({session_id})` / `create_tab({session_id, url?, description})` | Grouped tabs only; 8-tab cap |
| `report_progress({session_id, message})` | Activity feed line; ≤500 characters |
| `request_handoff({tab_id, instructions, timeout_seconds?})` | Notification + flashing group + Done/Cancel; blocks only that tab |
| 15 page operations | `tab_id` plus a 40–500 character `description` shown in the feed; v5 semantics, limits and errors |

Errors: `NOT_FOUND` (unknown or foreign IDs), `BROWSER_OFFLINE`,
`SESSION_DETACHED` (Chrome reattach pending), `SESSION_ENDED`,
`TAB_NOT_IN_SESSION`, `ACTION_DECLINED`, `PAIRING_UNAVAILABLE`, plus the v5
page errors (`DOCUMENT_NOT_CONTROLLABLE`, `OUTCOME_UNKNOWN`, ...).

## 8. Browser wire protocol (v6, JSON over WSS)

The server sends a `ping` every 30 s and marks the browser offline, closing
the socket, after 90 s without a `pong`. The extension replies from its message
handler, not a timer, so timer throttling in a minimized window can't cause
false drops. It reconnects after 90 s without a `ping`. A graceful `bye` takes
effect immediately; only abrupt loss (sleep, network drop) waits for the
timeout. Proxy idle timeouts must exceed 30 s. The connection is authenticated
once by its access token and key proof; v5 per-message snapshot signatures are
dropped.

| Direction | Messages |
| --- | --- |
| Extension → server | `hello`, `proof`, `pong`, `sync`, `pairing.code`, `pairing.cancel`, `pairing.decision`, `pairing.revoke`, `session.decision`, `command.ready`, `result`, `browser.rename`, `browser.forget`, `bye` |
| Server → extension | `challenge`, `welcome`, `ping`, `sync.ack`, `agents`, `browser`, `pairing.code.ok`, `pairing.proposal`, `session.request`, `session.request.cancel`, `session.created`, `session.end`, `progress`, `command`, `command.execute`, `command.cancel`, `revoked`, `error` |

`sync` is the full inventory: one entry per group keyed by its `client_id`,
with state `attached` or `unconfirmed` and its tabs (`id` when known, the
browser tab ID as `key`, title, URL, page state, capabilities). `sync.ack`
returns new tab ID assignments and any `client_id`s the server doesn't know,
which the extension ungroups. A group approved but not yet committed carries its
`request_id`, so the server doesn't treat it as unknown. Tab ID assignment is
idempotent per browser tab, so a sync that races ahead of its acknowledgement
can't renumber tabs. Sessions missing from an inventory are deleted.

Commands keep v5's ready/execute handshake (handoffs are "ready" when the
user clicks Done), cancellation, and no-replay-after-uncertainty rules.

## 9. Retained safety rules

These carry over from v5, with one deliberate change: website-created tabs that
inherit group membership are no longer excluded (see section 5).

- Protected origins are enforced, now configured explicitly with
  `DOMAGENT_PROTECTED_ORIGINS` (replacing the v5 `DOMAGENT_OIDC_ISSUER` carry-over).
- Navigation-only handling for refused or browser-owned documents.
- 8 tabs and 2 concurrent executions per session; one command per tab.
- DOM-only input, script worlds, output caps, and redacted diagnostics.
- No focus stealing except on the user's click.

## 10. Extension point: network approval (not built)

A per-session policy hook `onRequest({session_id, tab_id, method, url, type}) →
allow | deny | ask`, default `allow`.

- **Observation:** `webNavigation` events on both browsers.
- **Blocking:** Firefox `webRequest` only. Chrome MV3 allows blocking only for
  policy-installed extensions, so Chrome would need the debugger `Fetch` domain
  (it shows the "being debugged" bar).

`ask` would reuse the handoff request card.

## 11. Removed from v5

- Sidebar, toolbar popup and the Start/Continue/Pause/Resume state machine.
- Per-window workspaces and the task-group selector.
- Viewport frame and the Diagnostics page.
- Operator dashboard and `DOMAGENT_OPERATOR_SECRET`.
- DB-provisioned clients, tenants and namespaces.
- Saved connections (multiple servers per install).
- `adopt_browser` and `wait_for_workspace`, replaced by `pair_browser` and
  `request_session`.
- Signed workspace snapshots.

## 12. Platform limits accepted

- Firefox restores session tabs lazily and never re-submits a POST. A
  reattached tab can therefore come back as a navigation-only `about:blank`
  with the same `tab_id`; the agent navigates it again.

- The popup window keeps a minimal title bar showing the extension, and cannot
  be always-on-top.
- The close confirmation is the browser's generic dialog, shown only after the
  user has interacted with the window. Quitting the browser may skip it; the
  server then sees a dropped socket and the session detaches the same way.
- Notification delivery cannot prove the user saw it (OS do-not-disturb).
- Firefox requires 139+ for tab groups; the current extension minimum (153)
  already satisfies this.
