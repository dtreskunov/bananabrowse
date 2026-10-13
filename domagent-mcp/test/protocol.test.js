import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OPERATION_SCHEMAS, HANDOFF_SCHEMA, DESCRIPTION_SCHEMA, schemaArgumentErrors,
  operationArgumentErrors, validOperationArgs, inspectionErrorDetails, waitErrorDetails,
  VERSION, POLICY_ID, authPayload, workspacePayload, pairingStartPayload, pairingStatusPayload,
  pairingConfirmPayload, pairingCancelPayload } from '../../shared/protocol.js';

test('beta7 protocol validates source UTF-16 boundary, not line count', () => {
  assert(validOperationArgs('evaluate_script', { script: 'a'.repeat(65536) }));
  assert(validOperationArgs('evaluate_script', { script: '😀'.repeat(32768) }));
  assert(validOperationArgs('evaluate_script', { script: Array(40).fill('document.title;').join('\n') }));
  assert.deepEqual(operationArgumentErrors('evaluate_script', { script: 'a'.repeat(65537) }), [{
    field: 'script', reason: 'too_long', limits: { maximum: 65536 }, actual_length: 65537, unit: 'utf16_code_units',
  }]);
});

test('beta7 optional world, content readiness and manual handoff schemas remain bounded', () => {
  assert.equal(OPERATION_SCHEMAS.evaluate_script.properties.world.default, 'MAIN');
  for (const world of ['MAIN', 'USER_SCRIPT']) assert(validOperationArgs('evaluate_script', { script: '1', world }));
  assert(!validOperationArgs('evaluate_script', { script: '1', world: 'ISOLATED' }));
  assert(!validOperationArgs('evaluate_script', { script: '1', world: null }));
  assert(validOperationArgs('wait_for_page', { content_selector: 'a'.repeat(4096) }));
  assert(!validOperationArgs('wait_for_page', { content_selector: 'a'.repeat(4097) }));
  assert(!validOperationArgs('wait_for_page', { content_selector: '' }));
  assert(validOperationArgs('request_handoff', { suggested_text: 'x'.repeat(8000) }));
  assert(!validOperationArgs('request_handoff', { suggested_text: 'x'.repeat(8001) }));
  assert(!validOperationArgs('request_handoff', { suggested_text: false }));
  assert.equal(HANDOFF_SCHEMA.properties.suggested_text.maxLength, 8000);
});

test('beta7 field errors distinguish type, required, bounds and target conflicts without values', () => {
  const invalid = [
    ['click', {}, 'selector', 'required_selector_or_ref_document'],
    ['click', { ref: 'e1' }, 'document', 'required_with_ref'],
    ['click', { selector: '#private', ref: 'e1', document: '12345678' }, 'selector', 'conflicts_with_ref'],
    ['get_text', { timeout_ms: 10001 }, 'timeout_ms', 'out_of_range'],
    ['get_text', { max_output_bytes: 1.5 }, 'max_output_bytes', 'expected_integer'],
    ['type_text', { selector: '#private', text: false }, 'text', 'expected_string'],
    ['set_checked', { selector: '#private', checked: 'private' }, 'checked', 'expected_boolean'],
    ['press_key', { selector: '#private', key: 'private' }, 'key', 'invalid_enum'],
    ['click', { ref: 'e1\n', document: '12345678' }, 'ref', 'invalid_format'],
    ['get_text', { private: 'private' }, 'arguments', 'unexpected_field'],
  ];
  for (const [name, args, field, reason] of invalid) {
    const errors = operationArgumentErrors(name, args);
    assert(errors.some(error => error.field === field && error.reason === reason));
    assert(!JSON.stringify(errors).includes('private'));
  }
  for (const args of [null, [], false, 'private']) {
    assert.deepEqual(operationArgumentErrors('get_text', args), [{ field: 'arguments', reason: 'expected_object' }]);
  }
  assert.deepEqual(operationArgumentErrors('evaluate_script', {}), [{ field: 'script', reason: 'required' }]);
});

test('beta7 descriptions count Unicode points after trimming minimum and raw maximum', () => {
  const spec = { properties: { description: DESCRIPTION_SCHEMA }, required: ['description'] };
  for (const char of ['a', '界', '😀']) {
    assert.deepEqual(schemaArgumentErrors(spec, { description: char.repeat(40) }), []);
    assert.deepEqual(schemaArgumentErrors(spec, { description: char.repeat(500) }), []);
    assert.deepEqual(schemaArgumentErrors(spec, { description: ` ${char.repeat(39)} ` }), [{
      field: 'description', reason: 'too_short', limits: { minimum: 40 },
      actual_length: 39, unit: 'unicode_code_points', measured_after_trim: true,
    }]);
    assert.equal(schemaArgumentErrors(spec, { description: ` ${char.repeat(499)} ` })[0].actual_length, 501);
  }
});

