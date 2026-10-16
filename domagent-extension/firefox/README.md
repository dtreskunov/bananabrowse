# DomAgent for Firefox (6.1.3)

Build with `npm --prefix domagent-mcp run build` and load
`dist/firefox/manifest.json` from `about:debugging` as a temporary add-on.
Unsigned temporary installs are removed on restart; never disable production
signature checks. Minimum Firefox **153** (Manifest V3, tab groups, `userScripts`).

The toolbar button opens the DomAgent window. Enter your server domain and a
browser name, pair agents and approve sessions there. Closing the window asks
first and disconnects.

- Every tab in an approved session's tab group is in scope. Use drag and drop or
  the tab context menu (*Add tab to DomAgent session* / *Remove…*).
- DomAgent tags session tabs with `sessions.setTabValue`, so after a browser
  restart sessions reattach automatically with the same tab IDs. Lazily restored
  tabs, and tabs that last showed a POST result, come back navigation-only.
- Page scripts need the optional `userScripts` permission: **Settings → Page
  scripts → Enable**. Firefox notifications have no buttons; decisions happen in
  the window.

See [tests](../test/README.md) and [architecture](../../docs/ARCHITECTURE.md).
