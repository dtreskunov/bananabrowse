# Contributing to DOMAgent

Thank you for taking the time to contribute. This document covers how to report bugs, suggest features, and submit code changes.

---

## Table of Contents

- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Reporting Bugs](#reporting-bugs)
- [Suggesting Features](#suggesting-features)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Commit Message Guidelines](#commit-message-guidelines)
- [Code Style](#code-style)
- [Testing Your Changes](#testing-your-changes)

---

## Project Structure

```
domagent/
├── domagent-extension/
│   ├── src/            <- Shared secure extension runtime
│   ├── ui/             <- Packaged trusted approval UI
│   ├── chrome/         <- Chrome manifest and installation guide
│   ├── firefox/        <- Firefox manifest and installation guide
│   └── test/           <- Unit and real-browser tests
├── domagent-mcp/        <- Local/static operator admin, HTTP MCP, authenticated WSS
├── shared/             <- Signing protocol and semantic operations
├── deployment/         <- Independent service deployment examples
└── dist/               <- Generated browser packages (not committed)
```

Service, protocol, and shared runtime changes can affect both browsers. Browser
differences belong in the adapter and must be advertised as capabilities.

---

## Getting Started

### Prerequisites

- Node.js 22.13 or newer
- Chrome/Chromium or Firefox (candidate minimum versions need qualification)
- A git client

### Local setup

```bash
git clone git@github.com:vaishnavucv/domagent.git
cd domagent

# Install MCP server dependencies
cd domagent-mcp
npm ci --ignore-scripts
npm --prefix ../domagent-extension ci --ignore-scripts
npm --prefix ../domagent-extension/ui ci --ignore-scripts
npm test
npm run build
npm run check
```

### Code layout and build

Everything outside tests is strict TypeScript, typechecked by `tsc` and never
committed as build output (`dist/` is ignored):

| Project | tsconfig | Output |
| --- | --- | --- |
| Service (`domagent-mcp/*.ts` + `shared/`) | `domagent-mcp/tsconfig.json` (NodeNext) | `tsc` → `domagent-mcp/dist/` |
| Extension runtime (`domagent-extension/src/`) | `domagent-extension/tsconfig.json` (bundler, no emit) | esbuild → `dist/<browser>/background.js` |
| Window UI (`domagent-extension/ui/src/`, Preact TSX) | `domagent-extension/ui/tsconfig.json` (no emit) | esbuild → `ui/dist/ui.js` + `ui.css` |

Relative imports keep the `.js` extension; both `tsc` and esbuild resolve it to
the `.ts` source. UI components live in `ui/src/components/<Name>.tsx` with a
colocated `<Name>.css` that the component imports; global resets and shared
classes live in `ui/src/styles/global.css` and design tokens in
`ui/src/styles/themes/default.css`. Tests stay JavaScript and run against the
sources through `tsx`; the real-browser suite runs against the compiled service.
`npm run typecheck` checks all three projects; `npm run check` adds syntax
checks for the remaining JavaScript.

Then load the extension for the browser you want to work on:

- **Chrome:** `chrome://extensions` → Developer mode → Load unpacked → select `dist/chrome/`
- **Firefox:** `about:debugging` → Load Temporary Add-on → select `dist/firefox/manifest.json`

Do not load unbuilt source directories. Follow [the service guide](domagent-mcp/README.md)
to configure the HTTPS origin and agent entries before starting the service.
There is no insecure development login or unauthenticated localhost bridge.

See the browser-specific READMEs for full setup instructions:
- [Chrome README](domagent-extension/chrome/README.md)
- [Firefox README](domagent-extension/firefox/README.md)

---

## Reporting Bugs

Before opening an issue, please:

1. Check that the MCP server is running (`npm run build:service && npm start` in `domagent-mcp/`)
2. Check the browser extension console for errors (DevTools → Service Worker for Chrome, `about:debugging` → Inspect for Firefox)
3. Search existing issues to see if the bug has already been reported

### Opening a bug report

Open a GitHub issue and include:

- **Which component:** MCP server, Chrome extension, or Firefox extension
- **Browser and version** (e.g. Chrome 122, Firefox 123)
- **OS** (macOS, Windows, Linux)
- **Steps to reproduce** — be as specific as possible
- **Expected behaviour** — what you expected to happen
- **Actual behaviour** — what actually happened
- **Console output or error messages** — paste the full text, not a screenshot
- **Extension version** (shown on `chrome://extensions` or `about:addons`)

---

## Suggesting Features

Open a GitHub issue with the label `enhancement` and describe:

- The problem you are trying to solve
- The solution you have in mind
- Any alternative approaches you considered

Feature requests for **new MCP tools** should include:
- The tool name and description
- Input parameters
- Expected output
- Which browser(s) it should work on

---

## Submitting a Pull Request

### Before you start

For non-trivial changes, open an issue first to discuss the approach. This prevents wasted effort if the direction does not fit the project goals.

### Workflow

1. **Fork** the repository and clone your fork:

   ```bash
   git clone git@github.com:YOUR_USERNAME/domagent.git
   cd domagent
   ```

2. **Create a branch** from `main` with a descriptive name:

   ```bash
   git checkout -b fix/content-script-timeout
   # or
   git checkout -b feature/new-scroll-tool
   ```

3. **Make your changes.** Keep each commit focused on one thing (see commit guidelines below).

4. **Test your changes** (see [Testing Your Changes](#testing-your-changes)).

5. **Push your branch** and open a pull request against `main`:

   ```bash
   git push origin fix/content-script-timeout
   ```

6. In the pull request description, include:
   - What the change does and why
   - Which browser(s) it affects
   - How you tested it
   - Any screenshots or console output showing the fix/feature working

### Pull request checklist

- [ ] Changes work in the target browser(s)
- [ ] MCP server starts without errors after the change
- [ ] Extension loads without errors in the browser console
- [ ] Commit messages follow the guidelines below
- [ ] No `console.log` debug statements left in production code (use `console.error` for intentional logs, consistent with existing code)

---

## Commit Message Guidelines

Keep commit messages short, clear, and in plain English. No emoji. No periods at the end.

### Format

```
<type>: <short description>
```

### Types

| Type | When to use |
|------|-------------|
| `add` | Adding a new file or feature |
| `fix` | Fixing a bug |
| `update` | Updating existing code or content |
| `remove` | Removing code or files |
| `refactor` | Code restructuring with no behaviour change |
| `docs` | Documentation changes only |

### Examples

```
add scroll tool to MCP server and both extensions
fix content script timeout on slow-loading pages
update Firefox manifest to allow all_urls host permission
remove unused debug logging from background.js
docs: add Firefox installation guide to README
refactor: simplify tab resolution logic in Chrome background script
```

### What to avoid

- Vague messages: `fix bug`, `update stuff`, `changes`
- Emoji in commit messages
- Very long subject lines (keep under 72 characters)

---

## Code Style

There is no automated linter configured yet. Follow the patterns already present in the file you are editing.

### General rules

- **Indentation:** 2 spaces (no tabs)
- **Quotes:** Single quotes for strings in TypeScript and JavaScript
- **Semicolons:** Use semicolons, consistent with the secure-pairing runtime
- **Comments:** Use plain English; comment the *why*, not the *what*
- **Error handling:** Return explicit typed failures and metadata-only diagnostics;
  never log page contents, credentials, signatures, pairing codes or tokens

### Extension-specific

- All browser control runs in the app window (`app.html`); the background script only
  opens/focuses it and cleans up after it closes. Closing the window ends control.
- Session scope is native tab-group membership. The device key lives in
  extension-private IndexedDB and is non-extractable.
- Supplied scripts execute only with ordinary page authority. Web pages cannot reach
  the app window or its controller. Keep browser API calls in the adapter.

### MCP server (`domagent-mcp/`)

- `index.ts` configures and starts the service; `app.ts` owns HTTP routing (registration,
  token refresh, MCP); `hub.ts` owns authenticated WSS, inventory, sessions and commands.
- MCP tool registration and schemas live in `mcp.ts`; shared signing payloads and
  operation names live in `shared/protocol.ts`.
- Use the shared `Wire` type for untrusted or loosely shaped JSON (wire messages,
  tool arguments) and real interfaces for the service's own state.
- Do not reintroduce stdio authorization bypasses, raw CDP forwarding, direct
  credential fallback, or remote control approval.
- Proof transcripts bind the service origin and a fresh nonce. Every agent lookup is
  scoped to its own pairings; unknown and foreign IDs look the same. Human waits must
  not block heartbeat processing.
  Applications maintain their own integration skills and credential workflows;
  do not add application-specific configuration dependencies to DomAgent.

---

## Testing Your Changes

From the repository root, run `npm test`, `npm run build`, and `npm run check`.
For real-browser tests, follow [the browser test guide](domagent-extension/test/README.md):
Chrome and native Firefox run the full window, pairing and session flows.

Before deployment, also verify TLS, optional-host permission prompts,
protected navigation/subresources and restart behavior. MCP clients use
Streamable HTTP at `https://<server>/mcp/<agent-id>` with a bearer API key.

---

## Questions

If you are unsure about anything, open a GitHub issue and ask. There is no such thing as a dumb question.
