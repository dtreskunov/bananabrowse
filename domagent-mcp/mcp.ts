import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { HUMAN_WAIT_MS, OPERATIONS, OPERATION_SCHEMAS, TAB_ID_SCHEMA, HANDOFF_SCHEMA, DESCRIPTION_SCHEMA,
  BROWSER_ID_SCHEMA, SESSION_ID_SCHEMA, SESSION_TAB_LIMIT, schemaArgumentErrors, waitErrorDetails,
  inspectionErrorDetails, errorDetails, ARTIFACT_TEXT_MIME, DEFAULT_ARTIFACT_READ_BYTES, MAX_ARTIFACT_READ_BYTES,
  MAX_ARTIFACT_BYTES, type ArgumentError, type CodedError, type OperationSpec, type Wire } from '../shared/protocol.js';
import { agentDiagnostics } from '../shared/diagnostics.js';
import { Fault, requireValue, requireArguments, validationDetails, dispatchDetails, failureCode, audit } from './errors.js';
import { compactResult, textResult } from '../shared/results.js';
import { SERVICE_VERSION } from './version.js';
import type { Hub } from './hub.js';
import type { Agent } from './config.js';
import type { ArtifactMeta } from './artifacts.js';

export interface Tool { name: string; description: string; inputSchema: Wire }

const NOTES: Record<string, string> = {
  get_page_snapshot: 'Preferred first read. Compact DOM summary: 4000 text characters, 50 elements (interactive first; links include href) and 16 KiB by default. Narrow with selector; check explicit truncation. Field values are redacted. Refs are valid only for the latest snapshot of the returned document: after navigation or a new snapshot, use the new refs.',
  get_text: 'Read a focused selector/ref, not repeated body dumps. Default 4000 characters/16 KiB. timeout_ms:0 is an immediate probe; bounded positive waits return WAIT_TIMEOUT with last_error.',
  get_interactive_elements: 'Prefer snapshots for actionable refs. Geometry is viewport-relative. Hidden inputs are excluded. Explicit truncation.',
  click: 'Exactly one selector match or a snapshot ref/document. DOM input, not native mouse events. A click may only open a menu or change the page: take a new snapshot before the next ref-based action. For links, navigating to the snapshot href is often more reliable.',
  inspect_element: 'Immediate read-only readiness diagnosis; no timeout_ms. Does not focus/scroll/mutate. Hard output cap 4 KiB.',
  type_text: 'Replace an editable value; dispatch DOM input/change, not native keystrokes.',
  set_checked: 'Set a native checkbox/radio through the input or its exact associated visible label.',
  press_key: 'DOM keydown/keyup only. Browser default actions/shortcuts are not synthesized.',
  navigate: 'Navigate the tab to ordinary HTTP(S), including from blank/browser-owned documents. Protected destinations are blocked. navigation_started is not proof of loaded content.',
  wait_for_page: 'Wait for this tab to settle; optionally require a visible content_selector match. Never replays navigation or POST.',
  evaluate_script: 'For data absent from snapshots. The final expression statement is the result; top-level await/return work. MAIN (default) sees page globals; USER_SCRIPT requires native support. Page CSP may refuse. Inline results: default 16 KiB, hard 64 KiB. For bulk data use return_as:"artifact": the full result (up to ~8 MiB) is stored on the service and you get a handle with sha256 and download_url; fetch it with the same Authorization header used for MCP, or page through it with read_artifact.',
};
const description = { type: 'string', minLength: 40, maxLength: 500,
  description: 'What this action does and why, shown to the user in the DomAgent activity feed. 40–500 Unicode code points.' };
