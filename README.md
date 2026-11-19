# BananaBrowse

Let your AI agent work in your real browser, inside tab groups you approve.

BananaBrowse was called DomAgent until 6.2. It started as a fork of
[vaishnavucv/domagent](https://github.com/vaishnavucv/domagent).

BananaBrowse is a self-hosted MCP server plus a Chrome/Firefox extension. The
extension runs in a small app window: while that window is open, paired agents
can ask to open a **session**, which is a native tab group in your browser.
You approve each session, and every tab in that group is in scope, so you can
drag tabs in or out to change what the agent can touch. Close the group, or the
window, and the agent stops.

Sessions reuse your normal logins and cookies. This is **not** an isolated
browser profile.

## Version

**1.0.0-beta.6** (service and extension), browser wire **v6**, DB schema **6**.
BananaBrowse restarts versioning at 1.0.0; the last DomAgent release was
6.1.0-beta.6. It accepts no DomAgent extension: install BananaBrowse,
re-register browsers and re-pair agents. See [the upgrade notes](docs/V6-UPGRADE.md)
and [architecture](docs/ARCHITECTURE.md).

Beta 4 adds user-approved completion cleanup, one-hour idle group collapse,
task-owned sessions and OAuth improvements. It retains beta 3's full inventory
validation and session readiness fixes. Upgrade the server before extensions,
then rediscover MCP tools/instructions. Browser registrations and pairings are
preserved; existing tokenless sessions must be ended and replaced with fresh
task-owned sessions. See [the upgrade notes](docs/V6-UPGRADE.md#task-owned-sessions).

Chrome **145+** and Firefox **153+**. Release ZIPs are unpacked Chrome
extensions and unsigned temporary Firefox add-ons.

## Using BananaBrowse

1. Click the BananaBrowse toolbar button. A BananaBrowse window opens (one at a time).
2. **First run:** enter your server's domain and a name for this browser, such as
   “Bob's Firefox on Mac”, then click **Connect**.
3. **Pair an agent:** click **Pair an agent** and tell your agent the 8-character
   code. The agent calls `pair_browser`; you click **Approve** in the window.
4. **Sessions:** each task gets its own tab group. When the agent needs the browser
   it calls `request_session` with a task-specific request key, purpose and starting URLs.
   You get a system notification and a card in the
   window. **Approve** creates a colored tab group in your last-used window
   without stealing focus. **Close tabs created for this session when the agent
   finishes** is checked by default. Uncheck it to keep those tabs; user-added,
   pinned and moved-out tabs are always kept by completion cleanup.
5. **Work together:** the agent works in the group's tabs in the background.
   Progress and requests for help (logins, CAPTCHAs) appear in the window; help
   requests also flash the tab group and show a notification. Click **Done** when
   finished.
6. **Stop:** close or ungroup the tab group to end that session (tabs stay open),
   or close the BananaBrowse window to disconnect everything. The window asks first.
   Reopening it reconnects live sessions automatically.

| You do | Effect |
| --- | --- |
| Drag a tab into a session group, or right-click → *Add tab to BananaBrowse session* | The agent can use it |
| Drag a tab out, or right-click → *Remove tab from BananaBrowse session* | The agent loses it |
| Close or ungroup the group | Session ends; tabs stay open |
| Close the BananaBrowse window | Agents see the browser as offline; sessions resume when you reopen it |
| Settings → Unpair | That agent's sessions end and it can no longer ask |

The window stays quiet while connected. It shows each agent with a one-word
status (Needs you, Working, n sessions, Idle) and only mentions the connection
when something is wrong. The window title shows `BananaBrowse (n)` when n items are
waiting and `BananaBrowse: offline` when disconnected. Settings (the gear) holds
the browser name, the server, paired agents, **Open BananaBrowse when the browser
starts** (off by default), Firefox page-script permission and **Forget this
browser**.

Each agent gets a stable group color. Sessions survive window closes and
browser restarts for up to 7 days while their group exists. After a Chrome
restart, the window asks you to confirm which group belongs to a session,
because Chrome changes group IDs on restart. Firefox reattaches automatically.
After one hour without agent commands or progress, an otherwise idle session
is marked **Stale** in the window and its native group collapses once. Collapse
waits while you are viewing the group; running work and pending approvals/help
defer staleness. Reopening the group does not make it collapse repeatedly.
New agent activity clears staleness. Idle cleanup never closes tabs.

## Agent setup

Agents can use an operator-issued API key or, when enabled, OAuth with dynamic
client registration (DCR). Both use the same local pairing and session approvals.

### OAuth with DCR

The operator sets `BANANABROWSE_OAUTH_ENABLED=true` and restarts the service.
Configure an OAuth-capable MCP client with **`https://<server>/mcp`**, without an
API key or pre-registered client credentials. The client discovers the server,
registers itself and opens a BananaBrowse authorization page:

1. Open the BananaBrowse extension window and click **Pair an agent**.
2. Enter its code on the authorization page and click **Connect**.
3. Return to the extension and **Approve** the OAuth client's request.

Client names and websites are self-reported, so approve only a connection you
started. Registration alone grants no browser access. Each session still needs
your approval.

**One OAuth identity can use multiple browser registrations.** After connecting,
give the agent a pairing code from another browser and approve its `pair_browser`
request there. It keeps the same identity and can open separate sessions in both.
Unpairing one browser leaves the others connected; removing the last pairing
revokes the identity's OAuth tokens. Reauthorizing the same registered client
through an already-paired browser reuses that identity, with another approval.
Unrelated users of a shared client registration do not automatically share an
identity or browser access.

See [OAuth configuration and token lifecycle](bananabrowse-mcp/README.md#oauth-with-dynamic-client-registration).

### API keys

Agents authenticate with an API key at `https://<server>/mcp/<agent-id>`. The
operator generates the key and adds one line to the service environment:

```sh
node bananabrowse-mcp/dist/bananabrowse-mcp/admin.js agent-key atlas "Atlas" https://atlas.example
# prints the key once, plus:
# BANANABROWSE_AGENT_ATLAS="Atlas|https://atlas.example/|sha256:<hex>"
```

Restart the service after changing agents. Configure the agent's MCP client
with an HTTP transport, the URL above and `Authorization: Bearer <key>`. Allow
long tool calls (about 600 s) because pairing, session approval and help requests
wait for a person.

## MCP tools

Tools include `pair_browser`, `list_browsers`, `unpair_browser`, `request_session`,
`list_sessions`, `end_session`, `list_tabs`, `create_tab`, `close_tab`,
`report_progress`, `request_handoff`, `list_artifacts`, `read_artifact`, `fill_form`,
and page operations (`get_page_snapshot`, `get_text`,
`get_interactive_elements`, `inspect_element`, `inspect_form`, `find_elements`, `query_all`, `click`, `type_text`,
`select_option`, `set_checked`, `press_key`, `scroll`, `navigate`,
`wait_for_page`, `evaluate_script`, `get_screenshot`, `clear_overlays`).

Page operations take a server-issued `tab_id` (such as `t12`) and a brief,
nonblank `description` (up to 500 characters) shown in the activity feed. Output limits,
DOM-only input, script worlds (`MAIN`/`USER_SCRIPT`), protected origins and
"never replay an uncertain mutation" (`OUTCOME_UNKNOWN`) carry over from v5.
Use **one group per task**. Generate a fresh random UUID `request_key` before
`request_session` and keep it with the original request arguments. The approved
request returns a private `session_token`; supply it with every session or tab
operation, including `end_session` when the task finishes. Ending a session
honors your cleanup choice from session approval, closing eligible tabs created
for it without another prompt and ungrouping the rest. The choice survives
reconnects; old sessions without recorded consent keep their tabs. After a
Chrome browser restart, restored tabs are kept because URL-based reattachment
cannot prove which tabs were created for the session; newly created tabs can
still be cleaned up. Firefox preserves tab provenance across restarts.
`close_tabs: false` keeps all tabs; `close_tabs: true` requests fresh approval
to close all tracked tabs. Completion cleanup needs extension 0.9.0.4+ and a
live session; disconnects, expiry and unpairing never trigger it.
`list_sessions` returns metadata, never credentials, and does not authorize
using another task's group.

Retry an uncertain session request with the **same key and original arguments**:
it recovers the committed session and token without another group or approval,
even while offline. `BROWSER_OFFLINE` means no live connection, not necessarily
a closed window; it can also mean connection loss. Keep the key and token
private in the task context, including across context compaction. If both are
lost, ask the user to end the orphaned group and approve a fresh one.
Existing sessions created before task tokens were introduced remain visible
but cannot be used by agents; see [the upgrade notes](docs/V6-UPGRADE.md#task-owned-sessions).

Start with `get_page_snapshot`. Use `inspect_element` to probe a selector without
scrolling, focusing or mutating; it reports missing, unique or ambiguous matches.
Use `find_elements` for exact text, form label, role or CSS lookup, including
nonsemantic controls. Discovery and inspection return actionable refs; ambiguity
returns bounded candidates rather than forcing selector guesses. A fresh snapshot
invalidates earlier refs; discovery/inspection preserve them.
`inspect_form` reports constraints, select options, linked autocomplete suggestions,
and native HTML validity separately from application errors; neither proves site
acceptance. `find_elements.within` scopes repeated labels to an inspected container.
`fill_form` fills up to 20 text/select/checkbox/radio fields sequentially, stops on
the first failure without retry or rollback, and optionally returns a final
snapshot. It never submits or presses Enter; checks use ordinary control activation.
Presence/validation state is returned without field values;
known formatting can be checked with `type_text.expected_value`. See
[form tools](bananabrowse-mcp/README.md#discovery-and-form-tools).
Action receipts confirm dispatch, not application success: verify the resulting
page. Check `list_tabs` capabilities before screenshots (Firefox environments
without `tabs.captureTab` cannot capture them). Use
`query_all` for structured DOM data with known row/field selectors, or
`evaluate_script` for data absent from the DOM. Both support
`return_as: "artifact"` for bulk data instead of copying
large results through the conversation. `max_output_bytes` limits serialized
output; `max_text_chars` applies only to text-extraction tools (per field for
`query_all`). See [the extraction contract](bananabrowse-mcp/README.md#structured-extraction).

## Self-hosting

Node 22.13+. See [service configuration and CLI](bananabrowse-mcp/README.md) and
[deployment examples](deployment/).

```sh
npm --prefix bananabrowse-mcp ci --ignore-scripts
npm --prefix bananabrowse-extension ci --ignore-scripts
npm --prefix bananabrowse-extension/ui ci --ignore-scripts
npm --prefix bananabrowse-mcp test           # server, extension and UI unit tests
npm --prefix bananabrowse-mcp run build      # dist/chrome and dist/firefox
npm --prefix bananabrowse-mcp run check      # JavaScript syntax
```

Real-browser tests can run with Podman using
`mcr.microsoft.com/playwright:v1.58.2-noble`, which includes Chromium and Firefox;
no host browser installation is needed for page-helper tests or Chrome extension
tests. See [the test README](bananabrowse-extension/test/README.md) for commands
and the separate native Firefox extension requirement.

## Security model in brief

- A browser registers itself with a non-extractable P-256 key. A rotating,
  key-bound refresh token yields 10-minute access tokens for the WebSocket.
  Registration alone grants nothing.
- Pairing requires a code shown in the browser plus a local **Approve** of the
  agent. API-key agent names are operator-configured; OAuth client names and
  websites are self-reported and marked accordingly. Every session needs another
  local approval.
- Agents only ever see their own browsers, sessions and tabs. Unknown and
  foreign IDs both return `NOT_FOUND`.
- Tabs at protected origins (the BananaBrowse server plus `BANANABROWSE_PROTECTED_ORIGINS`)
  are never shared, and navigation to them is blocked.
- Closing the window disconnects, then detaches the debugger and removes
  protection rules.

Scripts run with your logins and can read page data or act on your accounts.
Ending a session can't undo requests that already happened.
