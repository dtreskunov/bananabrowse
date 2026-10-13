import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { tools, callTool, INSTRUCTIONS } from '../mcp.js';
import { diagnosticDetails } from '../../shared/diagnostics.js';
import { fixture, appFixture, flush, responseMessage, tab, DESCRIPTION } from './helpers.js';

const decoded = result => JSON.parse(result.content[0].text);
async function execute(f, name, args, fields = { result: { ok: true } }) {
  const before = f.ws.sent.filter(message => message.type === 'command').length;
  const pending = callTool(name, { target_id: f.workspace.tabs[0].target_id, description: DESCRIPTION, ...args }, f.client, f.bridge);
  await flush();
  const commands = f.ws.sent.filter(message => message.type === 'command');
  assert.equal(commands.length, before + 1);
  const command = commands.at(-1);
  await responseMessage(f, command, 'command.ready');
  await responseMessage(f, command, 'result', fields);
  return { command, result: await pending };
}

test('beta7 service dispatches 40-line and exact 65536-unit scripts with explicit execution world', async () => {
  const f = await fixture();
  try {
    for (const script of [Array(40).fill('document.title;').join('\n'), '1'.repeat(65536), '😀'.repeat(32768)]) {
      const { command, result } = await execute(f, 'evaluate_script', { script });
      assert.equal(command.args.script, script);
      assert.equal(command.args.world, 'MAIN');
      assert(!result.isError);
    }
    const { command } = await execute(f, 'evaluate_script', { script: 'document.title', world: 'USER_SCRIPT' });
    assert.equal(command.args.world, 'USER_SCRIPT');
    assert.equal(tools.length, 21);
    assert.deepEqual(tools.find(tool => tool.name === 'evaluate_script').inputSchema.properties.world.enum, ['MAIN', 'USER_SCRIPT']);
  } finally { f.close(); }
});

test('beta7 malformed fields return private precise validation details and dispatch zero commands', async () => {
  const f = await fixture();
  try {
    const target_id = f.workspace.tabs[0].target_id;
    const cases = [
      ['evaluate_script', { script: 'S'.repeat(65537) }, 'script', 'too_long', 65537],
      ['evaluate_script', {}, 'script', 'required'],
      ['evaluate_script', { script: '' }, 'script', 'too_short', 0],
      ['evaluate_script', { script: false }, 'script', 'expected_string'],
      ['evaluate_script', { script: 'not logged', world: 'ISOLATED' }, 'world', 'invalid_enum'],
      ['evaluate_script', { script: 'not logged', max_output_bytes: 65537 }, 'max_output_bytes', 'out_of_range'],
      ['get_text', { description: 'short sensitive' }, 'description', 'too_short', 15],
      ['get_text', { description: '😀'.repeat(501) }, 'description', 'too_long', 501],
      ['get_text', { target_id: 'private unknown malformed' }, 'target_id', 'invalid_format'],
      ['get_text', { private: 'private untrusted value' }, 'arguments', 'unexpected_field'],
      ['get_text', { timeout_ms: null }, 'timeout_ms', 'expected_integer'],
      ['get_text', { max_text_chars: -1 }, 'max_text_chars', 'out_of_range'],
      ['wait_for_page', { content_selector: '' }, 'content_selector', 'too_short', 0],
      ['wait_for_page', { content_selector: 'a'.repeat(4097) }, 'content_selector', 'too_long', 4097],
      ['wait_for_page', { content_selector: false }, 'content_selector', 'expected_string'],
      ['request_handoff', { suggested_text: 'h'.repeat(8001) }, 'suggested_text', 'too_long', 8001],
      ['request_handoff', { suggested_text: null }, 'suggested_text', 'expected_string'],
      ['request_handoff', { wait_timeout_seconds: 601 }, 'wait_timeout_seconds', 'out_of_range'],
      ['click', {}, 'selector', 'required_selector_or_ref_document'],
      ['click', { selector: '#private', ref: 'e1', document: '12345678' }, 'selector', 'conflicts_with_ref'],
      ['click', { ref: 'e1' }, 'document', 'required_with_ref'],
      ['press_key', { selector: '#private', key: 'private' }, 'key', 'invalid_enum'],
      ['type_text', { selector: '#private', text: 123 }, 'text', 'expected_string'],
      ['set_checked', { selector: '#private', checked: 1 }, 'checked', 'expected_boolean'],
      ['select_option', { selector: '#private' }, 'value', 'required'],
      ['scroll', { delta_y: 1.5 }, 'delta_y', 'expected_integer'],
      ['create_workspace_tab', { workspace_id: f.workspace.workspace_id, url: 'p'.repeat(2049) }, 'url', 'too_long', 2049],
      ['list_workspace_tabs', { workspace_id: 'not private uuid' }, 'workspace_id', 'invalid_format'],
      ['adopt_browser', { pairing_code: 123 }, 'pairing_code', 'expected_string'],
      ['wait_for_workspace', { device_id: f.device.device_id, timeout_seconds: false }, 'timeout_seconds', 'expected_integer'],
    ];
    for (const [name, patch, field, reason, actual_length] of cases) {
      const pageTool = !['create_workspace_tab', 'list_workspace_tabs', 'adopt_browser', 'wait_for_workspace'].includes(name);
      let base = {};
      if (pageTool) base = { target_id, description: DESCRIPTION };
      else if (['create_workspace_tab', 'wait_for_workspace'].includes(name)) base = { description: DESCRIPTION };
      const result = await callTool(name, { ...base, ...patch }, f.client, f.bridge), error = decoded(result);
      assert.equal(result.isError, true, name);
      assert.equal(error.error, 'INVALID_ARGUMENTS', name);
      assert.equal(error.code, 'INVALID_ARGUMENTS');
      assert.equal(error.phase, 'validation');
      assert.equal(error.dispatch_status, 'not_dispatched');
      const detail = error.argument_errors.find(item => item.field === field && item.reason === reason);
      assert(detail, `${name}: ${field} ${reason}`);
      if (actual_length !== undefined) assert.equal(detail.actual_length, actual_length);
      assert(!JSON.stringify(error).includes('private'));
      assert(!JSON.stringify(error).includes(DESCRIPTION));
    }
    for (const args of [null, [], false, 'private']) {
      const result = await callTool('get_text', args, f.client, f.bridge);
      assert.equal(decoded(result).argument_errors[0].reason, 'expected_object');
    }
    assert.equal(f.ws.sent.filter(message => message.type === 'command').length, 0);
    assert.equal(f.bridge.calls.size, 0);
  } finally { f.close(); }
});

