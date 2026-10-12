import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { HUMAN_WAIT_MS, OPERATIONS, OPERATION_SCHEMAS, TARGET_ID_SCHEMA, validOperationArgs, waitErrorDetails,
  MIN_DESCRIPTION_LENGTH, validDescription, inspectionErrorDetails } from '../shared/protocol.js';
import { Fault, requireValue, failureCode, audit } from './errors.js';
import { compactResult, textResult } from '../shared/results.js';

const NOTES = {
  get_page_snapshot: 'Preferred first read. Returns a compact DOM summary, not a full tree: 4000 text characters and 50 elements by default, within 16 KiB. Use selector to focus a section. Read truncated/text_truncated/elements_truncated before assuming completeness. Field values are redacted.',
  get_text: 'Read a focused selector/ref, not repeated body dumps. Default 4000 characters within 16 KiB. Truncation is explicit. HTML head > title returns bounded title metadata; other non-rendered/script/style content is not exposed and has rendered:false/empty_reason. Use timeout_ms:0 to probe an absent selector immediately; positive waits return WAIT_TIMEOUT with last_error.',
  get_interactive_elements: 'Legacy geometry list; prefer get_page_snapshot for actionable refs. Default 50 elements within 16 KiB. Coordinates are viewport-relative (negative y is off-screen); use in_viewport and disabled/readonly/editable flags. A listed element is rendered, not necessarily on-screen or actionable. Hidden inputs are excluded. Check truncation.',
  click: 'Exactly one selector match or a snapshot ref/document. DOM input only, not native mouse events.',
  inspect_element: 'Read-only immediate readiness diagnosis after approval; no timeout_ms argument. Does not focus, scroll or mutate. Returns match count, state/reason, rect, viewport and redacted flags. hidden_by identifies a hiding element/ancestor; reveal_controls lists up to three visible, enabled controls whose aria-controls points to it. These are suggestions, never auto-clicked. activation describes an associated visible label for styled checkboxes/radios. Missing/ambiguous matches are states; invalid/stale refs are errors. Hard output cap 4 KiB.',
  type_text: 'Replace an editable field value; dispatches DOM input/change events, not native keystrokes.',
  set_checked: 'Set a native checkbox/radio. A visually hidden control may use its exact associated visible label. Approval binds both nodes; disabled inputs, hidden ancestors, unrelated obstructions and replacement labels still fail. Never infer that any hidden input can be toggled.',
  press_key: 'Dispatch DOM keydown/keyup to the target. Browser default actions and shortcuts are not synthesized; use click/type_text/select_option/set_checked for native control state.',
  navigate: 'Navigate only the already-shared tab to an ordinary HTTP(S) URL. Ordinary navigation retains sharing and does not inherently require handoff or a new grant. Protected/control-plane destinations are blocked. Result means navigation_started; use wait_for_page to observe the loaded page. Never navigate merely to test a user account.',
  wait_for_page: 'Wait for the currently shared page to finish navigation; returns loaded URL and document. Does not navigate.',
  evaluate_script: 'Use only for data absent from snapshots/targeted text. Browser capability support does not guarantee a page permits scripts. Evaluates a JavaScript expression/source, not a function body: document.title is valid, top-level return document.title; is invalid. Default output budget 16 KiB, hard maximum 64 KiB; oversized values fail rather than returning partial JSON. SCRIPT_SYNTAX_ERROR, SCRIPT_RUNTIME_ERROR, SCRIPT_SERIALIZATION_ERROR and SCRIPT_POLICY_BLOCKED are distinct. Never bypass page CSP or return credentials.',
};
const description = { type: 'string', minLength: MIN_DESCRIPTION_LENGTH, maxLength: 500,
  description: 'Plain-language explanation shown to the browser user; at least 40 characters after trimming, maximum 500. Accurately describe the actual action; length is not a security proof.' };
