import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { OPERATIONS } from '../shared/protocol.js';
import { requireValue, failureCode, audit } from './errors.js';

const PARAMS = {
  navigate: { url: { type: 'string' } },
  click: { selector: { type: 'string' } },
  type_text: { selector: { type: 'string' }, text: { type: 'string' } },
  get_text: { selector: { type: 'string' } },
  evaluate_script: { script: { type: 'string', description: 'Ordinary page JavaScript; page-readable secrets may be returned.' } },
  get_screenshot: {}, get_interactive_elements: {}, clear_overlays: {},
};
const schema = properties => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
});
const tools = [
  { name: 'list_browser_targets', description: 'List only your eligible devices and active targets. Reconnect never restores control.', inputSchema: schema({}) },
  { name: 'request_browser_access', description: 'Request local owner approval for an eligible device. Returns immediately; do not repeatedly request.', inputSchema: schema({ device_id: { type: 'string' } }) },
  { name: 'request_handoff', description: 'End control and let the owner authenticate or resolve a browser prompt. Resume requires local approval.', inputSchema: schema({ target_id: { type: 'string' } }) },
  ...OPERATIONS.map(name => ({
    name, description: `${name} in your explicitly authorized dedicated tab. Never uses the user's current tab.`,
    inputSchema: schema({ target_id: { type: 'string' }, ...PARAMS[name] }),
  })),
];

export async function handleMcp(req, res, body, client, bridge) {
  const server = new Server({ name: 'domagent', version: '2.0.0-beta.2' },
    { capabilities: { tools: {} } });
  server.onerror = () => audit('mcp_protocol_failure', { client_id: client.id, code: 'PROTOCOL_FAILURE' });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      requireValue(bridge.store.client(client.id), 'NOT_AUTHORIZED', 403);
      const { name, arguments: args = {} } = request.params;
      const definition = tools.find(tool => tool.name === name);
      requireValue(definition && args && typeof args === 'object' && !Array.isArray(args),
        'INVALID_ARGUMENTS');
      const keys = Object.keys(definition.inputSchema.properties);
      requireValue(Object.keys(args).every(key => keys.includes(key)) &&
        keys.every(key => typeof args[key] === 'string'), 'INVALID_ARGUMENTS');
      let result;
      if (name === 'list_browser_targets') result = bridge.targets(client.id);
      else if (name === 'request_browser_access') result = bridge.requestAccess(client.id, args.device_id);
      else if (name === 'request_handoff') {
        const grant = bridge.grants.get(args.target_id);
        requireValue(grant?.client_id === client.id, 'NOT_AUTHORIZED', 403);
        bridge.endGrant(args.target_id, 'HANDOFF');
        result = { state: 'paused', requires_local_approval: true };
      } else {
        const { target_id, ...operationArgs } = args;
        result = await bridge.operate(client.id, target_id, name, operationArgs, extra.signal);
      }
      if (name === 'get_screenshot') {
        requireValue(result?.mimeType === 'image/png' && typeof result.data === 'string' &&
          result.data.length <= 8 * 1024 * 1024 && /^[A-Za-z0-9+/]*={0,2}$/.test(result.data) &&
          Buffer.from(result.data, 'base64').subarray(0, 8).equals(
            Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
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
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    await transport.handleRequest(req, res, body);
  } finally {
    await server.close();
  }
}
