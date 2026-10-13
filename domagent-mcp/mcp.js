import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { HUMAN_WAIT_MS, OPERATIONS, OPERATION_SCHEMAS, TARGET_ID_SCHEMA, validOperationArgs,
  waitErrorDetails, validDescription, inspectionErrorDetails } from '../shared/protocol.js';
import { Fault, requireValue, failureCode, audit } from './errors.js';
import { compactResult, textResult } from '../shared/results.js';
import { RateLimiter } from './rate.js';
import { SERVICE_VERSION } from './version.js';

const NOTES = {
  get_page_snapshot: 'Preferred first read. Compact DOM summary: 4000 text characters, 50 elements and 16 KiB by default. Narrow with selector; check explicit truncation. Field values are redacted.',
  get_text: 'Read a focused selector/ref, not repeated body dumps. Default 4000 characters/16 KiB. Non-rendered content is not exposed. timeout_ms:0 is an immediate probe; bounded positive waits return WAIT_TIMEOUT with last_error.',
  get_interactive_elements: 'Prefer snapshots for actionable refs. Geometry is viewport-relative; in_viewport and disabled/readonly/editable matter. Hidden inputs are excluded. Explicit truncation.',
  click: 'Exactly one selector match or a snapshot ref/document. DOM input, not native mouse events.',
  inspect_element: 'Immediate read-only readiness diagnosis; no timeout_ms. Does not focus/scroll/mutate. State/reason, geometry, redacted flags and visible reveal_controls are suggestions, never automatic clicks. Associated visible labels may activate styled checkboxes. Hard output cap 4 KiB.',
  type_text: 'Replace an editable value; dispatch DOM input/change, not native keystrokes.',
  set_checked: 'Set a native checkbox/radio through the input or its exact associated visible label. Disabled inputs, hidden ancestors, obstructions and replacement labels fail.',
  press_key: 'DOM keydown/keyup only. Browser default actions/shortcuts are not synthesized.',
  navigate: 'Navigate the authorized tab to ordinary HTTP(S), including from blank/browser-owned navigation-only documents. Protected destinations are blocked. navigation_started is not proof of loaded content. Never navigate just to test an account.',
  wait_for_page: 'Wait for this tab to settle; returns loaded URL/document. Never replays navigation or POST.',
  evaluate_script: 'Only for focused data absent from snapshots. JavaScript expression/source, not a function body: document.title works; top-level return does not. Page CSP may refuse. Default 16 KiB/hard 64 KiB; oversized JSON fails, never partial success. Syntax/runtime/serialization/policy errors are distinct. Never return credentials or bypass CSP.',
};
const description = { type: 'string', minLength: 40, maxLength: 500,
  description: 'Useful explanation of the actual action. Minimum 40 Unicode code points after trimming; maximum 500 code points including surrounding whitespace. Length is not proof of consent.' };