test('beta7 bridge independently validates suggested text and source before dispatch', async () => {
  const f = await fixture();
  try {
    for (const [operation, args, field] of [
      ['request_handoff', { suggested_text: 'x'.repeat(8001) }, 'suggested_text'],
      ['evaluate_script', { script: 'x'.repeat(65537) }, 'script'],
      ['wait_for_page', { content_selector: 'x'.repeat(4097) }, 'content_selector'],
    ]) {
      await assert.rejects(f.bridge.operate(f.client.id, f.workspace.tabs[0].target_id, operation,
        args, undefined, f.client.tenant_id, DESCRIPTION), error => {
        assert.equal(error.code, 'INVALID_ARGUMENTS');
        assert.equal(error.phase, 'validation');
        assert.equal(error.dispatch_status, 'not_dispatched');
        assert.equal(error.argument_errors[0].field, field);
        return true;
      });
    }
    assert.equal(f.ws.sent.filter(message => message.type === 'command').length, 0);
    const { command } = await execute(f, 'request_handoff', { suggested_text: 'manual copy only' });
    assert.deepEqual(command.args, { suggested_text: 'manual copy only' });
    const wait = await execute(f, 'wait_for_page', { content_selector: '.ready', timeout_ms: 1000 });
    assert.deepEqual(wait.command.args, { content_selector: '.ready', timeout_ms: 1000 });
  } finally { f.close(); }
});