test('beta7 content readiness timeout projection preserves inspection and element causes', () => {
  for (const last_error of ['ELEMENT_NOT_FOUND', 'ELEMENT_NOT_VISIBLE', 'PAGE_UNAVAILABLE', 'TARGET_STALE']) {
    const error = { code: 'WAIT_TIMEOUT', inspection_stage: 'content_readiness', last_error, timeout_ms: 10000 };
    assert.deepEqual(inspectionErrorDetails(error), { inspection_stage: 'content_readiness', last_error, timeout_ms: 10000 });
    if (last_error.startsWith('ELEMENT_')) assert.deepEqual(waitErrorDetails(error), { last_error, timeout_ms: 10000 });
  }
  assert.deepEqual(inspectionErrorDetails({ code: 'WAIT_TIMEOUT', inspection_stage: 'content_readiness',
    last_error: 'private', timeout_ms: 10001 }), { inspection_stage: 'content_readiness' });
  assert.deepEqual(inspectionErrorDetails({ code: 'PAGE_UNAVAILABLE', inspection_stage: 'document_injection',
    injection_reason: 'permission_denied' }), { inspection_stage: 'document_injection', injection_reason: 'permission_denied' });
});

test('beta7 content readiness_stage preserves bounded waits and immediate zero-time probes', () => {
  for (const [code, timeout_ms] of [['WAIT_TIMEOUT', 10000], ['ELEMENT_NOT_FOUND', 0], ['ELEMENT_NOT_VISIBLE', 0]]) {
    const error = { code, readiness_stage: 'content_readiness', last_error: 'ELEMENT_NOT_FOUND', timeout_ms };
    assert.deepEqual(waitErrorDetails(error), { readiness_stage: 'content_readiness', last_error: 'ELEMENT_NOT_FOUND', timeout_ms });
  }
  for (const timeout_ms of [-1, 10001, 1.5, '0']) {
    assert.deepEqual(waitErrorDetails({ code: 'WAIT_TIMEOUT', readiness_stage: 'content_readiness',
      last_error: 'ELEMENT_NOT_FOUND', timeout_ms }), {});
  }
  assert.deepEqual(waitErrorDetails({ code: 'WAIT_TIMEOUT', last_error: 'ELEMENT_NOT_FOUND', timeout_ms: 0 }), {});
  assert.deepEqual(waitErrorDetails({ code: 'WAIT_TIMEOUT', readiness_stage: 'untrusted',
    last_error: 'ELEMENT_NOT_FOUND', timeout_ms: 1000 }), { last_error: 'ELEMENT_NOT_FOUND', timeout_ms: 1000 });
});

test('beta7 Run consent policy metadata does not change v5 identity or workspace signature bytes', () => {
  assert.equal(VERSION, 5);
  assert.equal(POLICY_ID, 'task-group-run-v1');
  const c = { origin: 'https://service.test', tenant_id: `t_${'A'.repeat(22)}`, epoch: 'epoch',
    connection_id: 'connection', nonce: 'nonce', key_id: 'key', client_id: 'client',
    workspace_id: 'workspace', activation_id: 'activation', group_id: 1, window_id: 2,
    state: 'active', revision: 3, lease_ms: 5000, request_id: 'request', public_key: {},
    extension_origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', pairing_code: 'ABCD1234',
    receipt: 'receipt', label: 'label', proposal_id: 'proposal',
    tabs: [{ target_id: 'target', tab_id: 7, title: 'Tab', url: 'https://page.test/',
      page_state: 'ready', capabilities: ['navigate', 'get_text'] }] };
  const expected = [
    [authPayload, ['domagent.v5', 'auth', c.origin, c.tenant_id, c.epoch, c.connection_id, c.nonce, c.key_id]],
    [workspacePayload, ['domagent.v5', 'workspace', c.origin, c.tenant_id, c.epoch, c.connection_id,
      c.client_id, c.workspace_id, c.activation_id, c.group_id, c.window_id, c.state, c.revision, c.lease_ms,
      [['target', 7, 'Tab', 'https://page.test/', 'ready', ['get_text', 'navigate']]]]],
    [pairingStartPayload, ['domagent.v5', 'pairing-start', c.origin, c.request_id, c.key_id,
      c.extension_origin, c.pairing_code, c.receipt, c.nonce, c.label]],
    [pairingStatusPayload, ['domagent.v5', 'pairing-status', c.origin, c.request_id, c.key_id, c.receipt]],
    [pairingConfirmPayload, ['domagent.v5', 'pairing-confirm', c.origin, c.request_id, c.proposal_id, c.key_id,
      c.receipt, c.tenant_id, c.client_id, c.nonce]],
    [pairingCancelPayload, ['domagent.v5', 'pairing-cancel', c.origin, c.request_id, c.key_id, c.receipt]],
  ];
  for (const [payload, bytes] of expected) {
    assert.equal(new TextDecoder().decode(payload(c)), JSON.stringify(bytes));
    assert.deepEqual(payload({ ...c, policy_id: 'grouped-workspace-v1' }),
      payload({ ...c, policy_id: POLICY_ID }));
  }
});
