# DomAgent

Let your AI agent work in your real browser, inside tab groups you approve.

DomAgent is a self-hosted MCP server plus a Chrome/Firefox extension. The
extension runs in a small app window: while that window is open, paired agents
can ask to open a **session**, which is a native tab group in your browser.
You approve each session, and every tab in that group is in scope, so you can
drag tabs in or out to change what the agent can touch. Close the group, or the
window, and the agent stops.

Sessions reuse your normal logins and cookies. This is **not** an isolated
browser profile.

## Version

Service **6.1.0-beta.2**, extension **6.1.1**, browser wire **v6**, DB schema **6**.
v6 is a clean break from v5: use a new database, re-register browsers and
re-pair agents. See [the v6 upgrade notes](docs/V6-UPGRADE.md) and
[architecture](docs/ARCHITECTURE.md).

Chrome **145+** and Firefox **153+**. Release ZIPs are unpacked Chrome
extensions and unsigned temporary Firefox add-ons.

## Using DomAgent

1. Click the DomAgent toolbar button. A DomAgent window opens (one at a time).
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
   or close the DomAgent window to disconnect everything. The window asks first.
   Reopening it reconnects live sessions automatically.

| You do | Effect |
| --- | --- |
| Drag a tab into a session group, or right-click → *Add tab to DomAgent session* | The agent can use it |
| Drag a tab out, or right-click → *Remove tab from DomAgent session* | The agent loses it |
| Close or ungroup the group | Session ends; tabs stay open |
| Close the DomAgent window | Agents see the browser as offline; sessions resume when you reopen it |
| Settings → Unpair | That agent's sessions end and it can no longer ask |

The window stays quiet while connected. It shows each agent with a one-word
status (Needs you, Working, n sessions, Idle) and only mentions the connection
when something is wrong. The window title shows `DomAgent (n)` when n items are
waiting and `DomAgent: offline` when disconnected. Settings (the gear) holds
the browser name, the server, paired agents, **Open DomAgent when the browser
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
node domagent-mcp/admin.js agent-key atlas "Atlas" https://atlas.example
# prints the key once, plus:
# DOMAGENT_AGENT_ATLAS="Atlas|https://atlas.example/|sha256:<hex>"
```

Restart the service after changing agents. Configure the agent's MCP client
with an HTTP transport, the URL above and `Authorization: Bearer <key>`. Allow
long tool calls (about 600 s) because pairing, session approval and help requests
wait for a person.

## MCP tools

24 tools: `pair_browser`, `list_browsers`, `request_session`, `list_sessions`,
`end_session`, `list_tabs`, `create_tab`, `report_progress`,
`request_handoff`, and 15 page operations (`get_page_snapshot`, `get_text`,
`get_interactive_elements`, `inspect_element`, `click`, `type_text`,
`select_option`, `set_checked`, `press_key`, `scroll`, `navigate`,
`wait_for_page`, `evaluate_script`, `get_screenshot`, `clear_overlays`).

Page operations take a server-issued `tab_id` (such as `t12`) and a 40–500
character `description` that the user sees in the activity feed. Output limits,
DOM-only input, script worlds (`MAIN`/`USER_SCRIPT`), protected origins and
"never replay an uncertain mutation" (`OUTCOME_UNKNOWN`) carry over from v5.
`request_session` fails immediately with `BROWSER_OFFLINE` if the browser's window
is closed; pick another browser from `list_browsers`.

## Self-hosting

Node 22.13+. See [service configuration and CLI](domagent-mcp/README.md) and
[deployment examples](deployment/).

```sh
npm --prefix domagent-mcp ci --ignore-scripts
npm --prefix domagent-extension ci --ignore-scripts
npm --prefix domagent-extension/ui ci --ignore-scripts
npm --prefix domagent-mcp test           # server, extension and UI unit tests
npm --prefix domagent-mcp run build      # dist/chrome and dist/firefox
npm --prefix domagent-mcp run check      # JavaScript syntax
```

Real-browser tests run in the Playwright container; see
[the test README](domagent-extension/test/README.md).

## Security model in brief

- A browser registers itself with a non-extractable P-256 key. A rotating,
  key-bound refresh token yields 10-minute access tokens for the WebSocket.
  Registration alone grants nothing.
- Pairing requires a code shown in the browser plus a local **Approve** of the
  operator-configured agent name. Every session needs another local approval.
- Agents only ever see their own browsers, sessions and tabs. Unknown and
  foreign IDs both return `NOT_FOUND`.
- Tabs at protected origins (the DomAgent server plus `DOMAGENT_PROTECTED_ORIGINS`)
  are never shared, and navigation to them is blocked.
- Closing the window disconnects, then detaches the debugger and removes
  protection rules.

Scripts run with your logins and can read page data or act on your accounts.
Ending a session can't undo requests that already happened.