test('beta7 browser diagnostics survive Fault and MCP projection without logging contents', async t => {
  const f = await fixture(), logs = [];
  const spy = t.mock.method(process.stdout, 'write', value => { logs.push(String(value)); return true; });
  try {
    const native = new TypeError('native private execution detail');
    const exception = new Error('private script failed', { cause: native });
    const wrapped = diagnosticDetails(exception, { layer: 'browser', phase: 'execution', execution_world: 'USER_SCRIPT' });
    wrapped.diagnostics.native = { Authorization: 'superSecretCredential', cookie: 'superSecretCredential',
      url: 'https://page.test/?key=superSecretCredential', exception: { name: 'NativeException', message: 'native detail' } };
    const { result } = await execute(f, 'evaluate_script', { script: 'privateSourceNotLogged',
      description: 'privateIntentNotLogged describing this browser operation.' }, {
      error: { code: 'SCRIPT_RUNTIME_ERROR', ...wrapped },
    });
    const error = decoded(result);
    assert.equal(result.isError, true);
    assert.equal(error.error, 'SCRIPT_RUNTIME_ERROR');
    assert.equal(error.diagnostics.stack, exception.stack);
    assert.equal(error.diagnostics.cause.stack, native.stack);
    assert.equal(error.diagnostics.execution_world, 'USER_SCRIPT');
    assert.equal(error.diagnostics.native.exception.message, 'native detail');
    assert(!JSON.stringify(error).includes('superSecretCredential'));
    const handoff = await execute(f, 'request_handoff', { suggested_text: 'privateHandoffNotLogged' },
      { error: { code: 'NOTIFICATION_UNAVAILABLE' } });
    assert.equal(decoded(handoff.result).error, 'NOTIFICATION_UNAVAILABLE');
    const recorded = logs.join('');
    for (const forbidden of ['native detail', 'native private execution detail', 'privateSourceNotLogged',
      'privateIntentNotLogged', 'privateHandoffNotLogged', 'superSecretCredential', 'diagnostics']) {
      assert(!recorded.includes(forbidden), forbidden);
    }
    assert(recorded.includes('mcp_tool_failure'));
  } finally { spy.mock.restore(); f.close(); }
});

test('beta7 diagnostics are bounded at browser-service boundary and retain readiness/input errors', async () => {
  const f = await fixture();
  try {
    const malformed = await execute(f, 'get_text', {}, { error: { code: 'PAGE_UNAVAILABLE',
      inspection_stage: 'document_injection', injection_reason: 'permission_denied',
      diagnostics: { name: 'NativeError', stack: 'frame\n'.repeat(10000) } } });
    const projected = decoded(malformed.result);
    assert.equal(projected.inspection_stage, 'document_injection');
    assert.equal(projected.injection_reason, 'permission_denied');
    assert.equal(projected.diagnostics.truncated, true);
    assert(projected.diagnostics.stack.endsWith('[truncated]'));
    for (const code of ['INPUT_REJECTED', 'INPUT_NOT_APPLIED']) {
      assert.equal(decoded((await execute(f, 'type_text', { selector: '#editor', text: 'new text' },
        { error: { code } })).result).error, code);
    }
    const readiness = await execute(f, 'wait_for_page', { content_selector: '.ready' }, {
      error: { code: 'WAIT_TIMEOUT', inspection_stage: 'content_readiness', last_error: 'ELEMENT_NOT_VISIBLE', timeout_ms: 10000 },
    });
    assert.deepEqual(decoded(readiness.result), {
      error: 'WAIT_TIMEOUT', inspection_stage: 'content_readiness', last_error: 'ELEMENT_NOT_VISIBLE', timeout_ms: 10000,
    });
    for (const [code, timeout_ms] of [['WAIT_TIMEOUT', 10000], ['ELEMENT_NOT_FOUND', 0]]) {
      const probe = await execute(f, 'wait_for_page', { content_selector: '.ready', timeout_ms }, {
        error: { code, readiness_stage: 'content_readiness', last_error: 'ELEMENT_NOT_FOUND', timeout_ms },
      });
      assert.deepEqual(decoded(probe.result), { error: code, readiness_stage: 'content_readiness',
        last_error: 'ELEMENT_NOT_FOUND', timeout_ms });
    }
  } finally { f.close(); }
});

test('beta7 valid unknown and foreign handles remain indistinguishable and dispatch nothing', async () => {
  const f = await fixture();
  try {
    const other = f.store.client(f.store.createClient('Other').id);
    const foreign = decoded(await callTool('get_text', { target_id: f.workspace.tabs[0].target_id,
      description: DESCRIPTION }, other, f.bridge));
    const unknown = decoded(await callTool('get_text', { target_id: randomUUID(), description: DESCRIPTION }, f.client, f.bridge));
    assert.deepEqual(foreign, { error: 'NOT_AUTHORIZED' });
    assert.deepEqual(unknown, foreign);
    assert.equal(f.ws.sent.filter(message => message.type === 'command').length, 0);
  } finally { f.close(); }
});

