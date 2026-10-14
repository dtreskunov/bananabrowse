import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { HUMAN_WAIT_MS, OPERATIONS, OPERATION_SCHEMAS, TAB_ID_SCHEMA, HANDOFF_SCHEMA, DESCRIPTION_SCHEMA,
  BROWSER_ID_SCHEMA, SESSION_ID_SCHEMA, SESSION_TAB_LIMIT, schemaArgumentErrors, waitErrorDetails,
  inspectionErrorDetails } from '../shared/protocol.js';
import { sanitizeDiagnostics } from '../shared/diagnostics.js';
import { Fault, requireValue, requireArguments, validationDetails, dispatchDetails, failureCode, audit } from './errors.js';
import { compactResult, textResult } from '../shared/results.js';
import { SERVICE_VERSION } from './version.js';

const NOTES = {
  get_page_snapshot: 'Preferred first read. Compact DOM summary: 4000 text characters, 50 elements and 16 KiB by default. Narrow with selector; check explicit truncation. Field values are redacted.',
  get_text: 'Read a focused selector/ref, not repeated body dumps. Default 4000 characters/16 KiB. timeout_ms:0 is an immediate probe; bounded positive waits return WAIT_TIMEOUT with last_error.',
  get_interactive_elements: 'Prefer snapshots for actionable refs. Geometry is viewport-relative. Hidden inputs are excluded. Explicit truncation.',
  click: 'Exactly one selector match or a snapshot ref/document. DOM input, not native mouse events.',
  inspect_element: 'Immediate read-only readiness diagnosis; no timeout_ms. Does not focus/scroll/mutate. Hard output cap 4 KiB.',
  type_text: 'Replace an editable value; dispatch DOM input/change, not native keystrokes.',
  set_checked: 'Set a native checkbox/radio through the input or its exact associated visible label.',
  press_key: 'DOM keydown/keyup only. Browser default actions/shortcuts are not synthesized.',
  navigate: 'Navigate the tab to ordinary HTTP(S), including from blank/browser-owned documents. Protected destinations are blocked. navigation_started is not proof of loaded content.',
  wait_for_page: 'Wait for this tab to settle; optionally require a visible content_selector match. Never replays navigation or POST.',
  evaluate_script: 'Only for focused data absent from snapshots. JavaScript expression/source, not a function body: document.title works; top-level return does not. MAIN is the default world; USER_SCRIPT requires native support. Page CSP may refuse. Default 16 KiB/hard 64 KiB.',
};
const description = { type: 'string', minLength: 40, maxLength: 500,
  description: 'What this action does and why, shown to the user in the DomAgent activity feed. 40–500 Unicode code points.' };
