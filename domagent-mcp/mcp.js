import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { HUMAN_WAIT_MS, OPERATIONS, OPERATION_SCHEMAS, validOperationArgs } from '../shared/protocol.js';
import { requireValue, failureCode, audit } from './errors.js';

const NOTES = {
  get_page_snapshot: 'Returns document-scoped element refs, accessible names, state and redacted field values. Top-level page and open shadow roots only; not a native accessibility tree.',
  click: 'Exactly one selector match or a snapshot ref/document. DOM input only, not native mouse events.',
  type_text: 'Replace an editable field value; dispatches DOM input/change events, not native keystrokes.',
  press_key: 'Dispatch DOM keydown/keyup to the target. Browser default actions and shortcuts are not synthesized; use click/type_text/select_option/set_checked for native control state.',
  wait_for_page: 'Wait for the currently shared page to finish navigation; returns loaded URL and document. Does not navigate.',
  evaluate_script: 'Ordinary page JavaScript; page-readable secrets may be returned.',
};
const description = { type: 'string', minLength: 1, maxLength: 500, description: 'Plain-language explanation shown to the browser user; must accurately describe the actual action.' };
const wait = { type: 'integer', minimum: 1, maximum: HUMAN_WAIT_MS / 1000, description: 'Human approval timeout in seconds; default 300, maximum 600. Client/proxy timeout must also allow 25 seconds of execution.' };
const schema = (properties, required = Object.keys(properties).filter(key => key !== 'wait_timeout_seconds')) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const tools = [
  { name: 'list_browser_targets', description: 'List your eligible browser devices and user-selected shared tabs. No unshared tab enumeration.', inputSchema: schema({}) },
  { name: 'request_browser_access', description: 'Ask the user to choose an existing/new tab. Waits for explicit sharing and returns its handle. Cancelled/expired waits create no sharing; do not repeat prompts.', inputSchema: schema({ device_id: { type: 'string' }, description, wait_timeout_seconds: wait }) },
  { name: 'request_handoff', description: 'Ask the user to sign in, solve a challenge or confirm a human action, and wait for Done. Keeps the tab shared; never reads credentials. Allow-all does not bypass this confirmation.', inputSchema: schema({ target_id: { type: 'string' }, description, wait_timeout_seconds: wait }) },
  ...OPERATIONS.map(name => ({
    name, description: `${name} in an explicitly user-shared tab. Waits for local action approval or allow-all. ${NOTES[name] || ''}`,
    inputSchema: {
      ...schema({ target_id: { type: 'string' }, ...OPERATION_SCHEMAS[name].properties, description, wait_timeout_seconds: wait },
        ['target_id', 'description', ...OPERATION_SCHEMAS[name].required]),
      ...(OPERATION_SCHEMAS[name].anyOf ? { anyOf: OPERATION_SCHEMAS[name].anyOf } : {}),
    },
  })),
];

export async function handleMcp(req, res, body, client, bridge) {
  const disconnected = new AbortController();
  const closed = () => { if (!res.writableFinished) disconnected.abort(); };
  res.on('close', closed);
  const server = new Server({ name: 'domagent', version: '4.1.0-beta.1' }, { capabilities: { tools: {} } });
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
        requireValue(typeof args.description === 'string' && args.description.trim() &&
          args.description.length <= 500, 'INVALID_ARGUMENTS');
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
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      const code = failureCode(error);
      audit('mcp_tool_failure', { client_id: client.id, code });
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: code }) }] };
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
