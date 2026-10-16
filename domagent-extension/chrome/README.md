# DomAgent for Chrome (6.1.4)

Build with `npm --prefix domagent-mcp run build` and load `dist/chrome` with
**Load unpacked** (`chrome://extensions`, Developer mode). Minimum Chrome **145**.

The toolbar button opens the DomAgent window (a single popup-type window). Enter
your server domain and a browser name, then pair agents and approve sessions
there. Everything that controls tabs runs inside that window: closing it asks
for confirmation, disconnects from the server, detaches the debugger and removes
protection rules.

- Every tab in an approved session's tab group is in scope; drag tabs in or out,
  or use the page context menu (*Add tab to DomAgent session* / *Remove…*).
- `evaluate_script` in the `MAIN` world uses the debugger API ("DomAgent started
  debugging this browser" bar). `USER_SCRIPT` needs **Allow user scripts** in
  the extension's details page.
- After a browser restart Chrome assigns new group IDs, so the window asks you to
  confirm which group belongs to each session before it reconnects.

Website access (`http://*/*`, `https://*/*`) is requested the first time you
approve a session. See [tests](../test/README.md) and [architecture](../../docs/ARCHITECTURE.md).