test('beta7 create accepts signed blank-to-ready publications and renews the existing workspace lease', async () => {
  const f = await fixture();
  try {
    const existing = f.workspace.tabs[0];
    const pending = callTool('create_workspace_tab', { workspace_id: f.workspace.workspace_id,
      url: 'https://page.test/new', description: DESCRIPTION }, f.client, f.bridge);
    await flush();
    const command = f.ws.sent.find(message => message.type === 'command');
    assert.equal(command.operation, 'create_workspace_tab');
    await responseMessage(f, command, 'command.ready');
    f.clock.value += 4000;
    const fresh = tab(2, { url: 'about:blank', page_state: 'navigation_only', capabilities: ['navigate'] });
    await f.sync({ revision: 2, tabs: [existing, fresh] });
    assert.equal(f.bridge.listTabs(f.client.id, f.workspace.workspace_id, f.client.tenant_id).length, 2);
    f.clock.value += 1000;
    const ready = tab(2, { target_id: fresh.target_id, url: 'https://page.test/new' });
    await f.sync({ revision: 3, tabs: [existing, ready] });
    await responseMessage(f, command, 'result', { result: { target_id: fresh.target_id } });
    const result = await pending;
    assert(!result.isError);
    assert.equal(decoded(result).target_id, fresh.target_id);
    assert.equal(decoded(result).page_state, 'ready');
    assert.equal(f.session.authenticated, true);
    assert.equal(f.bridge.connections.get(f.device.device_id), f.session);
    assert.equal(f.bridge.workspaces.get(f.workspace.workspace_id).state, 'active');
    assert.equal(f.bridge.calls.size, 0);
  } finally { f.close(); }
});

test('beta7 public metadata advertises Run policy with wire5 and existing credential compatibility', async () => {
  const f = await appFixture();
  try {
    const metadata = await (await fetch(`${f.base}/.well-known/domagent`)).json();
    assert.equal(metadata.protocol_version, 5);
    assert.equal(metadata.policy_id, 'task-group-run-v1');
    assert(INSTRUCTIONS.includes('Existing 5.0.4 pairing and credentials remain valid'));
    assert(INSTRUCTIONS.includes('Update the extension to 5.0.5'));
    assert(INSTRUCTIONS.includes('independent of sidebar visibility'));
  } finally { await f.close(); }
});

test('beta7 advanced arguments require an updated peer before dispatch without invalidating existing identities', async () => {
  for (const extension_version of [undefined, '5.0.4', '5.0.4.99', '5.0', '4.99.99']) {
    const browserInfo = extension_version === undefined ? undefined :
      { extension_version, browser_name: 'chrome', browser_version: '150.0' };
    const f = await fixture({ browserInfo });
    try {
      const originalTarget = f.workspace.tabs[0].target_id, originalWorkspace = f.workspace.workspace_id;
      const originalCredential = f.client.credential_hash, originalDevice = f.device.device_id;
      for (const [name, args] of [
        ['evaluate_script', { script: 'document.title', world: 'MAIN' }],
        ['evaluate_script', { script: 'document.title', world: 'USER_SCRIPT' }],
        ['wait_for_page', { content_selector: '.ready' }],
        ['request_handoff', { suggested_text: 'manual copy only' }],
        ['request_handoff', { suggested_text: '' }],
      ]) {
        const result = await callTool(name, { target_id: originalTarget, description: DESCRIPTION, ...args }, f.client, f.bridge);
        assert.equal(result.isError, true);
        assert.deepEqual(decoded(result), { error: 'UPGRADE_REQUIRED' });
      }
      assert.equal(f.ws.sent.filter(message => message.type === 'command').length, 0);
      assert.equal(f.bridge.calls.size, 0);
      assert.equal(f.bridge.targets.get(originalTarget).queued, 0);
      assert.equal(f.bridge.targets.get(originalTarget).queuedControllers.size, 0);
      assert.equal(f.bridge.workspaces.get(originalWorkspace).state, 'active');
      assert.equal(f.session.authenticated, true);
      assert.equal(f.store.client(f.client.id).credential_hash, originalCredential);
      assert.equal(f.store.linked(f.client.id, originalDevice, f.client.tenant_id), true);
      assert.equal(f.bridge.listTabs(f.client.id, originalWorkspace, f.client.tenant_id)[0].target_id, originalTarget);
      const ordinary = await execute(f, 'evaluate_script', { script: 'document.title' });
      assert(!ordinary.result.isError);
      assert.deepEqual(ordinary.command.args, { script: 'document.title' });
      for (const name of ['wait_for_page', 'request_handoff']) {
        const legacy = await execute(f, name, {});
        assert(!legacy.result.isError);
        assert.deepEqual(legacy.command.args, {});
      }
    } finally { f.close(); }
  }
});