const id = { type: 'string', format: 'uuid' };
const humanWait = { type: 'integer', minimum: 1, maximum: HUMAN_WAIT_MS / 1000, default: 300 };
const schema = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const target = { ...TARGET_ID_SCHEMA, description: 'Opaque authorized tab handle from list_workspace_tabs/create_workspace_tab. Shape alone never authorizes access.' };
export const tools = [
  { name: 'adopt_browser', description: 'Propose binding for an extension-generated five-minute pairing code using this authenticated client. User confirms locally. No browser private receipt, key or application credential is returned. Retries are idempotent; unavailable codes are non-enumerating.',
    inputSchema: schema({ pairing_code: { type: 'string', minLength: 8, maxLength: 16 } }) },
  { name: 'list_browser_workspaces', description: 'List only this client’s bound devices and workspace lifecycle. browser_info is self-reported diagnostic metadata, not attestation. Offline/paused/inactive do not imply permission. No unrelated tab enumeration.',
    inputSchema: schema({}) },
  { name: 'wait_for_workspace', description: 'Passively wait for the user to activate a workspace on this bound device. Immediate if active. Default 300 seconds/max 600. Does not open a sidebar, prompt or grant permission.',
    inputSchema: schema({ device_id: id, description, timeout_seconds: humanWait }, ['device_id','description']) },
  { name: 'list_workspace_tabs', description: 'Current active workspace tabs only, with explicit handles/title/URL, effective capabilities, page_state and execution_state. Removed/paused tabs have no current authority.',
    inputSchema: schema({ workspace_id: id }) },
  { name: 'create_workspace_tab', description: 'Create one fresh background tab in the active native workspace group. No existing-tab adoption or focus stealing. Eight-tab capacity, protected destinations and signed publication enforced. An uncertain result must never be automatically retried.',
    inputSchema: schema({ workspace_id: id, url: { type: 'string', minLength: 1, maxLength: 2048 }, description }, ['workspace_id','description']) },
  { name: 'request_handoff', description: 'Ask for human assistance via a generic global browser system notification and toolbar pending indicator. Wait for explicit Done/Cancel; click/dismissal is not Done. Only this target tab blocks. NOTIFICATION_UNAVAILABLE means notification API delivery failed, not that the user saw an alert.',
    inputSchema: schema({ target_id: target, description, wait_timeout_seconds: humanWait }, ['target_id','description']) },
  ...OPERATIONS.map(name => ({ name,
    description: `${name} in an explicitly grouped tab of an active leased workspace. No routine approval prompt. ${NOTES[name] || ''}`,
    inputSchema: { ...schema({ target_id: target, ...OPERATION_SCHEMAS[name].properties, description },
      ['target_id','description', ...OPERATION_SCHEMAS[name].required]),
      ...(OPERATION_SCHEMAS[name].anyOf ? { anyOf: OPERATION_SCHEMAS[name].anyOf } : {}) },
  })),
];
export const INSTRUCTIONS = 'DomAgent v5 requires matched v5 extensions. The actual native tab group plus an active, open-sidebar workspace defines authority, not foreground focus or an allowlist. Page tools require target_id and a useful 40–500 Unicode-code-point description; no ordinary human approval waits. Pause/End/sidebar closure/disconnect/lease loss stop unstarted work and leave tabs intact. Resume needs a fresh activation; cancelled work never replays. A running mutation may finish and cannot be undone; OUTCOME_UNKNOWN must not be retried automatically. ' +
  'Start with list_browser_workspaces and list_workspace_tabs. Browser versions are self-reported diagnostics, not attestation. Uninspectable documents may retain navigation-only authority; DOCUMENT_NOT_CONTROLLABLE does not itself end the workspace or handle. Use capabilities and fresh signed metadata; never replay POST, bypass native viewers/CSP, or inject into protected management pages. ' +
  'Snapshot/text output defaults to 16 KiB (64 KiB hard UTF-8 serialized MCP text-wrapper cap), 4000 characters/50 elements, with explicit truncation. inspect_element is 4 KiB. Arbitrary script/mutation receipts cannot be partially successful. Narrow reads; use snapshot refs bound to document. Human assistance uses a generic system notification; OS do-not-disturb can suppress a successfully created alert. Only explicit Done completes a handoff, and it blocks only its tab. No tool activates a sidebar, resumes Pause, regroups existing tabs or broadens access.';