const humanWait = { type: 'integer', minimum: 1, maximum: HUMAN_WAIT_MS / 1000, default: 300 };
const schema = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const urlField = { type: 'string', minLength: 1, maxLength: 2048 };
const session = { ...SESSION_ID_SCHEMA, description: 'Session ID from request_session or list_sessions.' };
export const tools = [
  { name: 'pair_browser', description: 'Pair this agent with a browser using the 8-character code the user reads from their DomAgent window (for example K7MP-4QTX). Waits until the user approves or declines in that window. Codes expire after five minutes and are single use. Returns the browser_id.',
    inputSchema: schema({ code: { type: 'string', minLength: 8, maxLength: 16 }, timeout_seconds: humanWait }, ['code']) },
  { name: 'list_browsers', description: 'Browsers paired with this agent: browser_id, user-chosen name and whether its DomAgent window is open (online). Only online browsers can start sessions.',
    inputSchema: schema({}) },
  { name: 'request_session', description: `Ask the user to open a browser session (a native tab group) for a task. The user sees your purpose and starting URLs and approves or declines in their DomAgent window. Fails immediately with BROWSER_OFFLINE if the browser's window is closed; try another browser from list_browsers. Up to ${SESSION_TAB_LIMIT} starting URLs (default: one blank tab). Returns the session and its tabs.`,
    inputSchema: schema({ browser_id: BROWSER_ID_SCHEMA,
      purpose: { type: 'string', minLength: 1, maxLength: 500, description: 'Why you need the browser, shown to the user. Plain text.' },
      urls: { type: 'array', maxItems: SESSION_TAB_LIMIT, items: urlField },
      title: { type: 'string', minLength: 1, maxLength: 80, description: 'Tab group title. Defaults to the agent name.' },
      timeout_seconds: humanWait }, ['browser_id', 'purpose']) },
  { name: 'list_sessions', description: 'Your sessions. state is attached (usable) or detached (browser window closed or reattach pending). Sessions survive up to 7 days while their tab group exists; one ends when the user closes or ungroups its tab group.',
    inputSchema: schema({}) },
  { name: 'end_session', description: 'End a session. Its tabs are ungrouped and stay open.',
    inputSchema: schema({ session_id: session }) },
  { name: 'list_tabs', description: 'Tabs in an attached session with tab_id, title, URL, page_state, capabilities and execution_state. Every tab in the session tab group is in scope, including tabs the user drags in and tabs a site opens from a grouped tab.',
    inputSchema: schema({ session_id: session }) },
  { name: 'create_tab', description: `Open a new background tab in the session tab group (maximum ${SESSION_TAB_LIMIT}). Never steals focus. Do not retry automatically after an uncertain result.`,
    inputSchema: schema({ session_id: session, url: urlField, description }, ['session_id', 'description']) },
  { name: 'report_progress', description: 'Post a short progress update to the user\'s DomAgent activity feed for this session.',
    inputSchema: schema({ session_id: session, message: { type: 'string', minLength: 1, maxLength: 500 } }) },
  { name: 'request_handoff', description: 'Ask the user to do something in a tab (log in, solve a CAPTCHA, review). Shows a system notification, flashes the tab group and waits for the user to click Done or Cancel in the DomAgent window. Only this tab waits; others can keep working.',
    inputSchema: schema({ tab_id: TAB_ID_SCHEMA, ...HANDOFF_SCHEMA.properties, timeout_seconds: humanWait }, ['tab_id', 'instructions']) },
  ...OPERATIONS.map(name => ({ name,
    description: `${name} in a session tab. ${NOTES[name] || ''}`.trim(),
    inputSchema: { ...schema({ tab_id: TAB_ID_SCHEMA, ...OPERATION_SCHEMAS[name].properties, description },
      ['tab_id', 'description', ...OPERATION_SCHEMAS[name].required]),
      ...(OPERATION_SCHEMAS[name].anyOf ? { anyOf: OPERATION_SCHEMAS[name].anyOf } : {}) },
  })),
];
export const INSTRUCTIONS = 'DomAgent v6 lets you work in the user\'s real browser inside tab groups they approve. ' +
  'First use: ask the user to open the DomAgent window (toolbar button), click Pair an agent and tell you the code; call pair_browser. ' +
  'Then: list_browsers -> request_session(browser_id, purpose, urls) -> the user approves -> use tab_ids with page tools. ' +
  'If the browser is offline the user has closed the DomAgent window; ask them to reopen it or choose another browser. ' +
  'Sessions reattach automatically when the window reopens. A session ends when the user closes or ungroups its tab group. ' +
  'Use report_progress for status, request_handoff for logins/CAPTCHAs/human review; never ask for passwords. ' +
  'OUTCOME_UNKNOWN means a mutation may have happened: inspect before retrying. Page tools require a 40–500 character description shown to the user.';

function validateUrls(args) {
  if (!Object.hasOwn(args, 'urls')) return [];
  const urls = args.urls;
  if (!Array.isArray(urls)) return [{ field: 'urls', reason: 'expected_array' }];
  if (urls.length > SESSION_TAB_LIMIT) return [{ field: 'urls', reason: 'too_long', limits: { maximum: SESSION_TAB_LIMIT } }];
  return urls.flatMap((url, index) => schemaArgumentErrors({ properties: { url: urlField } }, { url })
    .map(error => ({ ...error, field: `urls[${index}]` })));
}