const humanWait = { type: 'integer', minimum: 1, maximum: HUMAN_WAIT_MS / 1000, default: 300 };
const schema = (properties: Wire, required: string[] = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const urlField = { type: 'string', minLength: 1, maxLength: 2048 };
const session = { ...SESSION_ID_SCHEMA, description: 'Session ID from request_session or list_sessions.' };
export const tools: Tool[] = [
  { name: 'pair_browser', description: 'Pair this agent with a browser using the 8-character code the user reads from their DomAgent window (for example K7MP-4QTX). Waits until the user approves or declines in that window. Codes expire after five minutes and are single use. Returns the browser_id.',
    inputSchema: schema({ code: { type: 'string', minLength: 8, maxLength: 16 }, timeout_seconds: humanWait }, ['code']) },
  { name: 'list_browsers', description: 'Browsers paired with this agent: browser_id, user-chosen name, whether its DomAgent window is open (online), last_seen and paired_at. Only online browsers can start sessions. A long-offline browser with the same name as a newer one is usually a reinstalled extension; remove it with unpair_browser. Browsers offline for 30 days are removed automatically.',
    inputSchema: schema({}) },
  { name: 'unpair_browser', description: 'Remove your own pairing with a browser, for example a stale one left behind by a reinstalled extension. Ends your sessions on it; other agents and the browser itself are unaffected. Pair again with pair_browser.',
    inputSchema: schema({ browser_id: BROWSER_ID_SCHEMA }) },
  { name: 'request_session', description: `Ask the user to open a browser session (a native tab group) for a task. The user sees your purpose and starting URLs and approves or declines in their DomAgent window. Fails immediately with BROWSER_OFFLINE if the browser's window is closed; try another browser from list_browsers. Up to ${SESSION_TAB_LIMIT} starting URLs (default: one blank tab). Returns the session and its tabs.`,
    inputSchema: schema({ browser_id: BROWSER_ID_SCHEMA,
      purpose: { type: 'string', minLength: 1, maxLength: 500, description: 'Why you need the browser, shown to the user. Plain text.' },
      urls: { type: 'array', maxItems: SESSION_TAB_LIMIT, items: urlField },
      title: { type: 'string', minLength: 1, maxLength: 80, description: 'Tab group title. Defaults to the agent name.' },
      timeout_seconds: humanWait }, ['browser_id', 'purpose']) },
  { name: 'list_sessions', description: 'Your sessions. state is attached (usable) or detached (browser window closed or reattach pending). Sessions survive up to 7 days while their tab group exists; one ends when the user closes or ungroups its tab group.',
    inputSchema: schema({}) },
  { name: 'end_session', description: 'End a session. By default its tabs are ungrouped and stay open. close_tabs: true instead asks the user to approve closing the session\'s tabs (system notification plus a prompt in the DomAgent window showing your description) and waits; ACTION_DECLINED means the user kept them and the session continues. Untracked tabs, such as protected sites, are only ungrouped. Closing needs extension 6.1.3 and an online browser.',
    inputSchema: schema({ session_id: session, close_tabs: { type: 'boolean', default: false },
      description: { ...description, description: `Required with close_tabs. ${description.description}` },
      timeout_seconds: humanWait }, ['session_id']) },
  { name: 'list_tabs', description: 'Tabs in an attached session with tab_id, title, URL, page_state, capabilities and execution_state. Every tab in the session tab group is in scope, including tabs the user drags in and tabs a site opens from a grouped tab.',
    inputSchema: schema({ session_id: session }) },
  { name: 'create_tab', description: `Open a new background tab in the session tab group (maximum ${SESSION_TAB_LIMIT}). Never steals focus. Do not retry automatically after an uncertain result.`,
    inputSchema: schema({ session_id: session, url: urlField, description }, ['session_id', 'description']) },
  { name: 'close_tab', description: 'Ask the user to close one tab in your session, for example a scratch tab you opened. The user gets a system notification and approves or keeps the tab in the DomAgent window; this waits for that decision (ACTION_DECLINED: the tab stays). After closing, pending commands on it fail with TAB_NOT_IN_SESSION. Closing the session\'s last tab ends the session (session_ended: true). Needs extension 6.1.3.',
    inputSchema: schema({ tab_id: TAB_ID_SCHEMA, description, timeout_seconds: humanWait }, ['tab_id', 'description']) },
  { name: 'report_progress', description: 'Post a short progress update to the user\'s DomAgent activity feed for this session.',
    inputSchema: schema({ session_id: session, message: { type: 'string', minLength: 1, maxLength: 500 } }) },
  { name: 'request_handoff', description: 'Ask the user to do something in a tab (log in, solve a CAPTCHA, review). Shows a system notification, flashes the tab group and waits for the user to click Done or Cancel in the DomAgent window. Only this tab waits; others can keep working.',
    inputSchema: schema({ tab_id: TAB_ID_SCHEMA, ...HANDOFF_SCHEMA.properties, timeout_seconds: humanWait }, ['tab_id', 'instructions']) },
  { name: 'list_artifacts', description: 'Artifacts you created with evaluate_script return_as:"artifact" that have not expired (24 hours) or been evicted (quota 64 MiB / 100 per agent, oldest first).',
    inputSchema: schema({}) },
  { name: 'read_artifact', description: `Read a byte range of one of your artifacts. Prefer downloading download_url with the MCP Authorization header (curl -fsS -H "Authorization: Bearer ..." URL -o file) so the data never passes through the conversation; use this only for previews or when HTTP is unavailable. Text is returned as UTF-8, binary as base64. Default ${DEFAULT_ARTIFACT_READ_BYTES / 1024} KiB, maximum ${MAX_ARTIFACT_READ_BYTES / 1024} KiB per call.`,
    inputSchema: schema({ artifact_id: { type: 'string', pattern: '^a[0-9A-Za-z_-]{22}(?![\\s\\S])' },
      offset: { type: 'integer', minimum: 0, maximum: MAX_ARTIFACT_BYTES, default: 0 },
      max_bytes: { type: 'integer', minimum: 256, maximum: MAX_ARTIFACT_READ_BYTES, default: DEFAULT_ARTIFACT_READ_BYTES } },
    ['artifact_id']) },
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
  'A stale duplicate (e.g. after an extension reinstall) can be removed with unpair_browser. ' +
  'Sessions reattach automatically when the window reopens. A session ends when the user closes or ungroups its tab group. ' +
  'Use report_progress for status, request_handoff for logins/CAPTCHAs/human review; never ask for passwords. ' +
  'OUTCOME_UNKNOWN means a mutation may have happened: inspect before retrying. Page tools require a 40–500 character description shown to the user. ' +
  'For bulk data use evaluate_script with return_as:"artifact" and download the artifact; never copy large results through the conversation.';

const HINTS: Record<string, string> = {
  RESULT_TOO_LARGE: 'Narrow the request (selector, max_elements, fewer fields). For evaluate_script, pass return_as:"artifact" to store the full result and download it instead of reading it inline.',
  ELEMENT_STALE: 'Refs are valid only for the latest get_page_snapshot of the same document. Take a new snapshot and use its ref and document.',
  TARGET_STALE: 'The page navigated or is still loading. Call wait_for_page, then take a new snapshot.',
  SCRIPT_SYNTAX_ERROR: 'Fix the script near line/column. The final expression statement is the result; top-level await and return are supported.',
  SCRIPT_RUNTIME_ERROR: 'The script threw in the page. Check line/column and the message; guard optional page globals.',
  INVALID_ARGUMENTS: 'See argument_errors. For unexpected_field, allowed lists the accepted fields.',
  HANDOFF_REQUIRED: 'This needs the person: call request_handoff with clear instructions (for example to log in), then continue.',
  OUTCOME_UNKNOWN: 'The action may have happened. Inspect the page before retrying.',
};
const STALE_HINTS: Record<string, string> = {
  document_changed: 'The page navigated since that snapshot (current_document differs). Take a new snapshot and use its refs.',
  ref_from_other_document: 'That ref was issued for an earlier document in this tab. Take a new snapshot of the current page and use its refs.',
  ref_superseded: 'A newer snapshot replaced that ref. Use refs from your latest snapshot.',
  element_detached: 'The element was removed from the page (for example a menu re-rendered). Take a new snapshot.',
};
function hint(code: string, details: Wire): string | undefined {
  if (code === 'CAPABILITY_UNAVAILABLE' && details.required_extension_version) {
    return `Requires DomAgent extension ${details.required_extension_version} or newer. Ask the user to update the extension.`;
  }
  return STALE_HINTS[details.stale_reason] || HINTS[code];
}

const MIME_BY_EXTENSION: Record<string, string> = { json: 'application/json', ndjson: 'application/x-ndjson', jsonl: 'application/x-ndjson',
  csv: 'text/csv', html: 'text/html', htm: 'text/html', md: 'text/markdown', txt: 'text/plain',
  gz: 'application/gzip', zip: 'application/zip', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
function shapeOf(value: unknown): Wire {
  if (Array.isArray(value)) {
    const first = value.find(item => item && typeof item === 'object' && !Array.isArray(item));
    return { type: 'array', length: value.length, ...(first ? { item_keys: Object.keys(first).slice(0, 40) } : {}) };
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    return { type: 'object', keys: keys.slice(0, 40), ...(keys.length > 40 ? { key_count: keys.length } : {}) };
  }
  return { type: value === null ? 'null' : typeof value };
}
function encodeArtifact(value: unknown, args: Wire): { data: Buffer; mime: string; shape?: Wire } {
  const encoding = args.artifact_encoding ?? 'utf8';
  const mimeOr = (fallback: string): string => args.artifact_mime || MIME_BY_EXTENSION[args.artifact_name?.split('.').pop()?.toLowerCase()] || fallback;
  if (typeof value !== 'string') {
    requireValue(encoding === 'utf8', 'INVALID_RESULT');
    return { data: Buffer.from(JSON.stringify(value), 'utf8'), mime: args.artifact_mime || 'application/json', shape: shapeOf(value) };
  }
  if (encoding === 'base64') {
    const compact = value.replace(/\s+/g, '');
    requireValue(/^[A-Za-z0-9+/]*={0,2}$/.test(compact) && compact.length % 4 !== 1, 'INVALID_RESULT');
    return { data: Buffer.from(compact, 'base64'), mime: mimeOr('application/octet-stream') };
  }
  const mime = mimeOr('text/plain');
  return { data: Buffer.from(value, 'utf8'), mime, shape: mime === 'application/json' ? jsonShape(value) : undefined };
}
function jsonShape(text: string): Wire | undefined {
  try { return shapeOf(JSON.parse(text)); } catch { return undefined; /* the page chose the bytes; shape is best effort */ }
}
function storeArtifact(hub: Hub, agentId: string, result: Wire | undefined, args: Wire): Wire {
  const { data, mime, shape } = encodeArtifact(result?.value ?? null, args);
  const meta = hub.artifacts.put(agentId, data, { mime, name: args.artifact_name || null, source: 'evaluate_script' });
  return { artifact: publicArtifact(hub, meta), ...(shape ? { shape } : {}),
    ...(ARTIFACT_TEXT_MIME.test(mime) ? { preview: data.subarray(0, 600).toString('utf8').replace(/\uFFFD+$/, '') } : {}),
    execution_world: result?.execution_world };
}
export function publicArtifact(hub: Hub, meta: ArtifactMeta): Wire {
  return { artifact_id: meta.id, name: meta.name, mime: meta.mime, bytes: meta.bytes, sha256: meta.sha256,
    expires_at: new Date(meta.expires_at).toISOString(),
    download_url: `${hub.config.origin}/mcp/${meta.agent_id}?artifact=${meta.id}` };
}
function readArtifact(hub: Hub, agentId: string, args: Wire): Wire {
  const { meta, data } = hub.artifacts.read(agentId, args.artifact_id);
  const offset = Math.min(args.offset ?? 0, data.length);
  let end = Math.min(data.length, offset + (args.max_bytes ?? DEFAULT_ARTIFACT_READ_BYTES));
  const text = ARTIFACT_TEXT_MIME.test(meta.mime);
  // Never split a UTF-8 sequence, so each page decodes cleanly and offsets stay exact.
  if (text) while (end < data.length && end > offset && (data[end]! & 0xc0) === 0x80) end--;
  const slice = data.subarray(offset, end);
  return { artifact_id: meta.id, offset, next_offset: end, total_bytes: data.length, eof: end >= data.length,
    encoding: text ? 'utf8' : 'base64', data: text ? slice.toString('utf8') : slice.toString('base64') };
}

function validateUrls(args: Wire): ArgumentError[] {
  if (!Object.hasOwn(args, 'urls')) return [];
  const urls = args.urls;
  if (!Array.isArray(urls)) return [{ field: 'urls', reason: 'expected_array' }];
  if (urls.length > SESSION_TAB_LIMIT) return [{ field: 'urls', reason: 'too_long', limits: { maximum: SESSION_TAB_LIMIT } }];
  return urls.flatMap((url, index) => schemaArgumentErrors({ properties: { url: urlField } } as Partial<OperationSpec> as OperationSpec, { url })
    .map(error => ({ ...error, field: `urls[${index}]` })));
}

export async function callTool(name: string, args: Wire, agent: Agent, hub: Hub, signal?: AbortSignal): Promise<Wire> {
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
      required: tool.inputSchema.required } as OperationSpec, scalar), ...(urls ? validateUrls(args) : [])]);
    let result: Wire | undefined;
    if (name === 'pair_browser') result = await hub.pairBrowser(agent.id, args.code, (args.timeout_seconds ?? 300) * 1000, signal);
    else if (name === 'list_browsers') result = hub.listBrowsers(agent.id);
    else if (name === 'unpair_browser') result = hub.unpairBrowser(agent.id, args.browser_id);
    else if (name === 'request_session') result = await hub.requestSession(agent.id, args, signal);
    else if (name === 'list_sessions') result = hub.listSessions(agent.id);
    else if (name === 'end_session') {
      if (args.close_tabs !== true) result = hub.endSessionByAgent(agent.id, args.session_id);
      else {
        requireArguments(Object.hasOwn(args, 'description') ? [] : [{ field: 'description', reason: 'required' }]);
        result = await hub.closeSessionTabs(agent.id, args.session_id, args.description,
          (args.timeout_seconds ?? 300) * 1000, signal);
      }
    } else if (name === 'close_tab') {
      result = await hub.closeTab(agent.id, args.tab_id, args.description, (args.timeout_seconds ?? 300) * 1000, signal);
    }
    else if (name === 'list_tabs') result = hub.listTabs(agent.id, args.session_id);
    else if (name === 'create_tab') {
      result = await hub.createTab(agent.id, args.session_id, args.url === undefined ? {} : { url: args.url },
        args.description, signal) as Wire | undefined;
    } else if (name === 'report_progress') result = hub.reportProgress(agent.id, args.session_id, args.message);
    else if (name === 'list_artifacts') result = hub.artifacts.list(agent.id).map(meta => publicArtifact(hub, meta));
    else if (name === 'read_artifact') result = readArtifact(hub, agent.id, args);
    else if (name === 'request_handoff') {
      const { tab_id, timeout_seconds, ...handoff } = args;
      result = await hub.operate(agent.id, tab_id, name, handoff, null, (timeout_seconds ?? 300) * 1000, signal) as Wire | undefined;
    } else {
      const { tab_id, description: intent, ...operationArgs } = args;
      result = await hub.operate(agent.id, tab_id, name, operationArgs, intent, 0, signal) as Wire | undefined;
    }
    if (name === 'get_screenshot') {
      requireValue(result?.mimeType === 'image/png' && typeof result.data === 'string' &&
        result.data.length <= 8 * 1024 * 1024 && /^[A-Za-z0-9+/]*={0,2}$/.test(result.data) &&
        Buffer.from(result.data, 'base64').subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'INVALID_RESULT');
      return { content: [{ type: 'image', data: result.data, mimeType: 'image/png' }] };
    }
    if (name === 'evaluate_script' && args.return_as === 'artifact') {
      return textResult(storeArtifact(hub, agent.id, result, args));
    }
    if (['read_artifact', 'list_artifacts'].includes(name)) return textResult(result);
    try { return textResult(compactResult(name, result, args)); }
    catch (error) {
      if (['RESULT_TOO_LARGE', 'INVALID_RESULT', 'INVALID_ARGUMENT'].includes((error as CodedError).code)) {
        throw Object.assign(new Fault((error as CodedError).code), errorDetails(error));
      }
      throw error;
    }
  } catch (error) {
    const code = failureCode(error);
    audit('mcp_tool_failure', { agent_id: agent.id, code, ...inspectionErrorDetails(error as Wire) });
    const diagnostics = agentDiagnostics((error as Wire | undefined)?.diagnostics);
    const details = errorDetails({ ...(error as Wire), code });
    const advice = hint(code, details);
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({
      error: code, ...validationDetails(error), ...waitErrorDetails(error as Wire), ...inspectionErrorDetails(error as Wire),
      ...dispatchDetails(error), ...details, ...(diagnostics ? { diagnostics } : {}), ...(advice ? { hint: advice } : {}),
    }) }] };
  }
}
export async function handleMcp(req: IncomingMessage, res: ServerResponse, body: Wire, agent: Agent, hub: Hub): Promise<void> {
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
    (['pair_browser', 'request_session', 'request_handoff', 'close_tab'].includes(body.params?.name) ||
      (body.params?.name === 'end_session' && body.params?.arguments?.close_tabs === true));
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