const wait = { type: 'integer', minimum: 1, maximum: HUMAN_WAIT_MS / 1000, description: 'Human approval timeout in seconds; default 300, maximum 600. Client/proxy timeout must also allow 25 seconds of execution.' };
const schema = (properties, required = Object.keys(properties).filter(key => key !== 'wait_timeout_seconds')) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const tools = [
  { name: 'list_browser_targets', description: 'List eligible devices and shared tabs only. browser_info reports the connected extension_version/browser_name/browser_version, or null when unavailable/offline. It is self-reported diagnostic metadata, not attestation or authority; Chrome browser_version may be null. Use connection_state (connected/offline), sharing_state (active/none) and pending_request_id (null when no prompt exists). Legacy state approval_required means connected but unshared, not that a prompt is showing. Capabilities list page operations, not every tool or guaranteed page policy. No unshared tab enumeration.', inputSchema: schema({}) },
  { name: 'request_browser_access', description: 'Ask the user to move their selected actual tab into a dedicated single-tab window. Native side-panel consent controls remain outside the webpage. Waits for explicit sharing and returns its tab/window-bound handle. Stop closes that tab and loses unsaved state. Cancelled/expired waits create no sharing; do not repeat prompts.', inputSchema: schema({ device_id: { type: 'string' }, description, wait_timeout_seconds: wait }) },
  { name: 'request_handoff', description: 'Ask the user to sign in, solve a challenge or confirm a human action, and wait for Done. Keeps the tab shared; never reads credentials. Allow-all does not bypass this confirmation.', inputSchema: schema({ target_id: TARGET_ID_SCHEMA, description, wait_timeout_seconds: wait }) },
  ...OPERATIONS.map(name => ({
    name, description: `${name} in an explicitly user-shared tab. Waits for local action approval or allow-all. ${NOTES[name] || ''}`,
    inputSchema: {
      ...schema({ target_id: TARGET_ID_SCHEMA, ...OPERATION_SCHEMAS[name].properties, description, wait_timeout_seconds: wait },
        ['target_id', 'description', ...OPERATION_SCHEMAS[name].required]),
      ...(OPERATION_SCHEMAS[name].anyOf ? { anyOf: OPERATION_SCHEMAS[name].anyOf } : {}),
    },
  })),
];