export async function callTool(name, args, agent, hub, signal) {
  try {
    requireValue(hub.agents.get(agent.id) === agent, 'NOT_AUTHORIZED', 401);
    const tool = tools.find(t => t.name === name);
    requireValue(tool, 'UNKNOWN_TOOL');
    const properties = { ...tool.inputSchema.properties };
    if (Object.hasOwn(properties, 'description')) properties.description = DESCRIPTION_SCHEMA;
    if (name === 'request_handoff') properties.instructions = HANDOFF_SCHEMA.properties.instructions;
    const urls = Object.hasOwn(properties, 'urls');
    delete properties.urls;
    const scalar = urls ? Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'urls')) : args;
    requireArguments([...schemaArgumentErrors({ ...tool.inputSchema, properties,
      required: tool.inputSchema.required }, scalar), ...(urls ? validateUrls(args) : [])]);
    let result;
    if (name === 'pair_browser') result = await hub.pairBrowser(agent.id, args.code, (args.timeout_seconds ?? 300) * 1000, signal);
    else if (name === 'list_browsers') result = hub.listBrowsers(agent.id);
    else if (name === 'request_session') result = await hub.requestSession(agent.id, args, signal);
    else if (name === 'list_sessions') result = hub.listSessions(agent.id);
    else if (name === 'end_session') result = hub.endSessionByAgent(agent.id, args.session_id);
    else if (name === 'list_tabs') result = hub.listTabs(agent.id, args.session_id);
    else if (name === 'create_tab') {
      result = await hub.createTab(agent.id, args.session_id, args.url === undefined ? {} : { url: args.url },
        args.description, signal);
    } else if (name === 'report_progress') result = hub.reportProgress(agent.id, args.session_id, args.message);
    else if (name === 'request_handoff') {
      const { tab_id, timeout_seconds, ...handoff } = args;
      result = await hub.operate(agent.id, tab_id, name, handoff, null, (timeout_seconds ?? 300) * 1000, signal);
    } else {
      const { tab_id, description: intent, ...operationArgs } = args;
      result = await hub.operate(agent.id, tab_id, name, operationArgs, intent, 0, signal);
    }
    if (name === 'get_screenshot') {
      requireValue(result?.mimeType === 'image/png' && typeof result.data === 'string' &&
        result.data.length <= 8 * 1024 * 1024 && /^[A-Za-z0-9+/]*={0,2}$/.test(result.data) &&
        Buffer.from(result.data, 'base64').subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'INVALID_RESULT');
      return { content: [{ type: 'image', data: result.data, mimeType: 'image/png' }] };
    }
    try { return textResult(compactResult(name, result, args)); }
    catch (error) {
      if (['RESULT_TOO_LARGE', 'INVALID_RESULT', 'INVALID_ARGUMENT'].includes(error.code)) {
        throw new Fault(error.code);
      }
      throw error;
    }
  } catch (error) {
    const code = failureCode(error);
    audit('mcp_tool_failure', { agent_id: agent.id, code, ...inspectionErrorDetails(error) });
    const diagnostics = sanitizeDiagnostics(error?.diagnostics);
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({
      error: code, ...validationDetails(error), ...waitErrorDetails(error), ...inspectionErrorDetails(error),
      ...dispatchDetails(error), ...(diagnostics ? { diagnostics } : {}),
    }) }] };
  }
}
export async function handleMcp(req, res, body, agent, hub) {
  const disconnected = new AbortController();
  const closed = () => { if (!res.writableFinished) disconnected.abort(); };
  res.on('close', closed);
  const server = new Server({ name: 'domagent', version: SERVICE_VERSION }, {
    capabilities: { tools: {} }, instructions: INSTRUCTIONS,
  });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, (request, extra) => callTool(request.params.name,
    request.params.arguments || {}, agent, hub, AbortSignal.any([disconnected.signal, extra.signal])));
  const streaming = body?.method === 'tools/call' &&
    ['pair_browser', 'request_session', 'request_handoff'].includes(body.params?.name);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: !streaming });
  const keepalive = streaming ? setInterval(() => {
    if (res.headersSent && !res.writableEnded && !res.destroyed &&
      String(res.getHeader('content-type')).startsWith('text/event-stream') && !res.writableNeedDrain) {
      res.write(': waiting for the user\n\n');
    }
  }, 15_000) : null;
  keepalive?.unref();
  await server.connect(transport);
  try { await transport.handleRequest(req, res, body); }
  finally {
    res.off('close', closed); if (keepalive) clearInterval(keepalive); await server.close();
  }
}