test('beta7 peer version is not authorization and advanced requests preserve target non-enumeration', async () => {
  const f = await fixture({ browserInfo: { extension_version: '5.0.4', browser_name: 'chrome', browser_version: '150.0' } });
  try {
    const targetId = f.workspace.tabs[0].target_id;
    const foreign = f.store.client(f.store.createClient('Foreign').id);
    const args = { script: 'document.title', world: 'MAIN', description: DESCRIPTION };
    const known = await callTool('evaluate_script', { target_id: targetId, ...args }, foreign, f.bridge);
    const unknown = await callTool('evaluate_script', { target_id: randomUUID(), ...args }, f.client, f.bridge);
    assert.equal(known.isError, true);
    assert.equal(unknown.isError, true);
    assert.deepEqual(decoded(known), { error: 'NOT_AUTHORIZED' });
    assert.deepEqual(decoded(unknown), decoded(known));
    assert.equal(f.ws.sent.filter(message => message.type === 'command').length, 0);
    f.session.browser_info.extension_version = '99.0.0';
    const spoofed = await callTool('evaluate_script', { target_id: targetId, ...args }, foreign, f.bridge);
    assert.deepEqual(decoded(spoofed), decoded(known));
    await f.sync({ revision: 2, state: 'paused', tabs: [] });
    const paused = await callTool('evaluate_script', { target_id: targetId, ...args }, f.client, f.bridge);
    assert.deepEqual(decoded(paused), { error: 'WORKSPACE_PAUSED' });
  } finally { f.close(); }
});

test('beta7 current and newer peers receive all advanced arguments unchanged', async () => {
  for (const extension_version of ['5.0.5', '5.0.5.0', '5.0.6', '5.1', '6.0.0']) {
    const f = await fixture({ browserInfo: { extension_version, browser_name: 'chrome', browser_version: '150.0' } });
    try {
      for (const [name, args] of [
        ['evaluate_script', { script: 'document.title', world: 'USER_SCRIPT' }],
        ['wait_for_page', { content_selector: '.ready' }],
        ['request_handoff', { suggested_text: 'manual copy only' }],
      ]) {
        const result = await execute(f, name, args);
        assert(!result.result.isError);
        assert.deepEqual(result.command.args, args);
      }
    } finally { f.close(); }
  }
});

test('beta7 compiler not-dispatched receipt survives Fault and MCP projection without inference', async () => {
  const f = await fixture();
  try {
    const diagnostics = diagnosticDetails(new SyntaxError('Unexpected top-level return'), {
      layer: 'browser', phase: 'validation', execution_world: 'MAIN',
    }).diagnostics;
    const compiler = await execute(f, 'evaluate_script', { script: 'return 42;' }, {
      error: { code: 'SCRIPT_SYNTAX_ERROR', dispatch_status: 'not_dispatched', diagnostics },
    });
    assert.equal(compiler.result.isError, true);
    assert.deepEqual(decoded(compiler.result), {
      error: 'SCRIPT_SYNTAX_ERROR', dispatch_status: 'not_dispatched', diagnostics,
    });
    for (const [code, fields] of [
      ['SCRIPT_SYNTAX_ERROR', { diagnostics }],
      ['SCRIPT_RUNTIME_ERROR', {}],
      ['OUTCOME_UNKNOWN', {}],
      ['SCRIPT_SYNTAX_ERROR', { dispatch_status: 'untrusted private value', diagnostics }],
      ['SCRIPT_SYNTAX_ERROR', { dispatch_status: { status: 'not_dispatched' }, diagnostics }],
    ]) {
      const result = await execute(f, 'evaluate_script', { script: 'document.title' }, { error: { code, ...fields } });
      assert.equal(result.result.isError, true);
      assert.equal(decoded(result.result).error, code);
      assert(!Object.hasOwn(decoded(result.result), 'dispatch_status'));
    }
  } finally { f.close(); }
});