export async function handleMcp(req, res, body, client, bridge) {
  const disconnected = new AbortController();
  const closed = () => { if (!res.writableFinished) disconnected.abort(); };
  res.on('close', closed);
  const server = new Server({ name: 'domagent', version: '4.3.0-beta.3' }, {
    capabilities: { tools: {} },
    instructions: 'Descriptions for sharing, human assistance and page actions require at least 40 characters after trimming, maximum 500; explain useful intent rather than padding. Wire v4 requires matched extensions. Each handle owns one actual tab moved into a dedicated window with native side-panel approvals, not webpage consent controls. Stop/explicit Disconnect closes the controlled tab and loses unsaved state. Extra tabs/popups/moving the tab revoke access, never auto-adopt them. This reuses normal logins/cookies and opener relationships, not a sandbox. Allow all includes arbitrary page JavaScript; closing cannot undo sent requests/account changes or site background workers. Private history records commands and observed events, not every script effect, and is not exposed to MCP. ' +
      'Record browser_info versions from list_browser_targets before diagnosing browser failures; metadata is self-reported, not a trusted build attestation. Navigation inspection waits briefly for the actual document to settle and retries benign inspection only, never a mutation. PAGE_UNAVAILABLE after that bound ends sharing without replaying a POST or renewing authority. inspection_stage distinguishes tab_status, document_state, document_changed and document_injection; injection_reason distinguishes permission_denied, browser_restricted, frame_unavailable, helper_execution_failed, empty_result or unknown without raw browser error text. Do not infer JSON MIME type caused refusal or every POST fails. Record the retained response URL/content type only if actually observed, not inferred from form fields or click acknowledgement. Safe last_error/timeout_ms describes an exhausted inspection wait. TARGET_STALE after an approved document changes still needs fresh inspection and consent, not blind mutation retry. ' +
      'Start with get_page_snapshot, then read only relevant selectors/refs. Diagnose blocked targets with inspect_element: reveal collapsed UI if appropriate, refresh snapshot refs, act, and verify outcomes. Snapshots include viewport dimensions. Text results default to 16 KiB and cannot exceed 64 KiB including their serialized MCP content wrapper. Snapshots/text default to 4000 characters, lists to 50 elements. Check truncation; narrow selectors before raising limits. Screenshots are separate image requests. Use connection_state/sharing_state/pending_request_id and reuse intended active handles. Capabilities are page operations, not every MCP tool or guaranteed page-policy availability. evaluate_script takes source/expression (no top-level return); do not retry a possibly mutating failed script or bypass CSP. Ordinary navigation retains sharing; browser-refused/protected documents may end it. A click or intercepted FormData is not proof of a POST; verify the response and document ID. Do not install preventDefault listeners or replace user forms merely to inspect a payload. Local operation-derived summaries, not the agent explanation, identify the approved action. Never repeat uncertain mutations or automate credentials.',
  });
  server.onerror = () => audit('mcp_protocol_failure', { client_id: client.id, code: 'PROTOCOL_FAILURE' });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const current = bridge.store.client(client.id, client.tenant_id);
      requireValue(current && current.credential_hash === client.credential_hash, 'NOT_AUTHORIZED', 403);
      const { name, arguments: args = {} } = request.params;
      const definition = tools.find(tool => tool.name === name);
      requireValue(definition && args && typeof args === 'object' && !Array.isArray(args), 'INVALID_ARGUMENTS');
      requireValue(Object.keys(args).every(key => Object.hasOwn(definition.inputSchema.properties, key)) &&
        definition.inputSchema.required.every(key => Object.hasOwn(args, key)), 'INVALID_ARGUMENTS');
      const seconds = args.wait_timeout_seconds ?? 300;
      requireValue(Number.isInteger(seconds) && seconds >= 1 && seconds <= 600, 'INVALID_ARGUMENTS');
      let result;
      if (name === 'list_browser_targets') result = bridge.targets(client.id, client.tenant_id);
      else {
        requireValue(validDescription(args.description), 'INVALID_ARGUMENTS');
        if (name === 'request_browser_access') {
          result = await bridge.waitAccess(client.id, args.device_id, args.description, seconds * 1000,
            AbortSignal.any([extra.signal, disconnected.signal]), client.tenant_id);
        } else {
          const { target_id, description, wait_timeout_seconds: _wait, ...operationArgs } = args;
          requireValue(validOperationArgs(name, operationArgs), 'INVALID_ARGUMENTS');
          result = await bridge.operate(client.id, target_id, name, operationArgs,
            AbortSignal.any([extra.signal, disconnected.signal]), client.tenant_id, description, seconds * 1000);
        }
        const stillCurrent = bridge.store.client(client.id, client.tenant_id);
        requireValue(stillCurrent && stillCurrent.credential_hash === client.credential_hash, 'NOT_AUTHORIZED', 403);
      }
      if (name === 'get_screenshot') {
        requireValue(result?.mimeType === 'image/png' && typeof result.data === 'string' &&
          result.data.length <= 8 * 1024 * 1024 && /^[A-Za-z0-9+/]*={0,2}$/.test(result.data) &&
          Buffer.from(result.data, 'base64').subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
          'INVALID_RESULT');
        return { content: [{ type: 'image', data: result.data, mimeType: 'image/png' }] };
      }
      try {
        return textResult(compactResult(name, result, args));
      } catch (error) {
        if (['RESULT_TOO_LARGE', 'INVALID_RESULT'].includes(error.code)) throw new Fault(error.code);
        throw error;
      }
    } catch (error) {
      const code = failureCode(error);
      audit('mcp_tool_failure', { client_id: client.id, code, ...inspectionErrorDetails(error) });
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({
        error: code, ...waitErrorDetails(error), ...inspectionErrorDetails(error),
      }) }] };
    }
  });
  const streaming = body?.method === 'tools/call';
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, enableJsonResponse: !streaming,
  });
  const keepalive = streaming ? setInterval(() => {
    if (res.headersSent && !res.writableEnded && !res.destroyed &&
        String(res.getHeader('content-type')).startsWith('text/event-stream') && !res.writableNeedDrain) {
      res.write(': waiting for browser interaction\n\n');
    }
  }, 15_000) : null;
  keepalive?.unref();
  await server.connect(transport);
  try { await transport.handleRequest(req, res, body); } finally {
    res.off('close', closed);
    if (keepalive) clearInterval(keepalive);
    await server.close();
  }
}
