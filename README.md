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

**1.0.0-beta.3** (service and extension), browser wire **v6**, DB schema **6**.
BananaBrowse restarts versioning at 1.0.0; the last DomAgent release was
6.1.0-beta.6. It accepts no DomAgent extension: install BananaBrowse,
re-register browsers and re-pair agents. See [the upgrade notes](docs/V6-UPGRADE.md)
and [architecture](docs/ARCHITECTURE.md).

Beta 3 validates complete browser inventories before publishing changes and
keeps sessions detached until their first valid sync. Beta 2 added `query_all`
structured extraction and clearer agent guidance. Existing BananaBrowse pairings
and sessions are preserved. Upgrade the server before extensions; beta 2
extensions continue to work with the beta 3 server.

Chrome **145+** and Firefox **153+**. Release ZIPs are unpacked Chrome
extensions and unsigned temporary Firefox add-ons.

## Using BananaBrowse

1. Click the BananaBrowse toolbar button. A BananaBrowse window opens (one at a time).
2. **First run:** enter your server's domain and a name for this browser, such as
   “Bob's Firefox on Mac”, then click **Connect**.
3. **Pair an agent:** click **Pair an agent** and tell your agent the 8-character
   code. The agent calls `pair_browser`; you click **Approve** in the window.
4. **Sessions:** when the agent needs the browser it calls `request_session` with
   a purpose and starting URLs. You get a system notification and a card in the
   window. **Approve** creates a colored tab group in your last-used window
   without stealing focus.
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

## Agent setup

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
`report_progress`, `request_handoff`, `list_artifacts`, `read_artifact`,
and page operations (`get_page_snapshot`, `get_text`,
`get_interactive_elements`, `inspect_element`, `query_all`, `click`, `type_text`,
`select_option`, `set_checked`, `press_key`, `scroll`, `navigate`,
`wait_for_page`, `evaluate_script`, `get_screenshot`, `clear_overlays`).

Page operations take a server-issued `tab_id` (such as `t12`) and a 40–500
character `description` that the user sees in the activity feed. Output limits,
DOM-only input, script worlds (`MAIN`/`USER_SCRIPT`), protected origins and
"never replay an uncertain mutation" (`OUTCOME_UNKNOWN`) carry over from v5.
Check `list_sessions` first and reuse an appropriate attached session:
`request_session` always requests a new group. `BROWSER_OFFLINE` means no live
connection, not necessarily a closed window; it can also mean connection loss.
Check sessions before retrying a failed request to avoid duplicate groups.

Start with `get_page_snapshot`. Use `inspect_element` to probe a selector without
scrolling, focusing or mutating; it reports missing, unique or ambiguous matches.
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
  operator-configured agent name. Every session needs another local approval.
- Agents only ever see their own browsers, sessions and tabs. Unknown and
  foreign IDs both return `NOT_FOUND`.
- Tabs at protected origins (the BananaBrowse server plus `BANANABROWSE_PROTECTED_ORIGINS`)
  are never shared, and navigation to them is blocked.
- Closing the window disconnects, then detaches the debugger and removes
  protection rules.

Scripts run with your logins and can read page data or act on your accounts.
Ending a session can't undo requests that already happened.