export async function callTool(name, args, client, bridge, signal) {
  try {
    requireValue(bridge.store.client(client.id, client.tenant_id)?.credential_hash === client.credential_hash,
      'NOT_AUTHORIZED', 403);
    requireValue(args && typeof args === 'object' && !Array.isArray(args), 'INVALID_ARGUMENTS');
    const tool = tools.find(t => t.name === name);
    requireValue(tool, 'UNKNOWN_TOOL');
    requireValue(Object.keys(args).every(k => Object.hasOwn(tool.inputSchema.properties, k)) &&
      tool.inputSchema.required.every(k => Object.hasOwn(args, k)), 'INVALID_ARGUMENTS');
    if (Object.hasOwn(args, 'description')) requireValue(validDescription(args.description), 'INVALID_ARGUMENTS');
    let result;
    if (name === 'adopt_browser') {
      bridge.adoptionRates ||= new RateLimiter(bridge.now);
      bridge.adoptionRates.take(`adopt:${client.id}`, 20);
      bridge.adoptionRates.take('adopt:global', 200);
      result = bridge.store.adopt(client.id, client.tenant_id, args.pairing_code);
    } else if (name === 'list_browser_workspaces') result = bridge.listWorkspaces(client.id, client.tenant_id);
    else if (name === 'list_workspace_tabs') result = bridge.listTabs(client.id, args.workspace_id, client.tenant_id);
    else if (name === 'wait_for_workspace') {
      const seconds = args.timeout_seconds ?? 300;
      requireValue(Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 600, 'INVALID_ARGUMENTS');
      result = await bridge.waitWorkspace(client.id, args.device_id, args.description, seconds * 1000, signal, client.tenant_id);
    } else if (name === 'create_workspace_tab') {
      result = await bridge.createTab(client.id, args.workspace_id, args.url === undefined ? {} : { url: args.url },
        args.description, signal, client.tenant_id);
    } else {
      const { target_id, description: intent, wait_timeout_seconds, ...operationArgs } = args;
      const seconds = wait_timeout_seconds ?? 300;
      requireValue(name !== 'request_handoff' || Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 600, 'INVALID_ARGUMENTS');
      requireValue(validOperationArgs(name, operationArgs), 'INVALID_ARGUMENTS');
      result = await bridge.operate(client.id, target_id, name, operationArgs, signal, client.tenant_id, intent, seconds * 1000);
    }
    if (name === 'get_screenshot') {
      requireValue(result?.mimeType === 'image/png' && typeof result.data === 'string' &&
        result.data.length <= 8 * 1024 * 1024 && /^[A-Za-z0-9+/]*={0,2}$/.test(result.data) &&
        Buffer.from(result.data, 'base64').subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])), 'INVALID_RESULT');
      return { content: [{ type: 'image', data: result.data, mimeType: 'image/png' }] };
    }
    try { return textResult(compactResult(name, result, args)); }
    catch (error) {
      if (['RESULT_TOO_LARGE','INVALID_RESULT','INVALID_ARGUMENT'].includes(error.code)) throw new Fault(error.code);
      throw error;
    }
  } catch (error) {
    const code = failureCode(error);
    audit('mcp_tool_failure', { client_id: client.id, code, ...inspectionErrorDetails(error) });
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({
      error: code, ...waitErrorDetails(error), ...inspectionErrorDetails(error),
    }) }] };
  }
}
export async function handleMcp(req, res, body, client, bridge) {
  const disconnected = new AbortController();
  const closed = () => { if (!res.writableFinished) disconnected.abort(); };
  res.on('close', closed);
  const server = new Server({ name: 'domagent', version: SERVICE_VERSION }, {
    capabilities: { tools: {} }, instructions: INSTRUCTIONS,
  });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, (request, extra) => callTool(request.params.name,
    request.params.arguments || {}, client, bridge, AbortSignal.any([disconnected.signal, extra.signal])));
  const streaming = body?.method === 'tools/call' &&
    ['wait_for_workspace','request_handoff'].includes(body.params?.name);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: !streaming });
  const keepalive = streaming ? setInterval(() => {
    if (res.headersSent && !res.writableEnded && !res.destroyed &&
      String(res.getHeader('content-type')).startsWith('text/event-stream') && !res.writableNeedDrain) {
      res.write(': waiting for human interaction\n\n');
    }
  }, 15_000) : null;
  keepalive?.unref();
  await server.connect(transport);
  try { await transport.handleRequest(req, res, body); }
  finally {
    res.off('close', closed); if (keepalive) clearInterval(keepalive); await server.close();
  }
}
